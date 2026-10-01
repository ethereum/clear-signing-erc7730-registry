#!/usr/bin/env node
/**
 * Renders the answers of the AI review as pull request comments: one comment
 * per model.
 *
 * Usage: node ai-review-render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>
 *
 * <answers> holds one folder per model, as ai-review-run.js writes them.
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

// GitHub rejects a comment body above 65536 characters.
const MAX_BODY = 60_000;
const MAX_ANSWER = 16_000;

const { values: opts } = parseArgs({
  options: {
    answers: { type: 'string' },
    out: { type: 'string' },
    'run-url': { type: 'string' },
    'head-sha': { type: 'string' },
  },
});
if (!opts.answers || !opts.out) {
  console.error('usage: ai-review-render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------

const ZW = '​';
// One line of prose, escaped: no HTML, no links, no mentions, no references.
const prose = (line) => line
  .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
  .replace(/@/g, `@${ZW}`)
  .replace(/#(\d)/g, `#${ZW}$1`)
  .replace(/\]\(/g, `]${ZW}(`)
  .replace(/:\/\//g, `:${ZW}//`);
// One line, for a summary or a table cell.
const line = (value, max = 200) => prose(String(value ?? '').slice(0, max)).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
const ticks = (value, max = 300) => `\`${line(value, max).replace(/`/g, "'")}\``;
// A repository path from the bundle: only characters a path in this repository can have.
const repoPath = (value) => String(value ?? '').replace(/[^A-Za-z0-9/._-]/g, '').slice(0, 200);
const address = (value) => (/^0x[0-9a-fA-F]{40}$/.test(String(value)) ? String(value) : 'unknown address');

/**
 * A whole answer: prose lines escaped and their headings demoted by three
 * levels, under the comment's own; fenced code left as written, since GitHub
 * renders it literally, but every fence closed.
 */
function clean(markdown) {
  let text = String(markdown ?? '').replace(/\r/g, '');
  let cut = false;
  if (text.length > MAX_ANSWER) {
    text = text.slice(0, MAX_ANSWER);
    cut = true;
  }
  const out = [];
  let fence = null;
  for (const raw of text.split('\n')) {
    const open = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      out.push(raw);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && raw.trim() === open[1]) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      out.push(raw);
      continue;
    }
    out.push(prose(raw).replace(/^(\s{0,3})(#{1,6})(\s)/, (m, indent, hashes, space) => `${indent}${'#'.repeat(Math.min(6, hashes.length + 3))}${space}`));
  }
  if (fence) out.push(fence);
  if (cut) out.push('', '*The answer was longer than this comment shows. The whole of it is in the artifact `ai-review-answers` of the run.*');
  return out.join('\n');
}

/** Findings per severity: the "###" headings inside each section. */
function countFindings(text) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const [severity, heading] of [['critical', '## Critical'], ['warning', '## Warning'], ['info', '## Info']]) {
    const start = text.indexOf(`\n${heading}`);
    if (start < 0) continue;
    const next = text.indexOf('\n## ', start + 1);
    counts[severity] = (text.slice(start, next < 0 ? undefined : next).match(/^### /gm) ?? []).length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// One comment per model folder
// ---------------------------------------------------------------------------

const sha = /^[0-9a-f]{40}$/.test(opts['head-sha'] ?? '') ? opts['head-sha'] : null;
const runUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(opts['run-url'] ?? '') ? opts['run-url'] : null;

function render(folder) {
  const dir = path.join(opts.answers, folder);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const records = summary.units.map((unit) => JSON.parse(fs.readFileSync(path.join(dir, path.basename(unit.file)), 'utf8')));
  const modelName = ticks(summary.model, 40);
  const t = summary.totals ?? {};

  let body = `<!-- ai-review: ${folder.replace(/[^A-Za-z0-9._-]/g, '')} -->\n## 🤖 AI review by ${modelName} (advisory)\n\n`;
  body += `A language model (${modelName}, effort ${ticks(summary.effort, 20)}) read the descriptors of ${sha ? `commit \`${sha.slice(0, 7)}\`` : 'this pull request'}, their tests, the pull request discussion and the verified source code of their deployments, and wrote the notes below${runUrl ? ` ([run](${runUrl}))` : ''}. `;
  body += 'It can be wrong and it can miss things. Nothing here is a check: it never blocks a merge, and a note is a question for the reviewer, not a verdict. Read each one against the source before acting on it.\n\n';
  const costLine = [
    `${t.reviewed ?? 0} unit(s) reviewed`,
    t.inputTokens != null ? `${t.inputTokens} input tokens (${t.cacheReadTokens ?? 0} cached), ${t.outputTokens} output tokens` : null,
    t.seconds != null ? `${t.seconds}s of model time` : null,
    t.costUSD != null ? `about $${Number(t.costUSD).toFixed(3)} at list price` : null,
  ].filter(Boolean).join(' · ');
  body += `Cost: ${costLine}.\n\n`;

  const byDescriptor = new Map();
  for (const record of records) {
    const key = repoPath(record.descriptor?.path);
    if (!byDescriptor.has(key)) byDescriptor.set(key, []);
    byDescriptor.get(key).push(record);
  }

  const sections = [];
  for (const [descriptor, units] of byDescriptor) {
    let section = `### \`${descriptor}\`\n\n`;
    for (const record of units) {
      const of = Number(record.unit?.of) || units.length;
      const deployments = Array.isArray(record.unit?.deployments) ? record.unit.deployments : [];
      const implementation = record.contracts?.find((c) => c.role === 'implementation') ?? record.contracts?.[0];
      const where = [
        of > 1 ? `Implementation ${(Number(record.unit?.index) || 0) + 1} of ${of}` : 'One implementation',
        implementation?.name ? ticks(implementation.name, 80) : null,
        deployments.length > 0 ? `${deployments.length} deployment${deployments.length > 1 ? 's' : ''} (${deployments.slice(0, 5).map((d) => `chain ${Number(d.chainId) || '?'}, ${address(d.address)}`).join('; ')}${deployments.length > 5 ? '; …' : ''})` : null,
      ].filter(Boolean).join(' · ');

      if (record.skipped) {
        section += `${where}: **not reviewed**, ${line(record.skipped)}.\n\n`;
        continue;
      }
      if (!record.answer) {
        section += `${where}: **the review did not run**. ${line(record.error, 400)}\n\n`;
        continue;
      }
      const c = countFindings(String(record.answer));
      const answer = clean(record.answer);
      const counts = [['critical', c.critical], ['warning', c.warning], ['info', c.info]].filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(', ');
      section += `${where}: **${counts || 'nothing to report'}**.${record.ok ? '' : ` The answer does not follow the expected format (${line(record.error, 300)}); it is shown as it came.`}\n\n`;
      section += `<details${c.critical > 0 ? ' open' : ''}>\n<summary>The review</summary>\n\n${answer}\n\n</details>\n\n`;
    }
    sections.push(section);
  }

  let footer = `<sub>Model ${modelName}, effort ${ticks(summary.effort, 20)}`;
  if (t.inputTokens != null) footer += ` · ${t.inputTokens} input tokens (${t.cacheReadTokens ?? 0} cached), ${t.outputTokens} output tokens`;
  if (t.costUSD != null) footer += ` · about $${Number(t.costUSD).toFixed(3)}`;
  footer += '. The answers and the token usage are the artifact `ai-review-answers` of the run.</sub>\n';

  // The comment must fit: whole sections are dropped from the end, with a note.
  let kept = 0;
  let length = body.length + footer.length + 200;
  for (const section of sections) {
    if (length + section.length > MAX_BODY) break;
    length += section.length;
    kept++;
  }
  body += sections.slice(0, kept).join('');
  if (kept < sections.length) {
    body += `${sections.length - kept} more descriptor(s) did not fit in this comment. Their notes are in the artifact \`ai-review-answers\` of the run.\n\n`;
  }
  body += footer;
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
  const { body, units, kept, sections } = render(folder);
  const file = path.join(opts.out, `${folder.replace(/[^A-Za-z0-9._-]/g, '')}.md`);
  fs.writeFileSync(file, body);
  console.log(`${file}: ${body.length} characters, ${units} unit(s), ${kept} of ${sections} descriptor section(s)`);
}
