#!/usr/bin/env node
/**
 * Renders the "Clear Signing Tests" comment that clear-signing-tests-results.yml
 * writes on a pull request, from the artifacts of one clear-signing-tests.yml
 * run: the pr-context artifact (context.json, the test files and the resolved
 * descriptors), the results__* artifacts of the runners and, when given, the
 * test-coverage artifact (coverage.json, the report of check-test-coverage).
 *
 * Usage: node render-test-results.js --context <pr-context dir> --artifacts <results dir> [--coverage <test-coverage dir>]
 *
 * The run itself comes from the environment, because a fork cannot change the
 * workflow_run event: RUN_URL, TESTED_SHA, COMMIT_URL, RUN_STARTED_AT and
 * RUN_COMPLETED_AT. Writes the comment body to stdout. An empty body means
 * that the workflow must remove the comment, because no descriptor was
 * affected.
 *
 * The comment holds a status table with one column per implementation, the
 * expected and the rendered output of every case that did not pass, and, for
 * every case that passed, the rendered fields next to the display format that
 * the descriptor declares for the function, as it is. The runner names the
 * descriptor file in `descriptor` and the function in the `format` key of the
 * case. The last part lets a reviewer check a descriptor without reading the
 * test file and the descriptor side by side.
 *
 * Every input can come from a fork, so every string that lands in the comment
 * goes through text(), cell() or block().
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

// GitHub rejects a comment body above 65536 characters.
const MAX_BODY = 60000;

const STATUS_ICONS = { pass: '✅', fail: '❌', error: '⚠️', skipped: '⏭️' };
const icon = (s) => (Object.hasOwn(STATUS_ICONS, s) ? STATUS_ICONS[s] : '—');

/** Keeps an untrusted string on one line, with no markup of its own. */
const text = (v, max = 200) =>
  String(v ?? '')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max);

/** Keeps an untrusted string inside one table cell. */
const cell = (v) => text(v).replace(/\|/g, '\\|');

/** Keeps an untrusted string inside one code span, outside a table. */
const code = (v) => {
  const t = text(v).replace(/`/g, '');
  return t === '' ? '' : `\`${t}\``;
};

/** Keeps an untrusted value inside one fenced JSON block. */
const block = (v) => {
  const text_ = v != null ? JSON.stringify(v, null, 2) : '(none)';
  return text_.length > 4000 ? `${text_.slice(0, 4000)}\n… truncated` : text_;
};

const utc = (value) =>
  Number.isNaN(Date.parse(value))
    ? 'an unknown time'
    : `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const warn = (message) => process.stderr.write(`warning: ${message}\n`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`could not read ${file}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The descriptor side: the display format that a case exercised.
// ---------------------------------------------------------------------------

/** The rendered fields as label and value pairs. */
function renderedFields(value) {
  // The shape of the runner guide: an object keyed by label.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([label, v]) => ({ label, value: v }));
  }
  if (Array.isArray(value)) return value.filter((f) => f && typeof f === 'object');
  return [];
}

const isNested = (value) => value != null && typeof value === 'object' && 'fields' in value;

/** The table rows of one rendered output, with nested calldata indented. */
function fieldRows(rendered, depth = 0) {
  const indent = depth === 0 ? '' : `${'&nbsp;&nbsp;'.repeat(depth)}↳ `;
  const lines = [];
  for (const field of renderedFields(rendered.fields)) {
    const label = `${indent}${cell(field.label)}`;
    if (isNested(field.value)) {
      const inner = field.value;
      const head = [inner.intent, inner.interpolatedIntent, inner.owner]
        .filter((v) => v != null && v !== '')
        .map(cell)
        .join(' · ');
      lines.push(`| ${label} | ${head} |`);
      lines.push(...fieldRows(inner, depth + 1));
    } else {
      lines.push(`| ${label} | ${cell(field.value)} |`);
    }
  }
  return lines;
}

/** One collapsed section for a case that passed. */
function renderPassedCase(row, loadDescriptor, testCase, passedOn) {
  const result = row.byImpl[passedOn[0]];
  const rendered = result.rendered ?? testCase?.expected;
  if (!rendered || typeof rendered !== 'object') return '';

  // The runner reports the descriptor file and the key of display.formats
  // that it matched.
  const descriptor = loadDescriptor(result.descriptor);
  const formats = descriptor?.display?.formats;
  const format = typeof result.format === 'string' && formats && typeof formats === 'object' ? formats[result.format] : undefined;

  let out = `<details>\n<summary>✅ ${text(row.entity)}/${text(row.descriptor)} · ${text(row.description)}</summary>\n\n`;

  const meta = [];
  if (result.format != null) meta.push(`**Format:** ${code(result.format)}`);
  else meta.push('**Format:** not reported by the runner');
  meta.push(`**Intent:** ${code(rendered.intent)}`);
  if (rendered.interpolatedIntent != null) meta.push(`**Rendered intent:** ${code(rendered.interpolatedIntent)}`);
  if (rendered.owner != null) meta.push(`**Owner:** ${code(rendered.owner)}`);
  out += `${meta.join(' · ')}\n\n`;

  out += '| Label | Rendered |\n| --- | --- |\n';
  const lines = fieldRows(rendered);
  out += lines.length > 0 ? `${lines.join('\n')}\n` : '| _(no field)_ | |\n';

  // The format of the function as the descriptor declares it, with its
  // includes resolved, so the reviewer sees the params of each field next to
  // what it rendered as.
  if (format) out += `\n**Declared format:**\n\n\`\`\`json\n${block(format)}\n\`\`\`\n`;
  else if (result.descriptor == null) out += '\n_The runner reported no descriptor, so the declared format cannot be shown._\n';
  else if (!descriptor) out += `\n_No descriptor ${code(result.descriptor)} in the pull request context._\n`;
  else if (result.format != null) out += `\n_The descriptor declares no format ${code(result.format)}._\n`;

  out += `\nPassed on ${passedOn.map(code).join(', ')}\n\n</details>\n`;
  return out;
}

// ---------------------------------------------------------------------------
// The comment.
// ---------------------------------------------------------------------------

function render({ contextRoot, artifactsRoot, coverageRoot, env }) {
  const runUrl = env.RUN_URL ?? '';
  const testedSha = env.TESTED_SHA ?? '';

  // The artifact can be absent when the test run failed early. Say so,
  // instead of leaving the "in progress" note on the pull request.
  let ctx = null;
  if (fs.existsSync(path.join(contextRoot, 'context.json'))) {
    ctx = readJson(path.join(contextRoot, 'context.json'));
  } else {
    warn(`no pull request context in ${contextRoot}`);
  }

  let body = '## Clear Signing Tests\n\n';
  body += `Tested [\`${cell(testedSha).slice(0, 7)}\`](${env.COMMIT_URL ?? ''})`;
  body += ` · started ${utc(env.RUN_STARTED_AT)}`;
  body += ` · finished ${utc(env.RUN_COMPLETED_AT)}\n\n`;

  if (ctx === null) {
    return `${body}> The test run produced no results. See the [run](${runUrl}).\n`;
  }

  // Nothing was affected, so there is nothing to report.
  if (!ctx.has_affected) return '';

  // require-testsv2 already failed the run, but the annotations do not
  // explain how to fix it.
  const missing = Array.isArray(ctx.missing_tests) ? ctx.missing_tests : [];
  if (missing.length > 0) {
    body += `❌ ${missing.length} affected descriptor(s) have no test file:\n\n`;
    for (const descriptor of missing) body += `- \`${cell(descriptor)}\`\n`;
    body +=
      '\nCreate a test file at `registry/<entity>/testsv2/<descriptor-name>.tests.json`. ' +
      'See [testing documentation](../blob/master/README.md#reference-test-cases) for details.\n\n';
  }

  // check-test-coverage already failed the run, like require-testsv2. The
  // report is absent when the job did not run, or the run failed before it.
  const coverageFile = coverageRoot ? path.join(coverageRoot, 'coverage.json') : null;
  const coverage = coverageFile && fs.existsSync(coverageFile) ? readJson(coverageFile) : null;
  const gaps = coverage && typeof coverage === 'object' ? Object.entries(coverage) : [];
  if (gaps.length > 0) {
    body += `❌ ${gaps.length} affected descriptor(s) failed the test coverage check:\n\n`;
    for (const [descriptor, messages] of gaps) {
      body += `- \`${cell(descriptor)}\`\n`;
      for (const message of Array.isArray(messages) ? messages : []) body += `  - ${text(message, 1000)}\n`;
    }
    body += '\n';
  }

  // No descriptor had a test file, so no runner produced anything.
  if (!ctx.has_tests) return body;

  // Each artifact is a single file named `<slug>__<entity>__<descriptor>.json`.
  // With merge-multiple: true they all land flat in artifactsRoot.
  let resultFiles = [];
  try {
    // Grouped by descriptor, so that the rows of one descriptor sit together
    // whatever the implementation that ran it.
    const byDescriptor = (f) => f.replace(/\.json$/, '').split('__').slice(1).join('__');
    resultFiles = fs
      .readdirSync(artifactsRoot)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => byDescriptor(a).localeCompare(byDescriptor(b)) || a.localeCompare(b));
  } catch (e) {
    warn(`could not read ${artifactsRoot}: ${e.message}`);
  }
  process.stderr.write(`Matched ${resultFiles.length} result JSON files\n`);

  if (resultFiles.length === 0) {
    return `${body}> No implementation test results were uploaded. See the [run](${runUrl}).\n`;
  }

  // The test files and the descriptors travel in the pr-context artifact, so
  // both are available without a checkout of the head.
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, fs.existsSync(file) ? readJson(file) : null);
    return cache.get(file);
  };
  const loadCase = (entity, descriptor, description) => {
    const doc = load(path.join(contextRoot, 'tests', `${entity}__${descriptor}.tests.json`));
    if (!doc || !Array.isArray(doc.tests)) return null;
    return doc.tests.find((t) => t && t.description === description) ?? null;
  };
  // The runner names the descriptor by its path in the repository. Only that
  // shape is followed, so the path cannot leave the descriptors directory.
  const loadDescriptor = (descriptorPath) =>
    typeof descriptorPath === 'string' && /^registry\/[\w.-]+\/[\w.-]+\.json$/.test(descriptorPath)
      ? load(path.join(contextRoot, 'descriptors', descriptorPath))
      : null;

  // rows: keyed by entity|descriptor|description, each with a per-impl
  // status, rendered output and message.
  const rows = new Map();
  const impls = new Set();
  for (const file of resultFiles) {
    const data = readJson(path.join(artifactsRoot, file));
    if (!data) continue;
    const impl = data.implementation || file;
    impls.add(impl);
    const parts = file.replace(/\.json$/, '').split('__');
    const entity = parts[1];
    const descriptor = parts[2];
    for (const c of Array.isArray(data.cases) ? data.cases : []) {
      if (!c || typeof c !== 'object') continue;
      const key = `${entity}|${descriptor}|${c.description}`;
      if (!rows.has(key)) rows.set(key, { entity, descriptor, description: c.description, byImpl: {} });
      rows.get(key).byImpl[impl] = {
        status: c.status,
        rendered: c.rendered,
        message: c.message,
        descriptor: data.descriptor,
        format: c.format,
      };
    }
  }
  const implList = [...impls].sort();

  // --- Compact status table ---
  const header = ['Entity', 'Descriptor', 'Case', ...implList.map(cell)].join(' | ');
  const sep = ['---', '---', '---', ...implList.map(() => ':---:')].join(' | ');
  body += `| ${header} |\n| ${sep} |\n`;
  for (const r of rows.values()) {
    const cells = implList.map((i) => icon((r.byImpl[i] || {}).status));
    body += `| ${cell(r.entity)} | ${cell(r.descriptor)} | ${cell(r.description)} | ${cells.join(' | ')} |\n`;
  }
  body += '\n✅ pass · ❌ fail · ⚠️ error · ⏭️ skipped · — not run\n';

  // --- Details for non-pass cases ---
  const details = [];
  for (const r of rows.values()) {
    for (const impl of implList) {
      const result = r.byImpl[impl];
      if (!result || result.status === 'pass') continue;
      // A summary is raw HTML, so a code span needs the tag, not backticks.
      const summary = `${icon(result.status)} ${text(r.entity)}/${text(r.descriptor)} · ${text(r.description)} · <code>${text(impl)}</code>`;
      let block_ = `<details>\n<summary>${summary}</summary>\n\n`;
      if (result.message) block_ += `> ${text(result.message)}\n\n`;
      if (result.status === 'fail') {
        const expected = loadCase(r.entity, r.descriptor, r.description)?.expected ?? null;
        block_ += `**Expected:**\n\n\`\`\`json\n${block(expected)}\n\`\`\`\n\n`;
        block_ += `**Got:**\n\n\`\`\`json\n${block(result.rendered)}\n\`\`\`\n`;
      }
      block_ += '\n</details>\n';
      details.push(block_);
    }
  }
  if (details.length > 0) body += '\n### Details\n\n' + details.join('\n');

  // --- Rendered fields of the cases that passed ---
  // A case that passed rendered exactly the expected output, so one section
  // per case is enough, whatever the number of implementations.
  const passed = [];
  for (const r of rows.values()) {
    const passedOn = implList.filter((i) => r.byImpl[i]?.status === 'pass');
    if (passedOn.length === 0) continue;
    const section = renderPassedCase(r, loadDescriptor, loadCase(r.entity, r.descriptor, r.description), passedOn);
    if (section !== '') passed.push(section);
  }
  if (passed.length > 0) {
    body +=
      '\n### Rendered fields\n\n' +
      'The rendered fields of each case that passed, with the display format that the descriptor declares for it.\n\n';
    // Add sections while the comment fits, and say how many did not.
    const footer = `\n📋 [View test details](${runUrl})\n`;
    const reserve = footer.length + 200;
    let added = 0;
    for (const section of passed) {
      if (body.length + section.length + reserve > MAX_BODY) break;
      body += `${section}\n`;
      added++;
    }
    if (added < passed.length) {
      body += `> ${passed.length - added} more case(s) are not shown, because the comment would exceed the size limit of GitHub. See the [run](${runUrl}).\n`;
    }
  }

  body += `\n📋 [View test details](${runUrl})\n`;

  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n\n… truncated. See the [run](${runUrl}).\n`;
  }
  return body;
}

function main() {
  const { values } = parseArgs({
    options: { context: { type: 'string' }, artifacts: { type: 'string' }, coverage: { type: 'string' } },
  });
  if (!values.context || !values.artifacts) {
    process.stderr.write(
      'Usage: node render-test-results.js --context <pr-context dir> --artifacts <results dir> [--coverage <test-coverage dir>]\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    render({
      contextRoot: path.resolve(values.context),
      artifactsRoot: path.resolve(values.artifacts),
      coverageRoot: values.coverage ? path.resolve(values.coverage) : null,
      env: process.env,
    }),
  );
}

if (require.main === module) {
  main();
}

module.exports = { render };
