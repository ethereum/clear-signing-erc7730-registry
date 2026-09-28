#!/usr/bin/env node
/**
 * Builds the inputs of the AI review from a test report bundle: one JSON file
 * per review unit, where a unit is a descriptor together with one distinct
 * implementation source. Deployments that share a source are reviewed once.
 *
 * Usage: node ai-review-collect.js --bundle <file> --out <dir> [--max-bytes <n>]
 *
 * Environment: SOURCIFY_TOKEN (optional), SOURCIFY_URL (default
 * https://sourcify.dev/server).
 *
 * Writes <out>/inputs/<entity>__<name>__<unit>.json and <out>/inputs/index.json.
 * An input holds the descriptor, its test cases and results from the bundle,
 * and for every contract of the unit the verified sources, the ABI, the
 * NatSpec, the proxy resolution and the decoded constructor arguments from
 * Sourcify. Everything in it comes from the pull request or from Sourcify and
 * is data for the model, never code to run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');
const { decodeAbiParameters } = require('viem');

const { values: opts } = parseArgs({
  options: {
    bundle: { type: 'string' },
    out: { type: 'string', default: 'ai-review' },
    'max-bytes': { type: 'string', default: String(1_500_000) },
  },
});
if (!opts.bundle) {
  console.error('usage: ai-review-collect.js --bundle <file> --out <dir> [--max-bytes <n>]');
  process.exit(1);
}

const SOURCIFY_URL = (process.env.SOURCIFY_URL || 'https://sourcify.dev/server').replace(/\/$/, '');
const SOURCIFY_TOKEN = process.env.SOURCIFY_TOKEN || '';
const CONCURRENCY = 2;
const MAX_BYTES = Number(opts['max-bytes']);

const warn = (message) => process.stderr.write(`warning: ${message}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sourcify: one fetch per address, two at a time, a shared pause on 429
// ---------------------------------------------------------------------------

const cache = new Map();
let running = 0;
let pauseUntil = 0;
let pauseMs = 5_000;

async function sourcify(chainId, address) {
  const key = `${chainId}-${address.toLowerCase()}`;
  if (!cache.has(key)) cache.set(key, fetchContract(chainId, address, key));
  return cache.get(key);
}

async function fetchContract(chainId, address, key) {
  while (running >= CONCURRENCY) await sleep(50);
  running++;
  try {
    for (;;) {
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const res = await fetch(`${SOURCIFY_URL}/v2/contract/${chainId}/${address}?fields=all`, {
        headers: SOURCIFY_TOKEN ? { 'X-Sourcify-Token': SOURCIFY_TOKEN } : {},
      });
      if (res.status === 429) {
        pauseUntil = Date.now() + pauseMs;
        pauseMs = Math.min(pauseMs * 2, 60_000);
        warn(`429 from Sourcify for ${key}, pausing ${pauseMs / 1000}s`);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Sourcify ${key}: ${res.status} ${await res.text()}`);
      return res.json();
    }
  } finally {
    running--;
  }
}

// ---------------------------------------------------------------------------
// The subset of a Sourcify response that the model gets
// ---------------------------------------------------------------------------

function constructorArguments(response) {
  const hex = response.creationBytecode?.transformationValues?.constructorArguments;
  if (!hex) return null;
  const inputs = (response.abi ?? []).find((e) => e.type === 'constructor')?.inputs ?? [];
  try {
    const values = decodeAbiParameters(inputs, hex);
    return inputs.map((input, i) => ({ name: input.name, type: input.type, value: plain(values[i]) }));
  } catch (e) {
    warn(`constructor arguments of ${response.chainId}-${response.address} not decoded: ${e.message}`);
    return { raw: hex };
  }
}

/** JSON-safe copy of a decoded value: bigints as decimal strings. */
function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

function subset(chainId, address, role, response) {
  if (!response) return { chainId, address, role, match: null };
  return {
    chainId,
    address,
    role,
    match: response.match ?? null,
    fullyQualifiedName: response.compilation?.fullyQualifiedName ?? null,
    compilerVersion: response.compilation?.compilerVersion ?? null,
    deployer: response.deployment?.deployer ?? null,
    proxyResolution: response.proxyResolution ?? null,
    abi: response.abi ?? null,
    devdoc: response.devdoc ?? null,
    userdoc: response.userdoc ?? null,
    constructorArguments: constructorArguments(response),
    // Raw 32-byte words keyed by AST id: the names need the AST, which is not kept.
    immutables: response.runtimeBytecode?.transformationValues?.immutables ?? null,
    sources: Object.fromEntries(Object.entries(response.sources ?? {}).map(([p, s]) => [p, s.content])),
  };
}

// ---------------------------------------------------------------------------
// Contracts of a deployment: the address itself, then the implementations
// ---------------------------------------------------------------------------

async function contractsOf(deployment) {
  const { chainId, address } = deployment;
  const response = await sourcify(chainId, address);
  const contracts = [subset(chainId, address, 'deployment', response)];
  for (const impl of response?.proxyResolution?.implementations ?? []) {
    contracts.push(subset(chainId, impl.address, 'implementation', await sourcify(chainId, impl.address)));
  }
  return contracts;
}

/** The code a call to the deployment runs: the implementations of a proxy, else itself. */
function implementationKey(contracts) {
  const code = contracts.filter((c) => c.role === 'implementation');
  const effective = code.length > 0 ? code : contracts;
  const hash = crypto.createHash('sha256');
  for (const c of effective) {
    hash.update(JSON.stringify(c.abi ?? null));
    for (const p of Object.keys(c.sources ?? {}).sort()) hash.update(p).update(c.sources[p]);
  }
  return hash.digest('hex').slice(0, 16);
}

function deploymentsOf(head) {
  return head?.context?.contract?.deployments ?? head?.context?.eip712?.deployments ?? [];
}

// ---------------------------------------------------------------------------
// The descriptor side: cases without the redundant rendered screens, calldata formats
// ---------------------------------------------------------------------------

function pruneCases(cases) {
  return (cases ?? []).map((c) => ({
    ...c,
    results: Object.fromEntries(
      Object.entries(c.results ?? {}).map(([impl, r]) => {
        const passed = r.status === 'pass' && (r.diff == null || r.diff.length === 0);
        return [impl, passed ? { ...r, rendered: undefined } : r];
      }),
    ),
  }));
}

/** Every field with the embedded calldata format, with the format key it belongs to. */
function calldataFormats(head) {
  const out = [];
  const walk = (node, format) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, format));
    if (!node || typeof node !== 'object') return;
    if (node.format === 'calldata') out.push({ format, path: node.path ?? null, params: node.params ?? null });
    for (const v of Object.values(node)) walk(v, format);
  };
  for (const [format, spec] of Object.entries(head?.display?.formats ?? {})) walk(spec, format);
  return out;
}

// ---------------------------------------------------------------------------
// Size cap: drop the largest source files first, never the main file of a contract
// ---------------------------------------------------------------------------

function bytesOf(input) {
  return Buffer.byteLength(JSON.stringify(input));
}

function cap(input) {
  input.dropped = [];
  while (bytesOf(input) > MAX_BYTES) {
    let largest = null;
    for (const c of input.contracts) {
      const main = c.fullyQualifiedName ? c.fullyQualifiedName.split(':')[0] : null;
      for (const [p, content] of Object.entries(c.sources ?? {})) {
        if (p === main) continue;
        if (!largest || content.length > largest.bytes) largest = { contract: c, path: p, bytes: content.length };
      }
    }
    if (!largest) break;
    delete largest.contract.sources[largest.path];
    input.dropped.push({ chainId: largest.contract.chainId, address: largest.contract.address, path: largest.path, bytes: largest.bytes });
  }
  if (input.dropped.length > 0 || bytesOf(input) > MAX_BYTES) {
    warn(`${input.file}: ${input.dropped.length} source file(s) dropped, ${bytesOf(input)} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Main: one input per descriptor and distinct implementation
// ---------------------------------------------------------------------------

async function main() {
  const bundle = JSON.parse(fs.readFileSync(opts.bundle, 'utf8'));
  const outDir = path.join(opts.out, 'inputs');
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];

  for (const descriptor of bundle.descriptors ?? []) {
    if (!descriptor.head) continue;
    const deployments = deploymentsOf(descriptor.head);
    const byKey = new Map();
    for (const deployment of deployments) {
      const contracts = await contractsOf(deployment);
      const key = implementationKey(contracts);
      if (!byKey.has(key)) byKey.set(key, { deployments: [], contracts });
      byKey.get(key).deployments.push(deployment);
    }

    let unit = 0;
    for (const [key, group] of byKey) {
      const file = `${descriptor.entity}__${descriptor.name}__${unit}.json`;
      const input = {
        schemaVersion: 1,
        file,
        pr: bundle.pr,
        run: bundle.run,
        descriptor: {
          path: descriptor.path,
          entity: descriptor.entity,
          name: descriptor.name,
          kind: descriptor.kind,
          change: descriptor.change,
          testFile: descriptor.testFile,
        },
        unit: { index: unit, of: byKey.size, implementationKey: key, deployments: group.deployments },
        head: descriptor.head,
        base: descriptor.base,
        formats: descriptor.formats,
        recommendations: descriptor.recommendations,
        calldataFormats: calldataFormats(descriptor.head),
        cases: pruneCases(descriptor.cases),
        contracts: group.contracts,
      };
      cap(input);
      fs.writeFileSync(path.join(outDir, file), JSON.stringify(input, null, 2));
      index.push({
        file,
        descriptor: descriptor.path,
        unit,
        deployments: group.deployments.length,
        contracts: group.contracts.length,
        unverified: group.contracts.filter((c) => c.match === null).length,
        bytes: bytesOf(input),
        dropped: input.dropped.length,
      });
      console.log(`${file}: ${group.deployments.length} deployment(s), ${group.contracts.length} contract(s), ${bytesOf(input)} bytes`);
      unit++;
    }
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ pr: bundle.pr, run: bundle.run, units: index }, null, 2));
  console.log(`${index.length} input(s) in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
