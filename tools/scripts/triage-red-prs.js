#!/usr/bin/env node
/**
 * Triage of the open pull requests with red CI.
 *
 * Goes through every open pull request that has a failed check on its last
 * commit or a pending change request, and decides one of three things for it:
 *
 * - the two test runners (Sourcify SDK and Rust SDK) disagree, one green and
 *   one red: comment and tag the maintainers, once per head commit, so they
 *   compare the two runners before the author rewrites the descriptor. The
 *   pull request is not closed while the disagreement is open;
 * - both runners are red: the descriptor most likely has a bug. Comment and
 *   tag the author and the maintainers, once per head commit, and treat the
 *   runners like any other red check for the close rule;
 * - a check other than the two runners is red for more than N weeks and the
 *   author did nothing for more than N weeks: close it with a comment;
 * - a reviewer requested changes and the author did nothing for more than
 *   N weeks: close it with a comment.
 *
 * Activity of the author = commits by the author, comments and reviews by the
 * author. Comments of bots and merges pushed by maintainers (Update branch) do
 * not count. A pull request whose author acted after the last comment or
 * review of a maintainer is never closed: the ball is with the maintainer.
 * A check is red since the run that made it red: a merge of master that turns
 * a green check red starts the clock again, a merge that keeps a red check
 * red does not. The checks of the optional AI Review workflow and of the label
 * bots are ignored, a cancelled run is not red, and a rerun that passed
 * supersedes an earlier failure of the same check on the same commit.
 *
 * Usage:
 *   node tools/scripts/triage-red-prs.js [options]
 *
 * Options:
 *   --apply               Post the comments and close the pull requests.
 *                         Without it the script only prints what it would do.
 *   --weeks <n>           Inactivity threshold in weeks (default 4)
 *   --repo <owner/name>   Repository (default ethereum/clear-signing-erc7730-registry)
 *   --maintainers <a,b>   GitHub logins to tag on a runner failure
 *   --pr <n>              Only this pull request (repeatable)
 *   --verbose             Print the full text of every comment the script would post
 *
 * Needs the GitHub CLI (gh) logged in with write access to the repository.
 */

const { execFileSync } = require('child_process');

const DEFAULT_REPO = 'ethereum/clear-signing-erc7730-registry';
const DEFAULT_WEEKS = 4;
const DEFAULT_MAINTAINERS = ['kuzdogan', 'manuelwedler', 'marcocastignoli', 'austintgriffith'];
const SCRIPT_URL = `https://github.com/${DEFAULT_REPO}/blob/master/tools/scripts/triage-red-prs.js`;
const MARKER = 'triage-red-prs:runner-failure';

const SOURCIFY_RUNNER = /^(Typescript - Sourcify SDK tests|Sourcify tests for )/;
const RUST_RUNNER = /^(Rust - llbartekll SDK tests|Rust tests for )/;
const IGNORED_WORKFLOWS = new Set(['AI Review', 'PR Labels', '🏷️ pull request labels', '✨ pull request setup', 'Descriptor Tests Queued', 'Clear Signing Tests Started']);
const IGNORED_JOBS = new Set(['Notify fork PR']);
const RED_STATES = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);
// The names of the registry checks before #3046, so a check that was red
// under its old name on the previous head commit is not counted as newly red.
const RENAMED_CHECKS = new Map([
  ['🔎 validate descriptors', 'Descriptors pass the ERC-7730 linter'],
  ['🔎 validate JSON schemas', 'JSON files match their schema'],
  ['🔎 validate index', 'No index entry is overwritten'],
  ['🔎 validate file names', 'File names follow the registry layout'],
  ['🔎 validate attested descriptors', 'Attested descriptors are unchanged'],
]);

function parseArgs(argv) {
  const opts = { apply: false, weeks: DEFAULT_WEEKS, repo: DEFAULT_REPO, maintainers: DEFAULT_MAINTAINERS, prs: [], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--weeks') opts.weeks = Number(next());
    else if (arg === '--repo') opts.repo = next();
    else if (arg === '--maintainers') opts.maintainers = next().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
    else if (arg === '--pr') opts.prs.push(Number(next()));
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.weeks) || opts.weeks < 1) throw new Error('--weeks must be a positive integer');
  return opts;
}

function printUsage() {
  const header = require('fs').readFileSync(__filename, 'utf8').split('\n');
  const end = header.findIndex((line) => line.startsWith(' */'));
  console.log(header.slice(1, end).map((line) => line.replace(/^ \* ?/, '')).join('\n'));
}

function gh(args, { input } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'] });
}

function ghJson(args, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(gh(args));
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(`retrying gh ${args.slice(0, 2).join(' ')} (${attempt}/${attempts})`);
      sleep(5000);
    }
  }
}

function listOpenPrs(repo) {
  return ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json',
    'number,title,url,author,createdAt,isDraft,reviewDecision,headRefOid,statusCheckRollup']);
}

// One entry per check name: a rerun that passed supersedes a failed run.
function dedupeChecks(list) {
  const byName = new Map();
  for (const check of list) {
    if (IGNORED_WORKFLOWS.has(check.workflow) || IGNORED_JOBS.has(check.name)) continue;
    const seen = byName.get(check.name);
    if (!seen || seen.state !== 'SUCCESS') byName.set(check.name, check);
  }
  return [...byName.values()];
}

function classifyChecks(pr) {
  const checks = dedupeChecks((pr.statusCheckRollup || []).map((c) => ({
    name: c.name || c.context || '',
    workflow: c.workflowName || '',
    state: c.conclusion || c.state || '',
    completedAt: c.completedAt || c.startedAt || null,
  })));
  const sourcify = checks.filter((c) => SOURCIFY_RUNNER.test(c.name));
  const rust = checks.filter((c) => RUST_RUNNER.test(c.name));
  const others = checks.filter((c) => !SOURCIFY_RUNNER.test(c.name) && !RUST_RUNNER.test(c.name));
  const isRed = (c) => RED_STATES.has(c.state);
  const verdict = (list) => (list.some(isRed) ? 'red' : list.length && list.every((c) => c.state === 'SUCCESS') ? 'green' : 'not run');
  const runners = { 'Sourcify SDK': verdict(sourcify), 'Rust SDK': verdict(rust) };
  const verdicts = Object.values(runners);
  const bothRed = verdicts.every((v) => v === 'red');
  return {
    red: checks.filter(isRed),
    // Two red runners count like any other red check: the descriptor is broken.
    otherRed: [...others.filter(isRed), ...(bothRed ? [...sourcify, ...rust].filter(isRed) : [])],
    runners,
    runnersDisagree: verdicts.includes('red') && verdicts.includes('green'),
    runnersBothRed: bothRed,
  };
}

function fetchTimeline(repo, number) {
  const view = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'commits,comments,reviews']);
  const reviewComments = ghJson(['api', '--paginate', `repos/${repo}/pulls/${number}/comments`]);
  return { ...view, reviewComments };
}

// The checks of the commit before the head commit, by name. The first parent
// of the head is the previous head, also when the head is a merge of master.
function fetchParentChecks(repo, sha) {
  const commit = ghJson(['api', `repos/${repo}/commits/${sha}`]);
  const parent = commit.parents && commit.parents[0];
  if (!parent) return new Map();
  const runs = ghJson(['api', '--paginate', `repos/${repo}/commits/${parent.sha}/check-runs?per_page=100`]);
  const checks = dedupeChecks((runs.check_runs || []).map((c) => ({
    name: RENAMED_CHECKS.get(c.name) || c.name, workflow: '', state: (c.conclusion || '').toUpperCase(), completedAt: c.completed_at,
  })));
  return new Map(checks.map((c) => [c.name, c]));
}

// When the same check was already red on the previous head, it is red since
// that run; otherwise since the run on the head commit.
function redSince(check, parentChecks) {
  const before = parentChecks.get(check.name);
  const since = before && RED_STATES.has(before.state) ? before.completedAt : check.completedAt;
  return since ? new Date(since) : null;
}

function isBot(login) {
  return !login || /\[bot\]$/.test(login) || login === 'github-actions' || login.startsWith('app/');
}

function isTriageComment(body) {
  return (body || '').includes(MARKER);
}

function latest(dates) {
  return dates.length ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))) : null;
}

function earliest(dates) {
  return dates.length ? new Date(Math.min(...dates.map((d) => new Date(d).getTime()))) : null;
}

function lastAuthorActivity(pr, timeline) {
  const author = pr.author.login;
  const dates = [pr.createdAt];
  for (const c of timeline.commits) if ((c.authors || []).some((a) => a.login === author)) dates.push(c.committedDate);
  for (const c of timeline.comments) if (c.author && c.author.login === author) dates.push(c.createdAt);
  for (const r of timeline.reviews) if (r.author && r.author.login === author) dates.push(r.submittedAt);
  for (const c of timeline.reviewComments) if (c.user && c.user.login === author) dates.push(c.created_at);
  return latest(dates);
}

// Comments and reviews of humans other than the author, the triage comments excluded.
function lastMaintainerActivity(pr, timeline) {
  const author = pr.author.login;
  const human = (login) => login && login !== author && !isBot(login);
  const dates = [];
  for (const c of timeline.comments) if (c.author && human(c.author.login) && !isTriageComment(c.body)) dates.push(c.createdAt);
  for (const r of timeline.reviews) if (r.author && human(r.author.login)) dates.push(r.submittedAt);
  for (const c of timeline.reviewComments) if (c.user && human(c.user.login)) dates.push(c.created_at);
  return latest(dates);
}

function lastChangesRequested(timeline) {
  const dates = timeline.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => new Date(r.submittedAt).getTime());
  return dates.length ? new Date(Math.max(...dates)) : null;
}

function hasRunnerComment(timeline, sha) {
  return timeline.comments.some((c) => (c.body || '').includes(`${MARKER}:${sha}`));
}

function weeksSince(date, now) {
  return (now - date) / (7 * 24 * 3600 * 1000);
}

function day(date) {
  return date.toISOString().slice(0, 10);
}

function decide(pr, checks, timeline, parentChecks, opts, now) {
  const activity = lastAuthorActivity(pr, timeline);
  const maintainerActivity = lastMaintainerActivity(pr, timeline);
  const changesAt = lastChangesRequested(timeline);
  const idle = weeksSince(activity, now);
  const waitingForMaintainer = maintainerActivity && activity > maintainerActivity;
  const reasons = [];
  const otherRed = checks.otherRed.map((c) => ({ ...c, since: redSince(c, parentChecks) }));
  const redFor = otherRed.length ? Math.min(...otherRed.map((c) => (c.since ? weeksSince(c.since, now) : Infinity))) : 0;
  if (idle > opts.weeks && otherRed.length && redFor > opts.weeks) {
    reasons.push({
      text: `the author made no change since ${day(activity)}, more than ${opts.weeks} weeks ago, and these checks are red:`,
      items: otherRed.map((c) => `${c.name}${c.since ? ` (since ${day(c.since)})` : ''}`),
    });
  }
  if (idle > opts.weeks && pr.reviewDecision === 'CHANGES_REQUESTED' && changesAt && weeksSince(changesAt, now) > opts.weeks) {
    reasons.push({ text: `a reviewer requested changes on ${day(changesAt)} and the author made no change since ${day(activity)}, more than ${opts.weeks} weeks ago` });
  }
  const info = { activity, maintainerActivity, changesAt, idle, otherRed };
  const reported = hasRunnerComment(timeline, pr.headRefOid);
  if (checks.runnersDisagree) {
    if (reported) return { action: 'skip', note: 'runner disagreement reported, waiting for a maintainer', ...info };
    return { action: 'comment', comment: 'runners-disagree', ...info };
  }
  if (reasons.length && waitingForMaintainer) return { action: 'skip', note: `waiting for a maintainer since ${day(activity)}`, ...info };
  if (reasons.length) return { action: 'close', reasons, ...info };
  if (idle > opts.weeks && otherRed.length) return { action: 'skip', note: `red only since ${day(earliest(otherRed.map((c) => c.since).filter(Boolean)))}`, ...info };
  if (checks.runnersBothRed && !reported) return { action: 'comment', comment: 'runners-both-red', ...info };
  return { action: 'skip', note: checks.runnersBothRed ? 'both runners red, already reported for this commit' : 'not stale', ...info };
}

function closeComment(pr, decision, opts) {
  const lines = [
    'This pull request is closed by the stale pull request triage, because:',
    '',
    ...decision.reasons.flatMap((r) => [`- ${r.text}`, ...(r.items || []).map((item) => `  - ${item}`)]),
    '',
    `We close pull requests that stay red or idle for more than ${opts.weeks} weeks to keep the review queue short. ` +
      'This is not a judgement of the descriptor. When you are ready, push the fix and reopen this pull request, or open a new one. ' +
      'Thank you for the contribution.',
    '',
    `*Posted by [triage-red-prs.js](${SCRIPT_URL}).*`,
  ];
  return lines.join('\n');
}

function runnersSentence(runners) {
  return Object.entries(runners).map(([name, verdict]) => `the ${name} runner is ${verdict}`).join(' and ');
}

function runnerComment(pr, checks, decision, opts) {
  const tags = opts.maintainers.map((m) => `@${m}`).join(' ');
  const advice = decision.comment === 'runners-disagree'
    ? `A disagreement between the runners is often a runner bug, not a descriptor bug, so a maintainer should compare the two before the author changes the descriptor. ${tags} please take a look.`
    : `The tests fail on both implementations, so the descriptor or its tests most likely have a bug. @${pr.author.login} please look at the test results. ${tags} for your information.`;
  return [
    `<!-- ${MARKER}:${pr.headRefOid} -->`,
    `On commit ${pr.headRefOid.slice(0, 7)} ${runnersSentence(checks.runners)}.`,
    '',
    advice,
    '',
    `*Posted by [triage-red-prs.js](${SCRIPT_URL}).*`,
  ].join('\n');
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  let prs = listOpenPrs(opts.repo);
  if (opts.prs.length) prs = prs.filter((pr) => opts.prs.includes(pr.number));
  prs.sort((a, b) => a.number - b.number);

  const plan = [];
  for (const pr of prs) {
    const checks = classifyChecks(pr);
    if (!checks.red.length && pr.reviewDecision !== 'CHANGES_REQUESTED') continue;
    const timeline = fetchTimeline(opts.repo, pr.number);
    const parentChecks = checks.otherRed.length ? fetchParentChecks(opts.repo, pr.headRefOid) : new Map();
    const decision = decide(pr, checks, timeline, parentChecks, opts, now);
    plan.push({ pr, checks, decision });
  }

  console.log(`${prs.length} open pull requests, ${plan.length} with red checks or requested changes, threshold ${opts.weeks} weeks\n`);
  for (const { pr, checks, decision } of plan) {
    const flags = pr.isDraft ? ' (draft)' : '';
    console.log(`#${pr.number}${flags} ${pr.author.login}: ${pr.title}`);
    console.log(`  opened ${day(new Date(pr.createdAt))}, last author activity ${day(decision.activity)}, last maintainer activity ${decision.maintainerActivity ? day(decision.maintainerActivity) : 'none'}, review ${pr.reviewDecision || 'none'}`);
    const since = new Map(decision.otherRed.map((c) => [c.name, c.since]));
    console.log(`  red: ${checks.red.map((c) => (since.get(c.name) ? `${c.name} (since ${day(since.get(c.name))})` : c.name)).join('; ') || 'none'}`);
    if (decision.action === 'close') console.log(`  CLOSE: ${decision.reasons.map((r) => r.text + (r.items ? ' ' + r.items.join('; ') : '')).join(' | ')}`);
    else if (decision.action === 'comment') console.log(`  COMMENT (${decision.comment}): ${runnersSentence(checks.runners)}`);
    else console.log(`  skip: ${decision.note}`);
    if (opts.verbose && decision.action !== 'skip') {
      const body = decision.action === 'close' ? closeComment(pr, decision, opts) : runnerComment(pr, checks, decision, opts);
      console.log(body.split('\n').map((line) => `    | ${line}`).join('\n'));
    }
    console.log('');
  }

  const actions = plan.filter(({ decision }) => decision.action !== 'skip');
  const closes = actions.filter(({ decision }) => decision.action === 'close').length;
  console.log(`${closes} to close, ${actions.length - closes} to comment`);
  if (!opts.apply) {
    if (actions.length) console.log('Dry run. Add --apply to post the comments and close the pull requests.');
    return;
  }

  for (const { pr, checks, decision } of actions) {
    if (decision.action === 'close') {
      console.log(`closing #${pr.number}`);
      gh(['pr', 'close', String(pr.number), '--repo', opts.repo, '--comment', closeComment(pr, decision, opts)]);
    } else {
      console.log(`commenting on #${pr.number}`);
      gh(['pr', 'comment', String(pr.number), '--repo', opts.repo, '--body-file', '-'], { input: runnerComment(pr, checks, decision, opts) });
    }
    sleep(3000);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
