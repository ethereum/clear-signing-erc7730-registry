#!/usr/bin/env node
/**
 * Builds the test report bundle of one descriptor-tests.yml run: a single
 * JSON file that the test report viewer renders. The bundle joins, per
 * affected descriptor, the resolved descriptor, its test file, the results of
 * every implementation, the function coverage, and the recommendations.
 *
 * Inputs are the artifacts of the run, as descriptor-test-results.yml
 * downloads them:
 *
 *   --context   the pr-context artifact: context.json, tests/, descriptors/,
 *               for a modified descriptor base-descriptors/, and
 *               recommendations.json from check-recommended-fields.js
 *   --artifacts the results__* artifacts, merged flat: one
 *               <slug>__<entity>__<descriptor>.json per runner and descriptor
 *   --output    where to write the bundle
 *
 * The run itself comes from the environment, because a fork cannot change the
 * workflow_run event: RUN_ID, RUN_URL, RUN_STARTED_AT, RUN_COMPLETED_AT,
 * TESTED_SHA, HEAD_REPO, PR_NUMBER, PR_URL, PR_TITLE.
 *
 * Everything else in the bundle comes from a fork and is untrusted. The
 * script copies it as data; the viewer escapes it. The script never fails on
 * bad runner output: a case it cannot read becomes a case with the status
 * "error" and a message, so the report still shows the rest.
 *
 * The bundle format is documented in .github/test-runner-docs/bundle.md.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { parseTransaction } = require('viem');
// The same selector logic as the coverage check, so the check and the
// report cannot disagree on which format a test hits.
const { selectorOf, testSelector, reason } = require('./check-selector-coverage');

const SCHEMA_VERSION = 1;
const STATUSES = new Set(['pass', 'fail', 'error', 'skipped']);

const warn = (message) => process.stderr.write(`warning: ${message}\n`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`could not read ${file}: ${e.message}`);
    return null;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Rendered output
// ---------------------------------------------------------------------------

/**
 * The rendered output in the shape of the test schema: fields as an ordered
 * array of {label, value}. The runner guide once showed an object keyed by
 * label, so that shape is accepted and converted. Nested calldata values are
 * converted the same way.
 */
function normalizeRendered(value) {
  if (!isObject(value)) return value;
  const out = {};
  for (const key of ['intent', 'interpolatedIntent', 'owner']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  const fields = value.fields;
  if (Array.isArray(fields)) {
    out.fields = fields.map((f) =>
      isObject(f) ? { label: f.label, value: normalizeRendered(f.value) } : { label: undefined, value: f },
    );
  } else if (isObject(fields)) {
    out.fields = Object.entries(fields).map(([label, v]) => ({ label, value: normalizeRendered(v) }));
  } else {
    out.fields = fields;
  }
  for (const [key, v] of Object.entries(value)) {
    if (!(key in out)) out[key] = v;
  }
  return out;
}

/**
 * The differences between the expected and the rendered output, as a flat
 * list of {path, expected, got}. Fields are compared by position, like the
 * schema orders them. A missing field on either side is reported once, at
 * the field, not once per key.
 */
function diffRendered(expected, rendered, base = '') {
  const out = [];
  const at = (key) => (base === '' ? key : `${base}.${key}`);
  if (!isObject(expected) || !isObject(rendered)) {
    if (JSON.stringify(expected) !== JSON.stringify(rendered)) {
      out.push({ path: base || '$', expected, got: rendered });
    }
    return out;
  }
  for (const key of ['intent', 'interpolatedIntent', 'owner']) {
    const e = expected[key];
    const g = rendered[key];
    if (e === undefined && g === undefined) continue;
    if (e !== g) out.push({ path: at(key), expected: e ?? null, got: g ?? null });
  }
  const ef = Array.isArray(expected.fields) ? expected.fields : [];
  const gf = Array.isArray(rendered.fields) ? rendered.fields : [];
  if (ef.length !== gf.length) {
    out.push({ path: at('fields.length'), expected: ef.length, got: gf.length });
  }
  const n = Math.max(ef.length, gf.length);
  for (let i = 0; i < n; i++) {
    const e = ef[i];
    const g = gf[i];
    const p = at(`fields[${i}]`);
    if (e === undefined || g === undefined) {
      out.push({ path: p, expected: e ?? null, got: g ?? null });
      continue;
    }
    if ((e?.label ?? null) !== (g?.label ?? null)) {
      out.push({ path: `${p}.label`, expected: e?.label ?? null, got: g?.label ?? null });
    }
    const ev = e?.value;
    const gv = g?.value;
    if (isObject(ev) || isObject(gv)) {
      out.push(...diffRendered(ev, gv, `${p}.value`));
    } else if (ev !== gv) {
      out.push({ path: `${p}.value`, expected: ev ?? null, got: gv ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The descriptor side: formats, selectors, recommendations
// ---------------------------------------------------------------------------

/**
 * The formats of a descriptor with the selector of each one. A calldata
 * format key is a function signature with parameter names; the ABI parser
 * strips the names and expands shorthands before hashing. An EIP-712 format
 * key is a primary type, or a full type string: both start with the type
 * name, which is what the fixture's primaryType names.
 */
function formatsOf(descriptor, kind) {
  const formats = descriptor?.display?.formats;
  const out = {};
  if (!isObject(formats)) return out;
  for (const key of Object.keys(formats)) {
    const entry = { selector: null, primaryType: null, error: null, cases: [] };
    if (kind === 'calldata') {
      try {
        entry.selector = selectorOf(key);
      } catch (error) {
        entry.error = `not a function signature: ${reason(error)}`;
      }
    } else {
      entry.primaryType = key.trim().split('(')[0];
    }
    out[key] = entry;
  }
  return out;
}

/** The facts of a test input that the viewer needs before it decodes it. */
function inputOf(test) {
  if (typeof test.rawTx === 'string') {
    let tx;
    try {
      tx = parseTransaction(test.rawTx);
    } catch (error) {
      return { type: 'calldata', error: `rawTx cannot be decoded: ${reason(error)}` };
    }
    // The coverage check defines what a test calls. Calldata shorter than a
    // selector calls nothing.
    let selector = null;
    try {
      selector = testSelector(test);
    } catch {
      selector = null;
    }
    return {
      type: 'calldata',
      chainId: tx.chainId ?? null,
      to: tx.to ?? null,
      value: tx.value != null ? tx.value.toString() : '0',
      selector,
      txType: tx.type ?? null,
    };
  }
  if (isObject(test.data)) {
    const domain = isObject(test.data.domain) ? test.data.domain : {};
    return {
      type: 'eip712',
      chainId: domain.chainId != null ? Number(domain.chainId) : null,
      to: typeof domain.verifyingContract === 'string' ? domain.verifyingContract : null,
      primaryType: typeof test.data.primaryType === 'string' ? test.data.primaryType : null,
    };
  }
  return { type: 'unknown', error: 'the test has neither rawTx nor data' };
}

/** The format key of a descriptor that a test input hits, or null. */
function matchFormat(formats, input) {
  for (const [key, entry] of Object.entries(formats)) {
    if (input.type === 'calldata' && entry.selector && entry.selector === input.selector) return key;
    if (input.type === 'eip712' && entry.primaryType && entry.primaryType === input.primaryType) return key;
  }
  return null;
}

/**
 * The suggestions of check-recommended-fields.js, from recommendations.json in
 * the context. The file comes from a fork, so every item is checked and copied
 * key by key; an item that does not have the documented shape is dropped. A
 * context without the file, or with a file that is not version 1, gives no
 * suggestions.
 *
 * Returns the items and the "includes" chain of each descriptor, which maps a
 * suggestion on a shared file to the descriptors that include the file.
 */
function readRecommendations(contextRoot) {
  const file = path.join(contextRoot, 'recommendations.json');
  const none = { items: [], includes: new Map() };
  if (!fs.existsSync(file)) return none;
  const doc = readJson(file);
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.items)) {
    warn(`ignoring ${file}: not a version 1 recommendations file`);
    return none;
  }
  const items = [];
  doc.items.forEach((item, i) => {
    const ok =
      isObject(item) && ['type', 'file', 'pointer', 'message'].every((key) => typeof item[key] === 'string');
    if (!ok) {
      warn(`dropping recommendation #${i}: not an object with string type, file, pointer and message`);
      return;
    }
    const out = { type: item.type, file: item.file, pointer: item.pointer, message: item.message };
    for (const key of ['format', 'key']) {
      if (typeof item[key] === 'string') out[key] = item[key];
    }
    items.push(out);
  });
  const includes = new Map();
  if (isObject(doc.includes)) {
    for (const [descriptor, chain] of Object.entries(doc.includes)) {
      if (Array.isArray(chain)) includes.set(descriptor, chain.filter((f) => typeof f === 'string'));
    }
  }
  return { items, includes };
}

/**
 * The suggestions that apply to one descriptor. An item applies when it names
 * the descriptor itself or a file in its "includes" chain. A missing
 * interpolatedIntent applies only when the resolved descriptor has the format
 * and the format still has no interpolatedIntent: a descriptor can override a
 * format of the file it includes.
 */
function recommendationsFor(descriptorPath, head, { items, includes }) {
  const files = new Set([descriptorPath, ...(includes.get(descriptorPath) ?? [])]);
  const formats = isObject(head?.display?.formats) ? head.display.formats : {};
  const out = [];
  for (const item of items) {
    if (!files.has(item.file)) continue;
    if (item.type === 'no-interpolated-intent') {
      if (item.format === undefined || !Object.hasOwn(formats, item.format)) continue;
      const format = formats[item.format];
      if (!isObject(format) || 'interpolatedIntent' in format) continue;
      out.push({ type: item.type, format: item.format, file: item.file, pointer: item.pointer });
    } else if (item.type === 'deprecated-key') {
      if (item.key === undefined) continue;
      out.push({ type: item.type, key: item.key, file: item.file, pointer: item.pointer });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** One path segment: no separator, and not only dots. */
const SEGMENT = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** Whether a matrix entry names a registry descriptor, registry/<entity>/<name>.json. */
function isMatrixEntry(entry) {
  return (
    isObject(entry) &&
    typeof entry.entity === 'string' &&
    SEGMENT.test(entry.entity) &&
    typeof entry.descriptor_name === 'string' &&
    SEGMENT.test(entry.descriptor_name) &&
    entry.descriptor === `registry/${entry.entity}/${entry.descriptor_name}.json`
  );
}

/** Whether `file` resolves to a path inside `root`. */
const inside = (root, file) => path.resolve(file).startsWith(path.resolve(root) + path.sep);

function build({ contextRoot, artifactsRoot, env }) {
  // Without the context there is no pull request to describe, so there is
  // no report. The caller treats a missing context as "do not publish".
  const ctx = readJson(path.join(contextRoot, 'context.json'));
  if (ctx === null) throw new Error(`no pull request context in ${contextRoot}; the test run did not describe itself`);
  const matrix = Array.isArray(ctx.matrix) ? ctx.matrix : [];
  const changes = isObject(ctx.changes) ? ctx.changes : {};
  const recommendations = readRecommendations(contextRoot);

  // The results, grouped by descriptor. Each artifact file is named
  // <slug>__<entity>__<descriptor>.json; the slug names the implementation.
  const resultsByDescriptor = new Map();
  const implementations = new Map();
  let files = [];
  try {
    files = fs.readdirSync(artifactsRoot).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    warn(`could not read ${artifactsRoot}: ${e.message}`);
  }
  for (const file of files) {
    const parts = file.replace(/\.json$/, '').split('__');
    if (parts.length !== 3) {
      warn(`skipping ${file}: not <slug>__<entity>__<descriptor>.json`);
      continue;
    }
    const [slug, entity, name] = parts;
    const data = readJson(path.join(artifactsRoot, file));
    const key = `${entity}/${name}`;
    if (!resultsByDescriptor.has(key)) resultsByDescriptor.set(key, []);
    resultsByDescriptor.get(key).push({ slug, file, data });
    if (!implementations.has(slug)) {
      implementations.set(slug, {
        id: slug,
        runner: typeof data?.runner === 'string' ? data.runner : null,
        implementation: typeof data?.implementation === 'string' ? data.implementation : null,
      });
    }
  }

  const descriptors = [];
  for (const entry of matrix) {
    // The matrix comes from a fork, and its entries name files. Only an
    // entry that names a registry descriptor is read, and only from inside
    // the context directory.
    if (!isMatrixEntry(entry)) {
      warn(`skipping matrix entry ${JSON.stringify(entry)}: not a registry descriptor`);
      continue;
    }
    const descriptorPath = entry.descriptor;
    const entity = entry.entity;
    const name = entry.descriptor_name;
    const kind = name.startsWith('eip712-') ? 'eip712' : 'calldata';
    const headFile = path.join(contextRoot, 'descriptors', descriptorPath);
    const baseFile = path.join(contextRoot, 'base-descriptors', descriptorPath);
    const fixtureFile = path.join(contextRoot, 'tests', `${entity}__${name}.tests.json`);
    if (![headFile, baseFile, fixtureFile].every((f) => inside(contextRoot, f))) {
      warn(`skipping ${descriptorPath}: outside the context directory`);
      continue;
    }
    const head = readJson(headFile);
    const base = fs.existsSync(baseFile) ? readJson(baseFile) : null;
    const fixture = readJson(fixtureFile);
    const formats = formatsOf(head, kind);

    const change = isObject(changes[descriptorPath])
      ? changes[descriptorPath]
      : { descriptor: base ? 'modified' : head ? 'added' : 'unknown', tests: 'unknown' };

    // One case per fixture test, with the input facts and the result of
    // every implementation, keyed by its id.
    const cases = [];
    const byDescription = new Map();
    const tests = Array.isArray(fixture?.tests) ? fixture.tests : [];
    tests.forEach((test, i) => {
      if (!isObject(test)) return;
      const description = typeof test.description === 'string' ? test.description : `#${i + 1}`;
      const input = inputOf(test);
      const format = input.error ? null : matchFormat(formats, input);
      if (format) formats[format].cases.push(description);
      const c = {
        description,
        index: i,
        input,
        format,
        expected: normalizeRendered(test.expected),
        from: typeof test.from === 'string' ? test.from : null,
        txHash: typeof test.txHash === 'string' ? test.txHash : null,
        results: {},
      };
      cases.push(c);
      if (byDescription.has(description)) warn(`${descriptorPath}: duplicate test description ${JSON.stringify(description)}`);
      byDescription.set(description, c);
    });

    for (const { slug, file, data } of resultsByDescriptor.get(`${entity}/${name}`) ?? []) {
      const runnerCases = Array.isArray(data?.cases) ? data.cases : [];
      if (!data) {
        for (const c of cases) c.results[slug] = { status: 'error', message: `unreadable results file ${file}` };
        continue;
      }
      const seen = new Set();
      for (const rc of runnerCases) {
        if (!isObject(rc) || typeof rc.description !== 'string') continue;
        const c = byDescription.get(rc.description);
        if (!c) {
          warn(`${file}: case ${JSON.stringify(rc.description)} is not in the test file`);
          continue;
        }
        seen.add(rc.description);
        const status = STATUSES.has(rc.status) ? rc.status : 'error';
        const rendered = rc.rendered !== undefined ? normalizeRendered(rc.rendered) : null;
        const result = {
          status,
          rendered,
          message: typeof rc.message === 'string' ? rc.message : status !== rc.status ? `unknown status ${JSON.stringify(rc.status)}` : null,
          warnings: Array.isArray(rc.warnings) ? rc.warnings : [],
          // The runner may name the format it matched. When it does and it
          // differs from the selector match, the viewer shows both.
          format: typeof rc.format === 'string' ? rc.format : null,
          chainId: typeof rc.chainId === 'number' ? rc.chainId : null,
          durationMs: typeof rc.durationMs === 'number' ? rc.durationMs : null,
          diff: rendered !== null ? diffRendered(c.expected, rendered) : null,
        };
        c.results[slug] = result;
      }
      for (const c of cases) {
        if (!seen.has(c.description)) c.results[slug] = { status: 'error', message: 'the runner reported no result for this case' };
      }
    }

    descriptors.push({
      path: descriptorPath,
      entity,
      name,
      kind,
      change,
      testFile: typeof entry.test_file === 'string' ? entry.test_file : null,
      head,
      base,
      dataProvider: isObject(fixture?.dataProvider) ? fixture.dataProvider : null,
      formats,
      recommendations: recommendationsFor(descriptorPath, head, recommendations),
      cases,
    });
  }

  const number = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      id: number(env.RUN_ID),
      url: env.RUN_URL ?? null,
      startedAt: env.RUN_STARTED_AT ?? null,
      completedAt: env.RUN_COMPLETED_AT ?? null,
    },
    pr: {
      number: number(env.PR_NUMBER) ?? number(ctx.pr_number),
      url: env.PR_URL ?? null,
      title: env.PR_TITLE ?? null,
      headSha: env.TESTED_SHA ?? ctx.head_sha ?? null,
      headRepo: env.HEAD_REPO ?? ctx.head_repo ?? null,
      baseSha: env.BASE_SHA ?? ctx.base_sha ?? null,
    },
    implementations: [...implementations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    missingTests: Array.isArray(ctx.missing_tests) ? ctx.missing_tests : [],
    recommendations: recommendations.items,
    descriptors,
  };
}

function main() {
  const { values } = parseArgs({
    options: { context: { type: 'string' }, artifacts: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.context || !values.artifacts || !values.output) {
    process.stderr.write('Usage: node build-bundle.js --context <pr-context dir> --artifacts <results dir> --output <bundle.json>\n');
    process.exit(1);
  }
  let bundle;
  try {
    bundle = build({
      contextRoot: path.resolve(values.context),
      artifactsRoot: path.resolve(values.artifacts),
      env: process.env,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  fs.writeFileSync(values.output, JSON.stringify(bundle));
  const cases = bundle.descriptors.reduce((n, d) => n + d.cases.length, 0);
  process.stderr.write(`wrote ${values.output}: ${bundle.descriptors.length} descriptor(s), ${cases} case(s), ${bundle.implementations.length} implementation(s)\n`);
}

if (require.main === module) {
  main();
}

module.exports = { build, diffRendered, normalizeRendered, formatsOf, inputOf, matchFormat, readRecommendations, recommendationsFor };
