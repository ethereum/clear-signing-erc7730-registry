#!/usr/bin/env node
/**
 * The gate of the AI review: decides whether a pull request gets a review
 * and, when it does, downloads the test report bundle the review reads: the
 * JSON that the Descriptor Test Results workflow publishes on the
 * test-reports branch for every test run (see .github/test-runner-docs/bundle.md).
 *
 * Usage: node ai-review-gate.js --pr <number> --out <dir>
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, and when set GITHUB_OUTPUT
 * and GITHUB_STEP_SUMMARY. Options: --wait-minutes (default 45), the time
 * given to Registry Checks and Descriptor Tests to finish and to the
 * Descriptor Test Results workflow to publish the bundle; --reports-branch
 * (default test-reports).
 *
 * The review is skipped, never failed, when a condition does not hold. The
 * script always exits 0 and writes the decision to GITHUB_OUTPUT:
 *   proceed     "true" or "false"
 *   reason      ok | waiting | not-green | no-descriptor-tests |
 *               files-outside-scope | no-bundle | no-pull-request
 *   pr_number, head_sha, run_id, bundle_path
 *
 * Every input of this script comes from the GitHub API, not from the pull
 * request: the run conclusions, the changed file list, and the bundle that
 * the Descriptor Test Results workflow wrote from the default branch. A fork
 * can influence what is in the bundle, not which pull request or commit it
 * belongs to.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

// The workflows that must be green, by their `name:`. Both run on
// pull_request, so their runs carry the head commit of the pull request.
// Any other pull_request workflow that failed stops the review too, so a
// check added later counts without an edit here. Cancelled or skipped runs
// do not: the label and queue-note jobs are cancelled on every fast push.
const REQUIRED_WORKFLOWS = ['Registry Checks', 'Descriptor Tests'];
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
// A pull request that touches anything else can change the workflows that
// check it, so its green checks prove nothing.
const ALLOWED_PREFIXES = ['registry/', 'ercs/'];
const POLL_SECONDS = 30;
// The workflow starts with the pull request, so the runs it waits for may
// not be listed yet. A run still absent after this long never started.
const START_GRACE_SECONDS = 180;

const { values: opts } = parseArgs({
  options: {
    pr: { type: 'string' },
    // For local runs on a merged pull request, e.g. the price simulation.
    'allow-closed': { type: 'boolean', default: false },
    out: { type: 'string', default: 'ai-review' },
    'wait-minutes': { type: 'string', default: '45' },
    'reports-branch': { type: 'string', default: 'test-reports' },
  },
});

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
if (!token || !repository) {
  console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  process.exit(1);
}
const API = 'https://api.github.com';

async function api(route, { raw = false, params = {} } = {}) {
  const url = new URL(`${API}/repos/${repository}${route}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
  return raw ? res.text() : res.json();
}

async function paginate(route, params = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(route, { params: { ...params, per_page: 100, page } });
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v ?? ''}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  console.log(text);
}

function stop(reason, message, extra = {}) {
  summary(`## AI review: skipped\n\n${message}`);
  output({ proceed: 'false', reason, ...extra });
  process.exit(0);
}

/** The pull request under review. Its head commit comes from the API, not from the caller. */
async function findPullRequest() {
  if (!opts.pr) throw new Error('--pr is required');
  const pr = await api(`/pulls/${opts.pr}`);
  if (!pr || (pr.state !== 'open' && !opts['allow-closed'])) return null;
  return pr;
}

/** The latest pull_request run of each workflow for the commit, by workflow name. */
async function latestRuns(sha) {
  const { workflow_runs: runs } = await api('/actions/runs', {
    params: { head_sha: sha, event: 'pull_request', per_page: 100 },
  });
  const latest = {};
  for (const run of runs) {
    if (!latest[run.name] || run.created_at > latest[run.name].created_at) latest[run.name] = run;
  }
  return latest;
}

/** The changed files outside the allowed directories. */
async function filesOutsideScope(number) {
  const files = await paginate(`/pulls/${number}/files`);
  return files
    .map((f) => [f.filename, f.previous_filename].filter(Boolean))
    .flat()
    .filter((name) => !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

/** The bundle of the commit, from the index of the pull request on the reports branch. */
async function findBundle(number, sha) {
  const branch = opts['reports-branch'];
  const text = await api(`/contents/pr/${number}/index.json`, { raw: true, params: { ref: branch } });
  if (text === null) return null;
  const index = JSON.parse(text);
  const runs = (index.runs ?? []).filter((r) => r.headSha === sha);
  if (runs.length === 0) return null;
  // Newest first in the index, and the file is named by the run id.
  const run = runs.reduce((a, b) => (b.runId > a.runId ? b : a));
  const bundle = await api(`/contents/pr/${number}/${run.runId}.json`, { raw: true, params: { ref: branch } });
  if (bundle === null) return null;
  return { runId: run.runId, text: bundle };
}

async function main() {
  // Which pull request and which commit this run is about. Without an open
  // pull request there is nothing to comment on: stop.
  const pr = await findPullRequest();
  if (!pr) stop('no-pull-request', 'No open pull request matches this run.');
  const number = pr.number;
  const sha = pr.head.sha;
  const where = `#${number} at \`${sha.slice(0, 7)}\``;

  const deadline = Date.now() + Number(opts['wait-minutes']) * 60_000;
  const notGreen = (name, run) =>
    stop('not-green', `${where}: ${name} concluded with \`${run.conclusion}\` ([run](${run.html_url})). The AI review only runs on green checks.`, { pr_number: number, head_sha: sha });

  // Gate 1: every check of the commit is green. This workflow starts with
  // the pull request, alongside Registry Checks and Descriptor Tests, so
  // wait for both. A red run stops now, whichever it is.
  const startGrace = Date.now() + START_GRACE_SECONDS * 1000;
  let runs = await latestRuns(sha);
  for (;;) {
    for (const [name, run] of Object.entries(runs)) {
      if (run.status !== 'completed') continue;
      if (REQUIRED_WORKFLOWS.includes(name) ? run.conclusion !== 'success' : RED_CONCLUSIONS.has(run.conclusion)) notGreen(name, run);
    }
    const missing = REQUIRED_WORKFLOWS.filter((name) => !runs[name]);
    if (missing.includes('Descriptor Tests') && Date.now() >= startGrace) {
      // The tests only run when a descriptor, a shared file or a test changed.
      stop('no-descriptor-tests', `${where}: no Descriptor Tests run, so no descriptor changed. Nothing to review.`, { pr_number: number, head_sha: sha });
    }
    const pending = REQUIRED_WORKFLOWS.filter((name) => !runs[name] || runs[name].status !== 'completed');
    if (pending.length === 0) break;
    if (Date.now() >= deadline) {
      stop('waiting', `${where}: ${pending.join(' and ')} still not finished after ${opts['wait-minutes']} minutes. Re-run this workflow by hand once it is green.`, { pr_number: number, head_sha: sha });
    }
    console.log(`${pending.join(' and ')} not finished for ${where}, next look in ${POLL_SECONDS}s`);
    await sleep(POLL_SECONDS * 1000);
    runs = await latestRuns(sha);
  }

  // Gate 2: the pull request touches only descriptors and shared files. One
  // that edits anything else could have changed the checks above: stop.
  const outside = await filesOutsideScope(number);
  if (outside.length > 0) {
    const list = outside.slice(0, 20).map((f) => `- \`${f}\``).join('\n');
    stop('files-outside-scope', `${where} changes files outside \`registry/\` and \`ercs/\`, so it is not reviewed:\n\n${list}`, { pr_number: number, head_sha: sha });
  }

  // Gate 3: the test report bundle of this commit, which the Descriptor Test
  // Results workflow publishes on the test-reports branch one to three
  // minutes after the tests complete. Wait for it; if it never comes, the
  // review has no input: stop.
  let found = await findBundle(number, sha);
  while (!found && Date.now() < deadline) {
    console.log(`no test report bundle yet for ${where}, next look in ${POLL_SECONDS}s`);
    await sleep(POLL_SECONDS * 1000);
    found = await findBundle(number, sha);
  }
  if (!found) {
    stop('no-bundle', `${where}: no test report bundle appeared on \`${opts['reports-branch']}\` within ${opts['wait-minutes']} minutes. See the Descriptor Test Results run of this commit.`, { pr_number: number, head_sha: sha });
  }

  // The index said the bundle is for this commit; the bundle must agree.
  const bundle = JSON.parse(found.text);
  if (bundle.pr?.headSha !== sha) {
    stop('no-bundle', `${where}: the test report bundle of run ${found.runId} names commit \`${String(bundle.pr?.headSha).slice(0, 7)}\`, not this one.`, { pr_number: number, head_sha: sha });
  }

  // All gates passed: hand the test report bundle to the next job.
  fs.mkdirSync(opts.out, { recursive: true });
  const bundlePath = path.join(opts.out, 'bundle.json');
  fs.writeFileSync(bundlePath, found.text);
  const descriptors = (bundle.descriptors ?? []).map((d) => `- \`${d.path}\``).join('\n');
  summary(`## AI review: gate passed\n\n${where}, test report bundle of run ${found.runId}, ${(bundle.descriptors ?? []).length} descriptor(s):\n\n${descriptors}`);
  output({ proceed: 'true', reason: 'ok', pr_number: number, head_sha: sha, run_id: found.runId, bundle_path: bundlePath });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
