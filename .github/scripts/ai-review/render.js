#!/usr/bin/env node
/**
 * Renders the answers of the AI review as pull request comments: one comment
 * per model.
 *
 * Usage: node render.js --answers <dir> --out <dir> --run-url <url> --head-sha <sha>
 *
 * <answers> holds one folder per model, as run.js writes them.
 *
 * The comment opens with the counts of findings per descriptor. Each
 * descriptor then has the model's summary in view and its findings folded
 * under one toggle per severity: a card per finding with its title, the
 * Effect, Screen, Gap and Fix lines, the check and the location, and the
 * evidence. An answer that does not parse into that shape is shown as it
 * came, folded.
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
const ICONS = { critical: '🔴', warning: '🟠', info: '🔵' };
const LABELS = { critical: 'Critical', warning: 'Warning', info: 'Info' };
// The lines of a finding as bullets, in this order, then Fix; Check and Where
// make the locator line and Evidence the code block.
const VISIBLE = ['Effect', 'Screen', 'Gap', 'Why', 'Outcome'];
const FOLDED = ['Check', 'Where', 'Evidence'];


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
// One line, for a summary or a table cell.
const line = (value, max = 200) => prose(String(value ?? '').slice(0, max)).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
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

// ---------------------------------------------------------------------------
// The shape of an answer: a summary, then Critical, Warning and Info, each a
// list of findings, then an optional "What could not be reviewed". A finding
// is a "###" title and "- **Key:** text" items, each item owning the lines
// that follow it, code included.
// ---------------------------------------------------------------------------

function parseAnswer(markdown) {
  const { tokens, cut } = tokenize(markdown);
  const answer = { summary: [], findings: { critical: [], warning: [], info: [] }, loose: { critical: [], warning: [], info: [] }, limits: [], cut };
  let section = 'summary';
  let finding = null;
  let item = null;
  let first = true;
  const push = (token) => {
    if (item) item.lines.push(token);
    else if (finding) finding.preamble.push(token);
    else if (section === 'summary') answer.summary.push(token);
    else if (section === 'limits') answer.limits.push(token);
    else if (answer.loose[section]) answer.loose[section].push(token);
  };
  for (const token of tokens) {
    if (token.code) { push(token); continue; }
    const raw = token.text;
    if (first && /^# /.test(raw)) { first = false; continue; }
    if (raw.trim()) first = false;
    const heading = raw.match(/^## (.+)$/);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      section = ['critical', 'warning', 'info'].includes(name) ? name : /^what could not be reviewed/.test(name) ? 'limits' : 'other';
      finding = null;
      item = null;
      continue;
    }
    const title = answer.findings[section] && raw.match(/^### (.+)$/);
    if (title) {
      finding = { title: title[1].trim(), preamble: [], items: [] };
      item = null;
      answer.findings[section].push(finding);
      continue;
    }
    const key = finding && raw.match(/^- \*\*([A-Za-z][A-Za-z ]{0,30}):\*\*\s?(.*)$/);
    if (key) {
      item = { key: key[1].trim(), text: key[2], lines: [] };
      finding.items.push(item);
      continue;
    }
    if (section === 'other') continue;
    push(token);
  }
  // A "What could not be reviewed" that says nothing limited the review is noise.
  if (/^\s*(nothing|none)\b/i.test(render(answer.limits))) answer.limits = [];
  return answer;
}

/** One "- **Key:** text" item, with the lines it owns: prose indented into the item, code after it. */
function renderItem(item, { heading = false } = {}) {
  const head = heading ? `**${line(item.key, 40)}:** ${prose(item.text)}` : `- **${line(item.key, 40)}:** ${prose(item.text)}`;
  const rest = render(item.lines);
  if (!rest) return head;
  // A folded item with no text of its own, "Evidence:" then a code block, is the block alone.
  if (heading && !item.text.trim()) return rest;
  if (heading || item.lines.some((t) => t.code)) return `${head}\n\n${rest}`;
  return `${head}\n${rest.split('\n').map((l) => (l.trim() ? `  ${l}` : l)).join('\n')}`;
}

/** One finding: its title with the severity, the Effect, Screen, Gap and Fix lines, the check and the location, then the evidence. */
function renderFinding(severity, finding) {
  const items = finding.items;
  const byKey = (k) => items.filter((i) => i.key.toLowerCase() === k.toLowerCase());
  const known = (k) => [...VISIBLE, ...FOLDED, 'Fix'].some((n) => n.toLowerCase() === k.toLowerCase());
  const bullets = [...VISIBLE.flatMap(byKey), ...items.filter((i) => !known(i.key)), ...byKey('Fix')];
  const locator = ['Check', 'Where'].flatMap(byKey).map((i) => `${line(i.key, 40)}: ${prose(i.text)}`).filter(Boolean);

  let out = `#### ${ICONS[severity]} ${LABELS[severity]}: ${line(finding.title, 300)}\n\n`;
  const preamble = render(finding.preamble);
  if (preamble) out += `${preamble}\n\n`;
  if (bullets.length > 0) out += `${bullets.map((i) => renderItem(i)).join('\n')}\n\n`;
  if (locator.length > 0) out += `<sub>${locator.join(' · ')}</sub>\n\n`;
  const evidence = byKey('Evidence').map((i) => renderItem(i, { heading: true })).join('\n\n');
  if (evidence) out += `${evidence}\n\n`;
  return out;
}

/**
 * The findings of an answer: one toggle per severity, worst first, labelled
 * with the count, and one for the limits of the review at the end. The
 * summary stays in view above. GitHub renders Markdown inside <details>
 * only with a blank line after <summary> and before </details>, and the
 * blocks are never "open".
 */
const toggle = (label, inner) => `<details>\n<summary>${label}</summary>\n\n${inner}</details>\n\n`;

function renderAnswer(answer) {
  let out = '';
  const summary = render(answer.summary);
  if (summary) out += `${summary.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
  for (const severity of ['critical', 'warning', 'info']) {
    const findings = answer.findings[severity];
    let cards = findings.map((finding) => renderFinding(severity, finding)).join('');
    const loose = render(answer.loose[severity]);
    if (loose && !/^none\.?$/i.test(loose.trim())) cards += `${loose}\n\n`;
    if (!cards) continue;
    const n = findings.length;
    const label = n > 0 ? `${ICONS[severity]} ${n} ${severity === 'warning' && n > 1 ? 'warnings' : severity}` : `${ICONS[severity]} ${LABELS[severity]}`;
    out += toggle(label, cards);
  }
  const limits = render(answer.limits);
  if (limits) out += toggle('What could not be reviewed', `${limits}\n\n`);
  if (answer.cut) out += `${CUT_NOTE}\n\n`;
  return out;
}

/** The whole answer as it came, escaped, for one that does not follow the format. */
function renderRaw(markdown) {
  const { tokens, cut } = tokenize(markdown);
  return `${render(tokens)}\n${cut ? `\n${CUT_NOTE}\n` : ''}`;
}

// ---------------------------------------------------------------------------
// One comment per model folder
// ---------------------------------------------------------------------------

const sha = /^[0-9a-f]{40}$/.test(opts['head-sha'] ?? '') ? opts['head-sha'] : null;
const runUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(opts['run-url'] ?? '') ? opts['run-url'] : null;

/** "🔴 1 critical · 🟠 2 warnings", or "No findings". */
function countsLine(c) {
  const parts = [['critical', c.critical], ['warning', c.warning], ['info', c.info]]
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${ICONS[s]} ${n} ${s === 'warning' && n > 1 ? 'warnings' : s}`);
  return parts.length > 0 ? parts.join(' · ') : 'No findings';
}

/** "`SafeMoon` at [`0x8076…d8D3` on chain 56](sourcify)", naming the implementation behind a proxy. */
function whereLine(record) {
  const deployments = Array.isArray(record.unit?.deployments) ? record.unit.deployments : [];
  const contracts = Array.isArray(record.contracts) ? record.contracts : [];
  const named = (role) => contracts.filter((c) => c.role === role && c.name).map((c) => ticks(c.name, 80));
  const implementations = named('implementation');
  const code = implementations.length > 0
    ? `${named('deployment')[0] ?? 'a proxy'}, a proxy running ${implementations.join(', ')},`
    : (named('deployment')[0] ?? 'an unnamed contract');
  const link = (d) => {
    const a = address(d.address);
    const chain = Number(d.chainId) || 0;
    return a ? `[\`${a.slice(0, 6)}…${a.slice(-4)}\` on chain ${chain}](https://repo.sourcify.dev/${chain}/${a})` : `an unknown address on chain ${chain}`;
  };
  const where = deployments.length > 0
    ? deployments.slice(0, 8).map(link).join(', ') + (deployments.length > 8 ? `, and ${deployments.length - 8} more` : '')
    : 'no listed deployment';
  return `${code} at ${where}`;
}

/** The body of one unit: the answer as cards, or the error, or the raw answer with a note. */
function unitBody(record) {
  if (!record.answer) return `**The review did not run.** ${line(record.error, 400)}\n\n`;
  const answer = parseAnswer(record.answer);
  const parsed = record.ok && ['critical', 'warning', 'info'].some((s) => answer.findings[s].length > 0 || answer.loose[s].length > 0);
  if (parsed) return renderAnswer(answer);
  const why = record.ok ? 'The answer does not follow the expected format' : `The answer does not follow the expected format (${line(record.error, 300)})`;
  return `${why}; it is shown as it came.\n\n<details>\n<summary>The answer</summary>\n\n${renderRaw(record.answer)}\n</details>\n\n`;
}

function renderComment(folder) {
  const dir = path.join(opts.answers, folder);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const records = summary.units.map((unit) => JSON.parse(fs.readFileSync(path.join(dir, path.basename(unit.file)), 'utf8')));
  const modelName = ticks(summary.model, 40);
  const t = summary.totals ?? {};

  const units = records.map((record) => {
    const of = Number(record.unit?.of) || 1;
    const counts = record.answer ? countsLine(countFindings(String(record.answer))) : 'Not reviewed';
    return {
      record,
      path: repoPath(record.descriptor?.path),
      group: of > 1 ? `group ${(Number(record.unit?.index) || 0) + 1} of ${of}` : null,
      counts,
      body: unitBody(record),
    };
  });

  let body = `<!-- ai-review: ${folder.replace(/[^A-Za-z0-9._-]/g, '')} -->\n## 🤖 AI review by ${modelName}\n\n`;
  const sections = [];
  if (units.length === 1) {
    const [u] = units;
    body += `**${u.counts}** in \`${u.path}\` · ${whereLine(u.record)}\n\n`;
    sections.push(u.body);
  } else {
    body += `${units.map((u) => `- **${u.counts}** in \`${u.path}\`${u.group ? ` (${u.group})` : ''}`).join('\n')}\n\n`;
    for (const u of units) {
      let section = `### \`${u.path}\`${u.group ? ` · ${u.group}` : ''}\n\n`;
      section += `<sub>${u.group ? 'The deployments of this descriptor that run different code are reviewed separately. ' : ''}${whereLine(u.record)}.</sub>\n\n`;
      section += u.body;
      sections.push(section);
    }
  }

  let footer = `<sub>Advisory, never a check: a language model read the descriptor${units.length > 1 ? 's' : ''} of ${sha ? `commit \`${sha.slice(0, 7)}\`` : 'this pull request'}, the tests and the verified source of the deployments, and wrote the notes above. It can be wrong and it can miss things; read each note against the source before acting on it. `;
  footer += `Model ${modelName}, effort ${ticks(summary.effort, 20)}`;
  if (t.inputTokens != null) footer += `, ${t.inputTokens} input tokens (${t.cacheReadTokens ?? 0} cached), ${t.outputTokens} output tokens`;
  if (t.costUSD != null) footer += `, about $${Number(t.costUSD).toFixed(3)}`;
  footer += `.${runUrl ? ` [Run](${runUrl}),` : ''} answers and token usage in the artifact \`ai-review-answers\`.</sub>\n`;

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
  const { body, units, kept, sections } = renderComment(folder);
  const file = path.join(opts.out, `${folder.replace(/[^A-Za-z0-9._-]/g, '')}.md`);
  fs.writeFileSync(file, body);
  console.log(`${file}: ${body.length} characters, ${units} unit(s), ${kept} of ${sections} descriptor section(s)`);
}
