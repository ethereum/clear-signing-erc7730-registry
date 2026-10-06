#!/usr/bin/env node
/**
 * Adds one run to the index of a pull request on the test-reports branch.
 *
 * Usage: node report-index.js --bundle <pr/<n>/<run id>.json> --index <pr/<n>/index.json> [--run-id <id>]
 *
 * The index lists the runs of one pull request, newest first, with a short
 * summary of each, so the viewer can pick the latest run and show the history
 * without a fetch of every bundle. A run that is already in the index is
 * replaced. The format is documented in .github/test-runner-docs/bundle.md.
 */

const fs = require('fs');
const { parseArgs } = require('util');

const INDEX_VERSION = 1;

/** The summary of one bundle: counts per implementation and disagreements. */
function summarize(bundle) {
  const byStatus = {};
  for (const impl of bundle.implementations ?? []) {
    byStatus[impl.id] = { pass: 0, fail: 0, error: 0, skipped: 0 };
  }
  let cases = 0;
  let disagreements = 0;
  for (const descriptor of bundle.descriptors ?? []) {
    for (const c of descriptor.cases ?? []) {
      cases++;
      const statuses = new Set();
      for (const [id, result] of Object.entries(c.results ?? {})) {
        const status = result?.status ?? 'error';
        if (!byStatus[id]) byStatus[id] = { pass: 0, fail: 0, error: 0, skipped: 0 };
        if (status in byStatus[id]) byStatus[id][status]++;
        else byStatus[id].error++;
        statuses.add(status);
      }
      if (statuses.size > 1) disagreements++;
    }
  }
  return {
    descriptors: (bundle.descriptors ?? []).length,
    missingTests: (bundle.missingTests ?? []).length,
    cases,
    byStatus,
    disagreements,
  };
}

function entryOf(bundle, runId = null) {
  // The file is named by the run id of the workflow event. The bundle carries
  // the same id, but the file name is what the viewer fetches, so it wins.
  if (runId != null && bundle.run?.id != null && bundle.run.id !== runId) {
    process.stderr.write(`warning: the bundle names run ${bundle.run.id}, the file is named ${runId}\n`);
  }
  return {
    runId: runId ?? bundle.run?.id ?? null,
    runUrl: bundle.run?.url ?? null,
    headSha: bundle.pr?.headSha ?? null,
    startedAt: bundle.run?.startedAt ?? null,
    completedAt: bundle.run?.completedAt ?? null,
    generatedAt: bundle.generatedAt ?? null,
    schemaVersion: bundle.schemaVersion ?? null,
    summary: summarize(bundle),
  };
}

function update(index, bundle, runId = null) {
  const entry = entryOf(bundle, runId);
  const runs = (Array.isArray(index?.runs) ? index.runs : []).filter((r) => r?.runId !== entry.runId);
  runs.push(entry);
  // Newest first. The run id grows with time, and it is always set.
  runs.sort((a, b) => (b.runId ?? 0) - (a.runId ?? 0));
  return {
    indexVersion: INDEX_VERSION,
    pr: bundle.pr?.number ?? index?.pr ?? null,
    updatedAt: new Date().toISOString(),
    runs,
  };
}

function main() {
  const { values } = parseArgs({
    options: { bundle: { type: 'string' }, index: { type: 'string' }, 'run-id': { type: 'string' } },
  });
  if (!values.bundle || !values.index) {
    process.stderr.write('Usage: node report-index.js --bundle <bundle.json> --index <index.json> [--run-id <id>]\n');
    process.exit(1);
  }
  const runId = values['run-id'] != null && /^\d+$/.test(values['run-id']) ? Number(values['run-id']) : null;
  const bundle = JSON.parse(fs.readFileSync(values.bundle, 'utf8'));
  let index = null;
  if (fs.existsSync(values.index)) {
    try {
      index = JSON.parse(fs.readFileSync(values.index, 'utf8'));
    } catch (e) {
      process.stderr.write(`warning: ${values.index} is not valid JSON and is rewritten: ${e.message}\n`);
    }
  }
  const next = update(index, bundle, runId);
  fs.writeFileSync(values.index, `${JSON.stringify(next, null, 2)}\n`);
  process.stderr.write(`${values.index}: ${next.runs.length} run(s), latest ${next.runs[0]?.runId}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { summarize, entryOf, update };
