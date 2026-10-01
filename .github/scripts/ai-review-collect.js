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
 * Sourcify, focused on the functions the descriptor covers: the files that
 * define them, their base contracts, one level of callees, and the ABI and
 * NatSpec of those functions. Everything in it comes from the pull request or
 * from Sourcify and is data for the model, never code to run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');
const { decodeAbiParameters } = require('viem');

const SOURCIFY_URL = (process.env.SOURCIFY_URL || 'https://sourcify.dev/server').replace(/\/$/, '');
const SOURCIFY_TOKEN = process.env.SOURCIFY_TOKEN || '';
const CONCURRENCY = 2;
let MAX_BYTES = 400_000;

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
// Focus: keep the source files, ABI entries and NatSpec of the reviewed functions
// ---------------------------------------------------------------------------

const RANKS = Symbol('source ranks');
const ENTRY = 0, BASE = 1, CALLEE = 2;

/** The function names (calldata) or primary types (eip712) of the format keys. */
function namesOf(head) {
  return [...new Set(Object.keys(head?.display?.formats ?? {}).map((k) => k.split('(')[0].trim()).filter(Boolean))];
}

/** Top-level Solidity declarations of a file: kind, name, base contracts. */
function declarationsOf(content) {
  const out = [];
  const re = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][\w$]*)(?:\s+is\s+([^{]+))?\s*\{/g;
  for (let m; (m = re.exec(content)); ) {
    out.push({ kind: m[1].startsWith('abstract') ? 'abstract contract' : m[1], name: m[2], bases: (m[3] ?? '').split(',').map((b) => b.trim().split(/[\s(]/)[0]).filter(Boolean) });
  }
  return out;
}

/** Whether the file defines a function of that name with a body (Solidity) or at all (Vyper). */
function definesFunction(content, name) {
  const re = new RegExp(`\\b(function|def)\\s+${name}\\s*\\(`, 'g');
  for (let m; (m = re.exec(content)); ) {
    if (m[1] === 'def') return true;
    const rest = content.slice(m.index, m.index + 4000);
    const brace = rest.indexOf('{');
    const semi = rest.indexOf(';');
    if (brace >= 0 && (semi < 0 || brace < semi)) return true;
  }
  return false;
}

/** Whether the file takes part in EIP-712 hashing of that primary type. */
function hashesType(content, name) {
  return content.includes(`"${name}(`) || content.includes(`'${name}(`) || new RegExp(`\\b${name.toUpperCase()}_TYPEHASH\\b`).test(content) || definesFunction(content, name.charAt(0).toLowerCase() + name.slice(1));
}

/** A large library that can move no value: no calls, no transfers, no self-destruct, no storage writes in assembly. */
function isPureLibrary(file) {
  return file.content.length > 4000 && file.decls.length > 0 && file.decls.every((d) => d.kind === 'library')
    && !/\b(call|delegatecall|staticcall|callcode|selfdestruct|create|create2)\s*\(|\.(transfer|send|transferFrom|approve|safeTransfer|safeTransferFrom)\s*\(|\bsstore\b/.test(file.content);
}

/** The file the contract itself is declared in, from "path/File.sol:Name". */
function mainFileOf(contract) {
  return contract.fullyQualifiedName ? contract.fullyQualifiedName.split(':')[0] : null;
}

/**
 * The source files of a contract, each with its top-level declarations. The
 * same content under several paths counts once: the main file wins, then the
 * first path.
 */
function distinctFiles(contract) {
  const main = mainFileOf(contract);
  const mainFirst = ([a], [b]) => (a === main ? -1 : b === main ? 1 : 0);
  const seen = new Set();
  const files = [];
  for (const [path, content] of Object.entries(contract.sources ?? {}).sort(mainFirst)) {
    const digest = crypto.createHash('sha256').update(content.replace(/\s+/g, '')).digest('hex');
    if (seen.has(digest)) continue;
    seen.add(digest);
    const decls = declarationsOf(content);
    files.push({ path, content, decls, interfaceOnly: decls.length > 0 && decls.every((d) => d.kind === 'interface') });
  }
  return files;
}

/** Which file declares each contract, library or interface name. */
function fileByDeclaration(files) {
  const byName = new Map();
  for (const f of files) for (const d of f.decls) if (!byName.has(d.name)) byName.set(d.name, f);
  return byName;
}

/** The names a file calls or uses: `Name.member`, `Name(...)`, `using Name for ...`. */
function namesUsedIn(content) {
  const names = [];
  const re = /\b([A-Z][\w$]*)\s*[.(]|\busing\s+([A-Z][\w$]*)\b/g;
  for (let m; (m = re.exec(content)); ) names.push(m[1] ?? m[2]);
  return names;
}

/**
 * Decides which source files of a contract the model gets.
 *
 * A verified contract comes with every file of its compilation: the contract
 * itself, what it inherits from, the libraries it uses, interfaces, and often
 * unrelated contracts of the same project. Sending all of it costs tokens and
 * buries what matters. So every file gets a rank, and the rest is left out:
 *
 *   ENTRY  (0)  the main file, and every file that defines one of the
 *               reviewed functions (for an EIP-712 descriptor: that takes
 *               part in hashing the signed type).
 *   BASE   (1)  a contract that an ENTRY or BASE file inherits from, found by
 *               following `is` until nothing new appears. Modifiers, state
 *               and helpers of the reviewed functions live there.
 *   CALLEE (2)  a library or contract that a kept file calls or uses, one
 *               level deep. A large library that moves no value is not kept
 *               but listed by name, so the model knows it exists.
 *
 * Interfaces are never kept, except as the main file: the kept files already
 * show how they are called. The ranks also decide what the size cap drops
 * first: callees, then bases, never entries.
 *
 * Returns { ranks: Map<path, rank>, pure: [paths of the libraries left out] }.
 */
function rankSources(contract, names, kind) {
  const files = distinctFiles(contract);
  const byName = fileByDeclaration(files);
  const main = mainFileOf(contract);
  const ranks = new Map();

  // 1. Entries: the main file, and the files that define the reviewed functions.
  const defines = (file) => names.some((n) => (kind === 'eip712' ? hashesType(file.content, n) : definesFunction(file.content, n)));
  for (const file of files) {
    if (file.path !== main && (file.interfaceOnly || !defines(file))) continue;
    ranks.set(file.path, ENTRY);
  }

  // 2. Base contracts: what the kept files inherit from, and what those inherit from, and so on.
  const queue = [...ranks.keys()];
  while (queue.length > 0) {
    const current = queue.shift();
    const file = files.find((f) => f.path === current);
    for (const decl of file.decls) {
      for (const baseName of decl.bases) {
        const base = byName.get(baseName);
        if (!base || base.interfaceOnly || ranks.has(base.path)) continue;
        ranks.set(base.path, BASE);
        queue.push(base.path);
      }
    }
  }

  // 3. Callees: the libraries and contracts the kept files use, one level deep.
  const pure = [];
  for (const file of files.filter((f) => ranks.has(f.path))) {
    for (const name of namesUsedIn(file.content)) {
      const callee = byName.get(name);
      if (!callee || callee.interfaceOnly || ranks.has(callee.path) || pure.includes(callee.path)) continue;
      if (isPureLibrary(callee)) pure.push(callee.path);
      else ranks.set(callee.path, CALLEE);
    }
  }
  return { ranks, pure };
}

/** Trims a contract to what the review of the named functions needs. */
function focusContract(contract, names, kind) {
  const { ranks, pure } = rankSources(contract, names, kind);
  const kept = [...ranks.entries()].sort((a, b) => a[1] - b[1]);
  contract.omittedSources = Object.keys(contract.sources ?? {}).length - kept.length;
  contract.omittedPureLibraries = pure;
  contract.sources = Object.fromEntries(kept.map(([p]) => [p, contract.sources[p]]));
  contract[RANKS] = ranks;

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
  const main = contract.fullyQualifiedName ? contract.fullyQualifiedName.split(':')[0] : null;
  contract.omittedSources = Object.keys(contract.sources ?? {}).length - (main && contract.sources?.[main] ? 1 : 0);
  contract.sources = main && contract.sources?.[main] ? { [main]: contract.sources[main] } : {};
  contract[RANKS] = new Map(Object.keys(contract.sources).map((p) => [p, ENTRY]));
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
    else focusContract(c, names, input.descriptor.kind);
  }
}

// ---------------------------------------------------------------------------
// Size cap: drop callees before base contracts, largest first, never an entry file
// ---------------------------------------------------------------------------

function bytesOf(input) {
  return Buffer.byteLength(JSON.stringify(input));
}

function cap(input, maxBytes = MAX_BYTES) {
  input.dropped = [];
  while (bytesOf(input) > maxBytes) {
    let victim = null;
    for (const c of input.contracts) {
      for (const [p, content] of Object.entries(c.sources ?? {})) {
        const rank = c[RANKS]?.get(p) ?? CALLEE;
        if (rank === ENTRY) continue;
        if (!victim || rank > victim.rank || (rank === victim.rank && content.length > victim.bytes)) victim = { contract: c, path: p, rank, bytes: content.length };
      }
    }
    if (!victim) break;
    delete victim.contract.sources[victim.path];
    input.dropped.push({ chainId: victim.contract.chainId, address: victim.contract.address, path: victim.path, bytes: victim.bytes });
  }
  if (input.dropped.length > 0 || bytesOf(input) > maxBytes) {
    warn(`${input.file}: ${input.dropped.length} source file(s) dropped, ${bytesOf(input)} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Main: one input per descriptor and distinct implementation
// ---------------------------------------------------------------------------

/** The review units of one bundle descriptor: its deployments grouped by implementation source. */
async function unitsOf(descriptor) {
  const byKey = new Map();
  for (const deployment of deploymentsOf(descriptor.head)) {
    const contracts = await contractsOf(deployment);
    const key = implementationKey(contracts);
    if (!byKey.has(key)) byKey.set(key, { key, deployments: [], contracts });
    byKey.get(key).deployments.push(deployment);
  }
  return [...byKey.values()];
}

function inputOf(bundle, descriptor, group, unit, of, maxBytes = MAX_BYTES) {
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
  cap(input, maxBytes);
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
      const input = inputOf(bundle, descriptor, group, unit, units.length, maxBytes);
      fs.writeFileSync(path.join(outDir, input.file), JSON.stringify(input, null, 2));
      index.push({
        file: input.file,
        descriptor: descriptor.path,
        unit,
        deployments: group.deployments.length,
        contracts: group.contracts.length,
        unverified: group.contracts.filter((c) => c.match === null).length,
        bytes: bytesOf(input),
        dropped: input.dropped.length,
      });
      console.log(`${input.file}: ${group.deployments.length} deployment(s), ${group.contracts.length} contract(s), ${bytesOf(input)} bytes`);
    });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ pr: bundle.pr ?? null, run: bundle.run ?? null, units: index }, null, 2));
  console.log(`${index.length} input(s) in ${outDir}`);
}

module.exports = { sourcify, unitsOf, inputOf, collect, deploymentsOf, calldataFormats, pruneCases, focus, cap };

if (require.main === module) {
  const { values: opts } = parseArgs({
    options: {
      bundle: { type: 'string' },
      out: { type: 'string', default: 'ai-review' },
      'max-bytes': { type: 'string', default: String(MAX_BYTES) },
    },
  });
  if (!opts.bundle) {
    console.error('usage: ai-review-collect.js --bundle <file> --out <dir> [--max-bytes <n>]');
    process.exit(1);
  }
  MAX_BYTES = Number(opts['max-bytes']);
  collect(JSON.parse(fs.readFileSync(opts.bundle, 'utf8')), opts.out, MAX_BYTES).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
