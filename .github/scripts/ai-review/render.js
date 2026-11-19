#!/usr/bin/env node
/**
 * Renders the answers of the AI review as pull request comments: one comment
 * per model.
 *
 * Usage: node render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>
 *
 * <answers> holds one folder per model, as run.js writes them.
 *
 * The comment is the model's own Markdown. It opens with a note that the
 * review is advisory and with the counts of findings per descriptor. Then
 * every finding of an answer, a "###" block, is folded under its own title
 * with the severity of its section in front, worst first, and the section
 * "What could not be reviewed" is folded under its name. The title of the
 * answer, its section headings and its "None." lines are not shown. The
 * units that got no answer are one list at the end, under "Not reviewed":
 * the units above the size limit together, the limit stated once, then the
 * rest with their error.
 *
 * Every answer was written by a model from data that came from the pull
 * request, so it is untrusted: the Markdown is kept, but HTML is escaped,
 * headings are demoted under the comment's own, and links, mentions and
 * issue references are broken so the text cannot ping anyone or send them
 * anywhere. Code fences are balanced so an answer cannot leave one open. The
 * run URL and the commit come from the workflow, not from the answers.
 *
 * Writes <out>/<folder>.md for each model folder; the first line of each file
 * is the marker that identifies the comment to update.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { countFindings } = require('./findings');

// GitHub rejects a comment body above 65536 characters.
const MAX_BODY = 60_000;
const MAX_ANSWER = 16_000;
const SEVERITIES = ['critical', 'warning', 'info'];
const ICONS = { critical: '🔴', warning: '🟠', info: '🔵' };
const LABELS = { critical: 'Critical', warning: 'Warning', info: 'Info' };

const { values: opts } = parseArgs({
  options: {
    answers: { type: 'string' },
    out: { type: 'string' },
    'run-url': { type: 'string' },
    'head-sha': { type: 'string' },
  },
});
if (!opts.answers || !opts.out) {
  console.error('usage: render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------

const ZW = '​';
// Text escaped: no HTML, no links, no mentions, no references.
const escape = (text) => text
  .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
  .replace(/@/g, `@${ZW}`)
  .replace(/#(\d)/g, `#${ZW}$1`)
  .replace(/\]\(/g, `]${ZW}(`)
  .replace(/:\/\//g, `:${ZW}//`);
// One line of prose, escaped outside its code spans: GitHub shows a code span
// as written, entities included, and nothing in one links or pings.
const prose = (line) => line.replace(/(`+)(.*?)\1|[^`]+|`+/g, (m, ticks) => (ticks ? m : escape(m)));
// A line of prose that cannot become a heading of the comment: a heading in
// it is demoted below the comment's own.
const demoted = (raw) => prose(raw).replace(/^(\s{0,3})(#{1,6})(\s)/, (m, indent, hashes, space) => `${indent}${'#'.repeat(Math.min(6, hashes.length + 3))}${space}`);
// One line, for a title or a table cell.
const line = (value, max = 200) => prose(String(value ?? '').slice(0, max)).replace(/\s+/g, ' ');
const ticks = (value, max = 300) => `\`${line(value, max).replace(/`/g, "'")}\``;
// A repository path from the bundle: only characters a path in this repository can have.
const repoPath = (value) => String(value ?? '').replace(/[^A-Za-z0-9/._-]/g, '').slice(0, 200);
const address = (value) => (/^0x[0-9a-fA-F]{40}$/.test(String(value)) ? String(value) : null);

/**
 * The lines of an answer, each marked as prose or as part of a fenced code
 * block; a fence left open is closed. The answer is cut at MAX_ANSWER.
 */
function tokenize(markdown) {
  let text = String(markdown ?? '').replace(/\r/g, '');
  const cut = text.length > MAX_ANSWER;
  if (cut) text = text.slice(0, MAX_ANSWER);
  const tokens = [];
  let fence = null;
  for (const raw of text.split('\n')) {
    const open = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      tokens.push({ code: true, text: raw });
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && raw.trim() === open[1]) fence = null;
    } else if (open) {
      fence = open[1];
      tokens.push({ code: true, text: raw });
    } else {
      tokens.push({ code: false, text: raw });
    }
  }
  if (fence) tokens.push({ code: true, text: fence });
  return { tokens, cut };
}

/** The tokens as Markdown: prose escaped and demoted, code as written, blank edges trimmed. */
function render(tokens) {
  const lines = tokens.map((t) => (t.code ? t.text : demoted(t.text)));
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

const CUT_NOTE = '*The answer was longer than this comment shows. The whole of it is in the artifact `ai-review-answers` of the run.*';

// GitHub renders Markdown inside <details> only with a blank line after
// <summary> and before </details>, and the blocks are never "open".
const toggle = (label, inner) => `<details>\n<summary>${label}</summary>\n\n${inner}</details>\n\n`;

// ---------------------------------------------------------------------------
// The answer folded: "## Critical", "## Warning" and "## Info" hold "###"
// findings, "## What could not be reviewed" is one block of text.
// ---------------------------------------------------------------------------

/**
 * The answer as Markdown: one toggle per finding, titled with the severity
 * of its section and the finding's own title; the limits of the review as a
 * last toggle. The "# Review" title, the section headings and the "None."
 * lines are dropped, and so is any text before the first section. Text that
 * does not belong to a finding is shown as it is. An answer with no section
 * at all is shown whole.
 */
function foldAnswer(markdown) {
  const { tokens, cut } = tokenize(markdown);
  const parts = [];
  let part = null;
  const open = (severity, title) => { part = { severity, title, lines: [] }; parts.push(part); };
  let section = tokens.some((t) => !t.code && /^## /.test(t.text)) ? null : 'other';
  for (const token of tokens) {
    const raw = token.text;
    if (!token.code) {
      const heading = raw.match(/^## (.+)$/);
      if (heading) {
        const name = heading[1].trim().toLowerCase();
        section = SEVERITIES.includes(name) ? name : /^what could not be reviewed/.test(name) ? 'limits' : 'other';
        part = null;
        if (section === 'limits') open(null, 'What could not be reviewed');
        if (section !== 'other') continue;
      }
      if (section === null) continue;
      const title = SEVERITIES.includes(section) && raw.match(/^### (.+)$/);
      if (title) { open(section, title[1].trim()); continue; }
      if (!part && /^\s*(none\.?)?\s*$/i.test(raw)) continue;
    }
    if (!part) open(null, null);
    part.lines.push(token);
  }

  let out = '';
  for (const p of parts) {
    const inner = render(p.lines);
    if (p.title === null) {
      if (inner) out += `${inner}\n\n`;
      continue;
    }
    // A "What could not be reviewed" that says nothing limited the review is noise.
    if (p.severity === null && /^\s*(nothing|none)\b/i.test(inner)) continue;
    const label = p.severity ? `${ICONS[p.severity]} ${LABELS[p.severity]}: ${line(p.title, 300)}` : p.title;
    out += toggle(label, inner ? `${inner}\n\n` : '');
  }
  if (cut) out += `${CUT_NOTE}\n\n`;
  return out;
}

// ---------------------------------------------------------------------------
// One comment per model folder
// ---------------------------------------------------------------------------

const sha = /^[0-9a-f]{40}$/.test(opts['head-sha'] ?? '') ? opts['head-sha'] : null;
const runUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(opts['run-url'] ?? '') ? opts['run-url'] : null;

const NOTE = '> [!IMPORTANT]\n> **Do not address these notes yet.** A language model wrote them; it can be wrong and it can miss things. A reviewer reads each note against the source and gives the final verdict.\n\n';

/** "🔴 1 critical · 🟠 2 warnings", or "No findings". */
function countsLine(c) {
  const parts = SEVERITIES.map((s) => [s, c[s]])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${ICONS[s]} ${n} ${s === 'warning' && n > 1 ? 'warnings' : s}`);
  return parts.length > 0 ? parts.join(' · ') : 'No findings';
}

/** "[`0x8076…d8D3` on chain 56](sourcify), [...]", up to eight deployments of the unit. */
function deploymentsLine(record) {
  const deployments = Array.isArray(record.unit?.deployments) ? record.unit.deployments : [];
  const link = (d) => {
    const a = address(d.address);
    const chain = Number(d.chainId) || 0;
    return a ? `[\`${a.slice(0, 6)}…${a.slice(-4)}\` on chain ${chain}](https://repo.sourcify.dev/${chain}/${a})` : `an unknown address on chain ${chain}`;
  };
  return deployments.length > 0
    ? deployments.slice(0, 8).map(link).join(', ') + (deployments.length > 8 ? `, and ${deployments.length - 8} more` : '')
    : 'no listed deployment';
}

/** "`SafeMoon` at [`0x8076…d8D3` on chain 56](sourcify)", naming the implementation behind a proxy. */
function whereLine(record) {
  const contracts = Array.isArray(record.contracts) ? record.contracts : [];
  const named = (role) => contracts.filter((c) => c.role === role && c.name).map((c) => ticks(c.name, 80));
  const implementations = named('implementation');
  const code = implementations.length > 0
    ? `${named('deployment')[0] ?? 'a proxy'}, a proxy running ${implementations.join(', ')},`
    : (named('deployment')[0] ?? 'an unnamed contract');
  return `${code} at ${deploymentsLine(record)}`;
}

/** The body of one reviewed unit: the answer folded; an answer that strays from the format gets a note first. */
function unitBody(record) {
  const note = record.ok ? '' : `*The answer does not follow the expected format (${line(record.error, 300)}); it is shown as it came.*\n\n`;
  return note + foldAnswer(record.answer);
}

const kilobytes = (bytes) => Math.round((Number(bytes) || 0) / 1000);

/**
 * The units that got no answer, as one list: the units above the size limit
 * first, with the limit stated once, then the units the model refused or the
 * API failed on, each with its error.
 */
function notReviewed(units) {
  if (units.length === 0) return '';
  const name = (u) => `\`${u.path}\`${u.group ? ` (${u.group})` : ''}`;
  const index = (u) => Number(u.record.unit?.index) || 0;
  const sorted = [...units].sort((a, b) => a.path.localeCompare(b.path) || index(a) - index(b));
  const tooLarge = sorted.filter((u) => u.record.bytes > u.record.maxBytes);
  const failed = sorted.filter((u) => !tooLarge.includes(u));
  let out = '### Not reviewed\n\n';
  if (tooLarge.length > 0) {
    const limit = kilobytes(tooLarge[0].record.maxBytes);
    out += `The model did not see ${tooLarge.length === 1 ? 'this one' : 'these'}: ${tooLarge.length === 1 ? 'it is' : 'each is'} above the size limit of ${limit} KB, and nothing is trimmed to fit.\n\n`;
    out += `${tooLarge.map((u) => `- ${name(u)}, ${kilobytes(u.record.bytes)} KB, at ${deploymentsLine(u.record)}`).join('\n')}\n\n`;
  }
  if (failed.length > 0) {
    out += `The review of ${failed.length === 1 ? 'this one' : 'these'} did not run:\n\n`;
    out += `${failed.map((u) => `- ${name(u)}, at ${deploymentsLine(u.record)}: ${line(u.record.error, 400)}`).join('\n')}\n\n`;
  }
  return out;
}

function renderComment(folder) {
  const dir = path.join(opts.answers, folder);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const records = summary.units.map((unit) => JSON.parse(fs.readFileSync(path.join(dir, path.basename(unit.file)), 'utf8')));
  const modelName = ticks(summary.model, 40);
  const t = summary.totals ?? {};

  const units = records.map((record) => {
    const of = Number(record.unit?.of) || 1;
    return {
      record,
      path: repoPath(record.descriptor?.path),
      group: of > 1 ? `group ${(Number(record.unit?.index) || 0) + 1} of ${of}` : null,
    };
  });
  const reviewed = units.filter((u) => u.record.answer).map((u) => ({
    ...u,
    counts: countsLine(countFindings(String(u.record.answer))),
    body: unitBody(u.record),
  }));

  let body = `<!-- ai-review: ${folder.replace(/[^A-Za-z0-9._-]/g, '')} -->\n## 🤖 AI review by ${modelName}\n\n${NOTE}`;
  const sections = [];
  if (reviewed.length === 1) {
    const [u] = reviewed;
    body += `**${u.counts}** in \`${u.path}\`${u.group ? ` (${u.group})` : ''} · ${whereLine(u.record)}\n\n`;
    sections.push(u.body);
  } else if (reviewed.length > 1) {
    body += `${reviewed.map((u) => `- **${u.counts}** in \`${u.path}\`${u.group ? ` (${u.group})` : ''}`).join('\n')}\n\n`;
    for (const u of reviewed) {
      let section = `### \`${u.path}\`${u.group ? ` · ${u.group}` : ''}\n\n`;
      section += `<sub>${u.group ? 'The deployments of this descriptor that run different code are reviewed separately. ' : ''}${whereLine(u.record)}.</sub>\n\n`;
      section += u.body;
      sections.push(section);
    }
  }

  let footer = `<sub>Model ${modelName}, effort ${ticks(summary.effort, 20)}`;
  if (t.inputTokens != null) footer += `, ${t.inputTokens} input tokens (${t.cacheReadTokens ?? 0} cached), ${t.outputTokens} output tokens`;
  if (t.costUSD != null) footer += `, about $${Number(t.costUSD).toFixed(3)}`;
  footer += `, on the descriptor${units.length > 1 ? 's' : ''} of ${sha ? `commit \`${sha.slice(0, 7)}\`` : 'this pull request'}, the tests and the verified source of the deployments.`;
  footer += `${runUrl ? ` [Run](${runUrl}),` : ''} answers and token usage in the artifact \`ai-review-answers\`.</sub>\n`;

  // The comment must fit: whole sections are dropped from the end, with a note.
  const tail = notReviewed(units.filter((u) => !u.record.answer)) + footer;
  let kept = 0;
  let length = body.length + tail.length + 200;
  for (const section of sections) {
    if (length + section.length > MAX_BODY) break;
    length += section.length;
    kept++;
  }
  body += sections.slice(0, kept).join('');
  if (kept < sections.length) {
    body += `${sections.length - kept} more descriptor(s) did not fit in this comment. Their notes are in the artifact \`ai-review-answers\` of the run.\n\n`;
  }
  body += tail;
  return { body, units: records.length, kept, sections: sections.length };
}

fs.mkdirSync(opts.out, { recursive: true });
const folders = fs.readdirSync(opts.answers, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(opts.answers, entry.name, 'summary.json')))
  .map((entry) => entry.name);
if (folders.length === 0) {
  console.error(`no answers in ${opts.answers}`);
  process.exit(1);
}
for (const folder of folders) {
  const { body, units, kept, sections } = renderComment(folder);
  const file = path.join(opts.out, `${folder.replace(/[^A-Za-z0-9._-]/g, '')}.md`);
  fs.writeFileSync(file, body);
  console.log(`${file}: ${body.length} characters, ${units} unit(s), ${kept} of ${sections} descriptor section(s)`);
}
