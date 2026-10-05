#!/usr/bin/env node
/**
 * Builds the inputs of the AI review from a test report bundle: one JSON file
 * per review unit, where a unit is a descriptor together with one distinct
 * implementation source. Deployments that share a source are reviewed once.
 *
 * Usage: node collect.js --bundle <file> --out <dir> [--max-bytes <n>]
 *
 * Environment: SOURCIFY_TOKEN (optional), SOURCIFY_URL (default
 * https://sourcify.dev/server).
 *
 * Writes <out>/inputs/<entity>__<name>__<unit>.json and <out>/inputs/index.json.
 * An input holds the descriptor, its test cases and results from the bundle,
 * and for every contract of the unit the verified sources, the ABI, the
 * NatSpec, the proxy resolution and the decoded constructor arguments from
 * Sourcify, limited to the files the deployed code was compiled from (per the
 * compiler's source maps) and to the ABI and NatSpec of the functions the
 * descriptor covers. Everything in it comes from the pull request or from
 * Sourcify and is data for the model, never code to run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');
const { decodeAbiParameters } = require('viem');

const SOURCIFY_URL = (process.env.SOURCIFY_URL || 'https://sourcify.dev/server').replace(/\/$/, '');
const SOURCIFY_TOKEN = process.env.SOURCIFY_TOKEN || '';
const CONCURRENCY = 2;
// The fields the collector reads; `match` comes by default. `fields=all` would
// also bring the compiler input and output, the bytecodes, the metadata and
// the storage layout, four times as much for nothing.
const FIELDS = [
  'compilation', 'deployment', 'proxyResolution', 'abi', 'devdoc', 'userdoc', 'sources', 'sourceIds',
  'runtimeBytecode.sourceMap', 'runtimeBytecode.transformationValues',
  'creationBytecode.sourceMap', 'creationBytecode.transformationValues',
].join(',');
// The most a review unit may weigh, about 200K tokens. A unit above it is not
// reviewed, and the review fails for it: nothing is trimmed to make it fit.
let MAX_BYTES = 600_000;

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
      const res = await fetch(`${SOURCIFY_URL}/v2/contract/${chainId}/${address}?fields=${FIELDS}`, {
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
    ...sourcesOf(response),
  };
}

/**
 * The source files the deployed code was compiled from, plus the files of
 * the contracts that code creates, and how many of the verified files were
 * left out (interfaces, unused files). Without a source map, which a match
 * should always have, every file stays.
 */
function sourcesOf(response) {
  const all = Object.fromEntries(Object.entries(response.sources ?? {}).map(([p, s]) => [p, s.content]));
  const code = codeFilesOf(response);
  const main = response.compilation?.fullyQualifiedName?.split(':')[0];
  const kept = code ? Object.keys(all).filter((p) => p === main || code.includes(p)) : Object.keys(all);
  for (const p of createdContractFiles(kept, all)) kept.push(p);
  return {
    sources: Object.fromEntries(kept.map((p) => [p, all[p]])),
    omittedSources: Object.keys(all).length - kept.length,
  };
}

/**
 * The files of the contracts that the kept files create with `new X(...)`,
 * `new X{value: v}(...)` or `type(X).creationCode` / `runtimeCode`. The
 * compiler emits that code as a sub-object with its own source map, which
 * Sourcify does not return, so the source maps of the creator leave these
 * files out. Only names declared as a contract in the verified sources
 * count, so `new uint256[](n)` does not. Followed until nothing new appears.
 */
function createdContractFiles(kept, all) {
  const creates = /\bnew\s+([A-Za-z_$][\w$]*)\s*(?:\{[^}]*\})?\s*\(|\btype\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*(?:creationCode|runtimeCode)\b/g;
  // A declaration starts a line; a comment or a string that names the contract does not count.
  const declares = (name) => new RegExp(`^\\s*(?:abstract\\s+)?contract\\s+${name.replace(/[$]/g, '\\$&')}\\b`, 'm');
  const added = [];
  const queue = [...kept];
  while (queue.length > 0) {
    const content = all[queue.shift()];
    for (const m of content.matchAll(creates)) {
      const pattern = declares(m[1] ?? m[2]);
      for (const file of Object.keys(all).filter((p) => pattern.test(all[p]))) {
        if (kept.includes(file) || added.includes(file)) continue;
        added.push(file);
        queue.push(file);
      }
    }
  }
  return added;
}

/**
 * The source files the deployed code was compiled from, or null when the
 * response has no source map.
 *
 * The compiler numbers the input files (Sourcify's sourceIds, path to id) and
 * writes a source map for the bytecode: one entry per instruction, in the
 * form "start:length:fileId:jump:depth", where a field left empty repeats the
 * previous entry's. The file ids that occur in the runtime and the creation
 * source maps are the files whose code is on chain; -1 is compiler-generated
 * code with no file. Sourcify keeps both maps from the compilation that
 * matched the on-chain bytecode, so they describe the deployed code exactly.
 */
function codeFilesOf(response) {
  const byId = new Map(Object.entries(response.sourceIds ?? {}).map(([path, s]) => [s.id, path]));
  const maps = [response.runtimeBytecode?.sourceMap, response.creationBytecode?.sourceMap].filter(Boolean);
  if (byId.size === 0 || maps.length === 0) return null;
  const files = new Set();
  for (const map of maps) {
    let id = null;
    for (const entry of map.split(';')) {
      const field = entry.split(':')[2];
      if (field !== undefined && field !== '') id = Number(field);
      if (id !== null && byId.has(id)) files.add(byId.get(id));
    }
  }
  return [...files];
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
// The descriptor side: test cases and embedded calldata formats
// ---------------------------------------------------------------------------

/**
 * Every test case holds the expected screen and, per runner, the rendered
 * one. When the runner passed they are the same screen, so the rendered copy
 * is dropped. It stays when the runner failed or the two differ.
 */
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
// Focus: the ABI entries and the NatSpec of the reviewed functions only
// ---------------------------------------------------------------------------

/** The function names (calldata) or primary types (eip712) of the format keys. */
function namesOf(head) {
  return [...new Set(Object.keys(head?.display?.formats ?? {}).map((k) => k.split('(')[0].trim()).filter(Boolean))];
}

/** The file the contract itself is declared in, from "path/File.sol:Name". */
function mainFileOf(contract) {
  return contract.fullyQualifiedName ? contract.fullyQualifiedName.split(':')[0] : null;
}

/** Keeps the ABI entries of the named functions and the NatSpec of those entries. */
function trimAbiAndDocs(contract, names, kind) {
  const lower = names.map((n) => n.toLowerCase());
  const keepAbi = (e) => e.type === 'function' && (kind === 'eip712'
    ? lower.some((n) => e.name.toLowerCase().includes(n)) || /typehash|separator|eip712|nonces/i.test(e.name)
    : names.includes(e.name));
  const abi = (contract.abi ?? []).filter(keepAbi);
  contract.abi = abi.length > 0 ? abi : contract.abi;
  const keepDoc = (doc) => {
    if (!doc) return doc;
    const { methods, stateVariables, events, errors, ...rest } = doc;
    const kept = Object.fromEntries(Object.entries(methods ?? {}).filter(([sig]) => (contract.abi ?? []).some((e) => sig.startsWith(`${e.name}(`))));
    return { ...rest, methods: kept };
  };
  contract.devdoc = keepDoc(contract.devdoc);
  contract.userdoc = keepDoc(contract.userdoc);
}

/** A proxy in front of an implementation: its main file only, no ABI or NatSpec. */
function focusProxy(contract) {
  const main = mainFileOf(contract);
  contract.omittedSources += Object.keys(contract.sources ?? {}).length - (main && contract.sources?.[main] ? 1 : 0);
  contract.sources = main && contract.sources?.[main] ? { [main]: contract.sources[main] } : {};
  contract.abi = null;
  contract.devdoc = null;
  contract.userdoc = null;
}

function focus(input) {
  const names = namesOf(input.head);
  const proxied = input.contracts.some((c) => c.role === 'implementation');
  for (const c of input.contracts) {
    if (c.match === null) continue;
    if (proxied && c.role === 'deployment') focusProxy(c);
    else trimAbiAndDocs(c, names, input.descriptor.kind);
  }
}

function bytesOf(input) {
  return Buffer.byteLength(JSON.stringify(input));
}

// ---------------------------------------------------------------------------
// Main: one input per descriptor and distinct implementation
// ---------------------------------------------------------------------------

/** The review units of one bundle descriptor: its deployments grouped by implementation source. */
async function unitsOf(descriptor) {
  // All deployments at once; the Sourcify limiter above keeps two requests in flight.
  const deployments = deploymentsOf(descriptor.head);
  const fetched = await Promise.all(deployments.map(contractsOf));
  const byKey = new Map();
  deployments.forEach((deployment, i) => {
    const contracts = fetched[i];
    const key = implementationKey(contracts);
    if (!byKey.has(key)) byKey.set(key, { key, deployments: [], contracts });
    byKey.get(key).deployments.push(deployment);
  });
  return [...byKey.values()];
}

function inputOf(bundle, descriptor, group, unit, of) {
  const input = {
    schemaVersion: 1,
    file: `${descriptor.entity}__${descriptor.name}__${unit}.json`,
    pr: bundle.pr ?? null,
    run: bundle.run ?? null,
    descriptor: {
      path: descriptor.path,
      entity: descriptor.entity,
      name: descriptor.name,
      kind: descriptor.kind,
      change: descriptor.change ?? null,
      testFile: descriptor.testFile ?? null,
    },
    unit: { index: unit, of, implementationKey: group.key, deployments: group.deployments },
    head: descriptor.head,
    base: descriptor.base ?? null,
    formats: descriptor.formats ?? null,
    recommendations: descriptor.recommendations ?? [],
    calldataFormats: calldataFormats(descriptor.head),
    cases: pruneCases(descriptor.cases),
    contracts: group.contracts,
  };
  focus(input);
  return input;
}

async function collect(bundle, out, maxBytes = MAX_BYTES) {
  const outDir = path.join(out, 'inputs');
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const descriptor of bundle.descriptors ?? []) {
    if (!descriptor.head) continue;
    const units = await unitsOf(descriptor);
    units.forEach((group, unit) => {
      const input = inputOf(bundle, descriptor, group, unit, units.length);
      fs.writeFileSync(path.join(outDir, input.file), JSON.stringify(input, null, 2));
      const bytes = bytesOf(input);
      index.push({
        file: input.file,
        descriptor: descriptor.path,
        change: descriptor.change?.descriptor ?? null,
        unit,
        deployments: group.deployments.length,
        contracts: group.contracts.length,
        unverified: group.contracts.filter((c) => c.match === null).length,
        bytes,
        tooLarge: bytes > maxBytes,
      });
      if (bytes > maxBytes) warn(`${input.file}: ${bytes} bytes, above the limit of ${maxBytes}; it will not be reviewed`);
      console.log(`${input.file}: ${group.deployments.length} deployment(s), ${group.contracts.length} contract(s), ${bytes} bytes`);
    });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ pr: bundle.pr ?? null, run: bundle.run ?? null, maxBytes, units: index }, null, 2));
  console.log(`${index.length} input(s) in ${outDir}`);
}

module.exports = { sourcify, unitsOf, inputOf, collect, deploymentsOf, calldataFormats, pruneCases, focus, bytesOf };

if (require.main === module) {
  const { values: opts } = parseArgs({
    options: {
      bundle: { type: 'string' },
      out: { type: 'string', default: 'ai-review' },
      'max-bytes': { type: 'string', default: String(MAX_BYTES) },
    },
  });
  if (!opts.bundle) {
    console.error('usage: collect.js --bundle <file> --out <dir> [--max-bytes <n>]');
    process.exit(1);
  }
  MAX_BYTES = Number(opts['max-bytes']);
  collect(JSON.parse(fs.readFileSync(opts.bundle, 'utf8')), opts.out, MAX_BYTES).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
