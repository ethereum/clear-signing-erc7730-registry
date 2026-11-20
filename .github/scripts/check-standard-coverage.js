#!/usr/bin/env node
/**
 * Checks that a calldata descriptor covers the token and vault standards that
 * its contract implements (Rule 1), and warns about a descriptor for a plain
 * token (Rule 2). See the "Standard functions" section of README.md.
 *
 * For each deployment of a calldata descriptor, the script gets the verified
 * ABI from Sourcify, and the ABI of each implementation when the contract is
 * a proxy. A contract implements a standard when its ABI has the full
 * function set of the standard (STANDARDS below). Then:
 *
 * - ERC-20, ERC-4626, ERC-721, ERC-7540: the descriptor after "includes" has
 *   a format for each function of the related ercs/ file. An error if not.
 * - ERC-7540: the formats of the functions that ERC-7540 gives another
 *   meaning (claims) are not the ERC-4626 formats. An error if not.
 * - ERC-2612 and DAI permit: an eip712-*.json descriptor of the registry
 *   lists the deployment and has the Permit format. An error if not.
 * - A descriptor that writes the functions of a standard itself, without
 *   the ercs/ file in its includes: a warning.
 * - Rule 2: a changed descriptor that has only standard token functions: a
 *   warning. The reviewer decides with docs/REVIEWING.md.
 *
 * A deployment without a verified ABI on Sourcify requires no standard: the
 * check never fails without a fact. EIP-712 descriptors are not checked.
 *
 * Usage: node check-standard-coverage.js <descriptor.json|directory>...
 *
 * Environment:
 *   SOURCIFY_TOKEN   optional, raises the Sourcify rate limit
 *   SOURCIFY_URL     default https://sourcify.dev/server
 *   CHANGED_FILES    optional, whitespace-separated repo-relative paths. When
 *                    set, Rule 2 looks only at the descriptors in the list.
 *
 * Exceptions are in .github/standard-coverage-exceptions.json. Prints GitHub
 * Actions annotations, and exits 1 when a descriptor has an error.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { resolveDescriptor } = require('./resolve-erc7730-includes');
const { selectorOf, reason } = require('./check-selector-coverage');
const { includeClosure } = require('./list-affected-descriptors');

const repoRoot = process.cwd();
const SOURCIFY_URL = (process.env.SOURCIFY_URL || 'https://sourcify.dev/server').replace(/\/$/, '');
const SOURCIFY_TOKEN = process.env.SOURCIFY_TOKEN || '';
const EXCEPTIONS_FILE = '.github/standard-coverage-exceptions.json';
const EXCLUDED_DIRS = new Set(['tests', 'testsv2', 'sigs']);

const HELP = `See "Standard functions" in README.md. For a real exception, add an entry to ${EXCEPTIONS_FILE} in a separate pull request.`;
const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/');
const ercs = (name) => path.join(repoRoot, 'ercs', name);

// --- Standards ---------------------------------------------------------------

const ERC20_FUNCTIONS = [
  'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)',
  'balanceOf(address)', 'totalSupply()', 'allowance(address,address)',
];

/**
 * "functions": the ABI must have all of them. "file": the ercs/ file whose
 * own formats (not the included ones) the descriptor must cover. ERC-4626
 * and ERC-7540 do not list the ERC-20 set: an ERC-7575 vault can have its
 * share token in another contract, and then ERC-20 is not on the vault.
 */
const STANDARDS = [
  { id: 'ERC-20', file: 'calldata-erc20-tokens.json', functions: ERC20_FUNCTIONS },
  {
    id: 'ERC-4626',
    file: 'calldata-erc4626-erc20-vaults.json',
    // The legacy file has the same four formats, without ERC-20.
    aliases: ['calldata-erc4626-vaults.json'],
    functions: [
      'asset()', 'totalAssets()', 'convertToShares(uint256)', 'deposit(uint256,address)',
      'mint(uint256,address)', 'withdraw(uint256,address,address)', 'redeem(uint256,address,address)',
    ],
  },
  {
    id: 'ERC-721',
    file: 'calldata-erc721-nfts.json',
    functions: [
      'ownerOf(uint256)', 'safeTransferFrom(address,address,uint256)',
      'safeTransferFrom(address,address,uint256,bytes)', 'setApprovalForAll(address,bool)', 'getApproved(uint256)',
    ],
  },
  {
    id: 'ERC-7540 deposit',
    file: 'calldata-erc7540Deposit-vaults.json',
    aliases: ['calldata-erc7540-vaults.json'],
    functions: ['requestDeposit(uint256,address,address)', 'pendingDepositRequest(uint256,address)', 'setOperator(address,bool)'],
    // ERC-7540 gives these ERC-4626 selectors another meaning: a claim.
    claims: ['deposit(uint256,address)', 'mint(uint256,address)'],
  },
  {
    id: 'ERC-7540 redeem',
    file: 'calldata-erc7540Redeem-vaults.json',
    aliases: ['calldata-erc7540-vaults.json'],
    functions: ['requestRedeem(uint256,address,address)', 'pendingRedeemRequest(uint256,address)', 'setOperator(address,bool)'],
    claims: ['withdraw(uint256,address,address)', 'redeem(uint256,address,address)'],
  },
];

const PERMITS = [
  {
    id: 'ERC-2612 permit',
    file: 'eip712-erc2612-permit.json',
    functions: ['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'nonces(address)', 'DOMAIN_SEPARATOR()'],
  },
  {
    id: 'DAI permit',
    file: path.join('..', 'registry', 'permit', 'common-dai-permit.json'),
    functions: ['permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)', 'nonces(address)', 'DOMAIN_SEPARATOR()'],
  },
];

/** Selectors of a plain token: Rule 2 flags a descriptor that has only these. */
const TOKEN_SELECTORS = new Set(
  [
    ...ERC20_FUNCTIONS.slice(0, 3),
    'increaseAllowance(address,uint256)', 'decreaseAllowance(address,uint256)',
    'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)',
    'setApprovalForAll(address,bool)',
  ].map(selectorOf),
);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const formatsOf = (doc) => doc.display?.formats ?? {};

/** Selector -> format key, for the formats of a document. Bad keys are skipped. */
function selectorMap(formats) {
  const out = new Map();
  for (const key of Object.keys(formats)) {
    try {
      out.set(selectorOf(key), key);
    } catch {
      // check-selector-coverage.js reports a bad key.
    }
  }
  return out;
}

/** The ercs/ files, read once: own formats, resolved formats, primary types. */
function loadTemplates() {
  const templates = {};
  for (const s of [...STANDARDS, ...PERMITS]) {
    const abs = ercs(s.file);
    templates[s.id] = {
      file: rel(abs),
      aliases: (s.aliases ?? []).map((a) => rel(ercs(a))),
      own: selectorMap(formatsOf(readJson(abs))),
      ownKeys: Object.keys(formatsOf(readJson(abs))),
      resolved: formatsOf(resolveDescriptor(abs)),
    };
  }
  // The plain ERC-4626 formats, which ERC-7540 claims must not reuse.
  templates.plain4626 = formatsOf(readJson(ercs('calldata-erc4626-erc20-vaults.json')));
  return templates;
}

/** Whitespace-free EIP-712 encodeType, so that key formatting does not matter. */
const encodeTypeKey = (key) => key.replace(/\s+/g, '');

// --- Sourcify ----------------------------------------------------------------

const cache = new Map();
let pauseUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Sourcify response for a contract, null when it is not verified. */
function sourcify(chainId, address) {
  const key = `${chainId}:${address.toLowerCase()}`;
  if (!cache.has(key)) cache.set(key, fetchContract(chainId, address));
  return cache.get(key);
}

async function fetchContract(chainId, address) {
  const url = `${SOURCIFY_URL}/v2/contract/${chainId}/${address}?fields=abi,proxyResolution`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let res;
    try {
      res = await fetch(url, { headers: SOURCIFY_TOKEN ? { 'X-Sourcify-Token': SOURCIFY_TOKEN } : {} });
    } catch (error) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      pauseUntil = Date.now() + 2000 * 2 ** attempt;
      continue;
    }
    if (!res.ok) return null;
    return res.json();
  }
  throw new Error(`no answer from Sourcify for ${chainId}:${address}`);
}

/**
 * The normalized function signatures of a deployment: its own ABI and the
 * ABI of each implementation. Null when no ABI is verified.
 */
async function functionsOf(chainId, address) {
  const contract = await sourcify(chainId, address);
  if (!contract?.abi) return null;
  const abis = [contract.abi];
  for (const impl of contract.proxyResolution?.implementations ?? []) {
    const implContract = await sourcify(chainId, impl.address);
    if (!implContract?.abi) return null; // A proxy without its implementation ABI tells nothing.
    abis.push(implContract.abi);
  }
  const out = new Set();
  for (const entry of abis.flat()) {
    if (entry?.type === 'function') out.add(`${entry.name}(${(entry.inputs ?? []).map(canonicalType).join(',')})`);
  }
  return out;
}

function canonicalType(input) {
  if (!input.type.startsWith('tuple')) return input.type;
  return `(${(input.components ?? []).map(canonicalType).join(',')})${input.type.slice('tuple'.length)}`;
}

// --- Permit index ------------------------------------------------------------

/** "chainId:address" -> Set of EIP-712 encodeType keys, over the whole registry. */
function permitIndex() {
  const index = new Map();
  for (const file of collect(path.join(repoRoot, 'registry'), [], /^eip712-.*\.json$/)) {
    let doc;
    try {
      doc = resolveDescriptor(file);
    } catch {
      continue; // The index check reports a broken file.
    }
    const types = Object.keys(formatsOf(doc)).map(encodeTypeKey);
    for (const d of doc.context?.eip712?.deployments ?? []) {
      const key = `${d.chainId}:${String(d.address).toLowerCase()}`;
      if (!index.has(key)) index.set(key, new Set());
      for (const t of types) index.get(key).add(t);
    }
  }
  return index;
}

// --- Check -------------------------------------------------------------------

function collect(target, out, pattern = /^calldata-.*\.json$/) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collect(full, out, pattern);
    } else if (pattern.test(entry.name) && !entry.name.endsWith('.tests.json')) {
      out.push(full);
    }
  }
  return out;
}

function loadExceptions() {
  const file = path.join(repoRoot, EXCEPTIONS_FILE);
  if (!fs.existsSync(file)) return [];
  return readJson(file).exceptions ?? [];
}

/** True when the exceptions file allows this missing item for this descriptor. */
function excepted(exceptions, descriptor, item) {
  return exceptions.some((e) => e.descriptor === descriptor && (e.missing ?? []).includes(item));
}

/**
 * The findings of one descriptor: { errors, warnings, notices }, or null when
 * it is not a calldata descriptor with deployments.
 */
async function checkDescriptor(abs, ctx) {
  const descriptor = rel(abs);
  const errors = [];
  const warnings = [];
  const notices = [];

  let merged;
  try {
    merged = resolveDescriptor(abs);
  } catch (error) {
    return { errors: [`Cannot read the descriptor: ${error.message}`], warnings, notices };
  }
  const deployments = merged.context?.contract?.deployments ?? [];
  if (deployments.length === 0) return null;

  const formats = formatsOf(merged);
  const selectors = selectorMap(formats);
  const closure = includeClosure(abs);

  // Rule 2: only standard token functions. Vaults have other functions.
  const rule2 = !ctx.changed || ctx.changed.has(descriptor);
  if (rule2 && selectors.size > 0 && [...selectors.keys()].every((s) => TOKEN_SELECTORS.has(s))) {
    warnings.push(
      'This descriptor has only standard token functions. The registry does not take descriptors for plain ERC-20 or ERC-721 tokens: wallets build them on the fly from their trusted token list (sourcifyeth/clear-signing#16). Keep it only if it changes the display of a standard function for a clear reason. See "Standard functions" in README.md.',
    );
  }

  const found = new Map(); // standard id -> deployments that implement it
  let checked = 0;
  for (const { chainId, address } of deployments) {
    const where = `${chainId}:${address}`;
    let functions;
    try {
      functions = await functionsOf(chainId, address);
    } catch (error) {
      notices.push(`${where}: ${error.message}. The check requires no standard for this deployment.`);
      continue;
    }
    if (!functions) {
      notices.push(`${where}: no verified ABI on Sourcify. The check requires no standard for this deployment.`);
      continue;
    }
    checked++;
    for (const s of [...STANDARDS, ...PERMITS]) {
      if (s.functions.every((f) => functions.has(f))) {
        if (!found.has(s.id)) found.set(s.id, []);
        found.get(s.id).push(where);
      }
    }
  }

  for (const s of STANDARDS) {
    const where = found.get(s.id);
    if (!where) continue;
    const template = ctx.templates[s.id];
    const missing = [...template.own].filter(([selector]) => !selectors.has(selector));
    const missingNow = missing.filter(([, key]) => !excepted(ctx.exceptions, descriptor, normalize(key)));
    if (missingNow.length > 0) {
      // A vault gets ERC-20 from the vault file, not from the token file.
      const vault = found.has('ERC-4626') && s.id === 'ERC-20' ? ctx.templates['ERC-4626'].file : null;
      errors.push(
        `The contract implements ${s.id} (${where.join(', ')}), but the descriptor has no format for: ${missingNow.map(([sel, key]) => `${normalize(key)} (${sel})`).join(', ')}. Include ${vault ?? template.file}, or include it through your common file. ${HELP}`,
      );
    }
    for (const claim of s.claims ?? []) {
      const selector = selectorOf(claim);
      const key = selectors.get(selector);
      const plainKey = [...Object.keys(ctx.templates.plain4626)].find((k) => selectorOf(k) === selector);
      if (key && plainKey && isDeepStrictEqual(formats[key], ctx.templates.plain4626[plainKey])
          && !excepted(ctx.exceptions, descriptor, claim)) {
        errors.push(
          `The contract implements ${s.id} (${where.join(', ')}), and ${claim} claims a request there. The descriptor shows it with the ERC-4626 format, which does not say that. Include ${template.file}, or override the format. ${HELP}`,
        );
      }
    }
    const includesTemplate = [template.file, ...template.aliases].some((f) => closure.has(f));
    if (!includesTemplate && missing.length === 0) {
      warnings.push(
        `The descriptor writes the ${s.id} formats itself, but does not include ${template.file}. Include the file unless the formats change the display for a clear reason.`,
      );
    }
  }

  for (const p of PERMITS) {
    const where = found.get(p.id);
    if (!where) continue;
    const template = ctx.templates[p.id];
    const types = template.ownKeys.map(encodeTypeKey);
    const uncovered = where.filter((w) => {
      const have = ctx.permits.get(w.toLowerCase());
      return !have || !types.every((t) => have.has(t));
    });
    if (uncovered.length > 0 && !excepted(ctx.exceptions, descriptor, 'Permit')) {
      errors.push(
        `The contract implements ${p.id} (${uncovered.join(', ')}), but no eip712-*.json descriptor of the registry lists this deployment with the ${template.ownKeys.join(', ')} format. Add an eip712-*.json file in your entity folder that includes ${template.file} and sets the domain of the token. ${HELP}`,
      );
    }
  }

  if (checked === 0) notices.push('No deployment has a verified ABI on Sourcify, so no standard was checked.');
  return { errors, warnings, notices };
}

/** The canonical signature of a format key, for messages and exceptions. */
function normalize(key) {
  const { parseAbiItem } = require('viem');
  const item = parseAbiItem(`function ${key.trim()}`);
  return `${item.name}(${item.inputs.map(canonicalType).join(',')})`;
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('Usage: node check-standard-coverage.js <descriptor.json|directory>...\n');
    process.exit(2);
  }
  const changedList = (process.env.CHANGED_FILES || '').split(/\s+/).filter(Boolean);
  const ctx = {
    templates: loadTemplates(),
    permits: permitIndex(),
    exceptions: loadExceptions(),
    changed: changedList.length > 0 ? new Set(changedList.map((f) => f.replace(/^\.\//, ''))) : null,
  };

  const descriptors = [...new Set(targets.flatMap((t) => collect(path.resolve(t), [])))]
    .filter((f) => /^calldata-/.test(path.basename(f)))
    .sort();

  let failed = 0;
  let checked = 0;
  for (const abs of descriptors) {
    const descriptor = rel(abs);
    let result;
    try {
      result = await checkDescriptor(abs, ctx);
    } catch (error) {
      result = { errors: [], warnings: [], notices: [`Check not run: ${reason(error)}`] };
    }
    if (result === null) {
      console.log(`⏭️ ${descriptor} (no deployments)`);
      continue;
    }
    checked++;
    for (const m of result.notices) console.log(`::notice file=${descriptor},line=1::${m}`);
    for (const m of result.warnings) console.log(`::warning file=${descriptor},line=1::${m}`);
    for (const m of result.errors) console.log(`::error file=${descriptor},line=1::${m}`);
    if (result.errors.length > 0) failed++;
    else console.log(`✅ ${descriptor}`);
  }

  const summary = `${failed} of ${checked} descriptor(s) do not cover the standards of their contract.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY && failed > 0) {
    // GitHub shows 10 annotations per step, so give the total as well.
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary} See the log for the full list.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

module.exports = { STANDARDS, PERMITS, checkDescriptor };
