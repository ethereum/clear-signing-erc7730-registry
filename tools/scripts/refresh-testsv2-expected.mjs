#!/usr/bin/env node
/**
 * Re-render `expected` for every case in testsv2 fixtures from the Sourcify
 * clear-signing runner (same path CI uses). Keeps rawTx / from / txHash / description.
 *
 * Usage:
 *   node tools/scripts/refresh-testsv2-expected.mjs registry/vfat/testsv2
 *   node tools/scripts/refresh-testsv2-expected.mjs registry/vfat/testsv2/calldata-FarmStrategy.tests.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const RUNNER_ROOT =
  process.env.CLEAR_SIGNING_RUNNER || "/tmp/clear-signing-test-runner";

async function loadRunnerModules() {
  const runnerDist = path.join(RUNNER_ROOT, "dist");
  const { format } = await import(
    path.join(RUNNER_ROOT, "node_modules/@ethereum-sourcify/clear-signing/dist/index.js")
  );
  const { createFilesystemResolver } = await import(
    path.join(
      RUNNER_ROOT,
      "node_modules/@ethereum-sourcify/clear-signing/dist/filesystem.js",
    )
  );
  const { buildIndexFromDescriptorFile } = await import(
    path.join(runnerDist, "descriptor-index.js"),
  );
  const { buildExternalDataProvider } = await import(path.join(runnerDist, "data-provider.js"));
  const { decodeRawTx } = await import(path.join(runnerDist, "raw-tx.js"));
  const { mapDisplayModel } = await import(path.join(runnerDist, "render-mapper.js"));
  return {
    format,
    createFilesystemResolver,
    buildIndexFromDescriptorFile,
    buildExternalDataProvider,
    decodeRawTx,
    mapDisplayModel,
  };
}

function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function renderExpected(mods, descriptorPath, rawTx, from, dataProvider) {
  const { descriptorDirectory, index } = await mods.buildIndexFromDescriptorFile(descriptorPath);
  const resolver = mods.createFilesystemResolver({ index, descriptorDirectory });
  const externalDataProvider = mods.buildExternalDataProvider(dataProvider ?? {});
  const decoded = mods.decodeRawTx(rawTx);
  const model = await mods.format(
    {
      chainId: decoded.chainId,
      to: decoded.to,
      data: decoded.data,
      value: decoded.value,
      ...(from ? { from } : {}),
    },
    {
      descriptorResolverOptions: { type: "custom", resolver },
      externalDataProvider,
    },
  );
  const rendered = mods.mapDisplayModel(model);
  return { rendered, warnings: model.warnings ?? [] };
}

function collectTestFiles(arg) {
  const target = path.resolve(REPO_ROOT, arg);
  if (!fs.existsSync(target)) throw new Error(`not found: ${target}`);
  if (target.endsWith(".tests.json")) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".tests.json"))
    .map((f) => path.join(target, f))
    .sort();
}

async function refreshFile(mods, testPath) {
  const rel = path.relative(REPO_ROOT, testPath);
  const doc = JSON.parse(fs.readFileSync(testPath, "utf8"));
  const descriptorPath = path.resolve(path.dirname(testPath), doc.descriptor);
  let errors = 0;
  let warnings = 0;

  for (const tc of doc.tests) {
    if (!tc.rawTx) continue;
    try {
      const { rendered, warnings: w } = await renderExpected(
        mods,
        descriptorPath,
        tc.rawTx,
        tc.from,
        doc.dataProvider,
      );
      tc.expected = stripUndefined(rendered);
      if (!tc.expected.intent && tc.expected.intent !== "") {
        tc.expected.intent = "";
      }
      if (!Array.isArray(tc.expected.fields)) tc.expected.fields = [];
      if (w.length) {
        warnings += w.length;
        process.stderr.write(`  warn [${tc.description}]: ${w.map((x) => x.message || x).join("; ")}\n`);
      }
    } catch (e) {
      errors += 1;
      process.stderr.write(`  error [${tc.description}]: ${e.message}\n`);
      tc.expected = {
        intent: tc.expected?.intent ?? "",
        fields: Array.isArray(tc.expected?.fields) ? tc.expected.fields : [],
        ...(tc.expected?.owner ? { owner: tc.expected.owner } : {}),
      };
    }
  }

  fs.writeFileSync(testPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${rel}: refreshed (${doc.tests.length} cases, ${errors} render errors, ${warnings} lib warnings)`);
  return { errors, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("usage: refresh-testsv2-expected.mjs <testsv2-dir-or-file> [...]");
    process.exit(1);
  }
  const mods = await loadRunnerModules();
  let totalErrors = 0;
  for (const arg of args) {
    for (const f of collectTestFiles(arg)) {
      const { errors } = await refreshFile(mods, f);
      totalErrors += errors;
    }
  }
  if (totalErrors) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
