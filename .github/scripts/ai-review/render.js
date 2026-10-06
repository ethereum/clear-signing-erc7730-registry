#!/usr/bin/env node
/**
 * Renders the answers of the AI review as pull request comments: one comment
 * per model.
 *
 * Usage: node render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>
 *
 * <answers> holds one folder per model, as run.js writes them.
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
  // A "What could not be reviewed" section that says nothing limited the
  // review is noise: the prompt asks to leave it out, low effort writes it anyway.
  text = text.replace(/\n## What could not be reviewed\s*\n+\s*(nothing|none)\b[^\n]*\s*$/i, '\n');
  const out = [];
  let fence = null;
  let severity = null;
  let first = true;
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
    // The answer's own title repeats the descriptor path the comment already shows.
    if (first && /^# /.test(raw)) { first = false; continue; }
    if (raw.trim()) first = false;
    const section = raw.match(/^## (Critical|Warning|Info)\b/);
    if (section) severity = section[1].toLowerCase();
    else if (/^## /.test(raw)) severity = null;
    // Each finding says its severity, not only the section it sits in.
    const finding = severity && raw.match(/^### (.*)$/);
    const line = finding ? `### ${ICONS[severity]} ${LABELS[severity]}: ${finding[1]}` : raw;
    out.push(prose(line).replace(/^(\s{0,3})(#{1,6})(\s)/, (m, indent, hashes, space) => `${indent}${'#'.repeat(Math.min(6, hashes.length + 3))}${space}`));
  }
  if (fence) out.push(fence);
  if (cut) out.push('', '*The answer was longer than this comment shows. The whole of it is in the artifact `ai-review-answers` of the run.*');
  return out.join('\n');
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
  body += `A language model (${modelName}) read the descriptors of ${sha ? `commit \`${sha.slice(0, 7)}\`` : 'this pull request'}, their tests and the verified source code of their deployments, and wrote the notes below${runUrl ? ` ([run](${runUrl}))` : ''}. `;
  body += 'It can be wrong and it can miss things. Nothing here is a check: it never blocks a merge, and a note is a question for the reviewer. Read each one against the source before acting on it.\n\n';

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
      const contracts = Array.isArray(record.contracts) ? record.contracts : [];
      const named = (role) => contracts.filter((c) => c.role === role && c.name).map((c) => ticks(c.name, 80));
      const implementations = named('implementation');
      const codeLine = implementations.length > 0
        ? `${named('deployment')[0] ?? 'a proxy'} is a proxy; the code reviewed is ${implementations.join(', ')}`
        : (named('deployment')[0] ?? 'unnamed');
      const sourcify = (d) => `chain ${Number(d.chainId) || '?'}: [\`${address(d.address)}\`](https://repo.sourcify.dev/${Number(d.chainId) || 0}/${address(d.address)})`;
      let where = of > 1 ? `**Group ${(Number(record.unit?.index) || 0) + 1} of ${of}**, the deployments of this descriptor that run different code are reviewed separately.\n\n` : '';
      where += `- **Deployments:** ${deployments.length > 0 ? deployments.slice(0, 8).map(sourcify).join(', ') + (deployments.length > 8 ? `, and ${deployments.length - 8} more` : '') : 'none listed'}\n`;
      where += `- **Contract:** ${codeLine}\n`;

      if (record.skipped) {
        section += `${where}- **Findings:** not reviewed, ${line(record.skipped)}\n\n`;
        continue;
      }
      if (!record.answer) {
        section += `${where}- **Findings:** the review did not run. ${line(record.error, 400)}\n\n`;
        continue;
      }
      const c = countFindings(String(record.answer));
      const answer = clean(record.answer);
      const counts = [['critical', c.critical], ['warning', c.warning], ['info', c.info]]
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${ICONS[s]} ${n} ${s === 'warning' && n > 1 ? 'warnings' : s}`)
        .join(', ');
      section += `${where}- **Findings:** ${counts || 'none'}${record.ok ? '' : `. The answer does not follow the expected format (${line(record.error, 300)}); it is shown as it came`}\n\n`;
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
