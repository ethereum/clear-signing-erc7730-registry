#!/usr/bin/env node
/**
 * Generates the registry index files (index.calldata.json, index.eip712.json)
 * from the descriptors under registry/.
 *
 * The indexes let consumers resolve a descriptor from a (chainId, address)
 * pair — and for EIP-712, an additional primary type — without walking the
 * whole registry. They are published at the repo root and fetched directly by
 * downstream libraries, so a stale index silently breaks clear signing for the
 * affected contracts.
 *
 * Usage: node tools/scripts/generate-index.js [--check|--validate]
 *   default     rewrites both index files in place
 *   --check     exits 1 if the committed files differ from the generated ones
 *   --validate  builds the indexes in memory and exits 1 if that is not
 *               possible — two descriptors claiming one index key, or a
 *               descriptor whose "includes" cannot be resolved. Writes and
 *               compares nothing, so it can run on a pull request, where the
 *               committed index files are still the pre-merge ones (they are
 *               regenerated on master by the sync-indexes workflow).
 */

const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const { resolveDescriptor } = require('../../.github/scripts/resolve-erc7730-includes.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REGISTRY_DIR = path.join(REPO_ROOT, 'registry');
const CALLDATA_INDEX = 'index.calldata.json';
const EIP712_INDEX = 'index.eip712.json';

/**
 * Test fixtures and auditor attestations live alongside descriptors but must
 * never be indexed. Attestation filenames under sigs/ start with the descriptor
 * name they attest (calldata-stETH.eip155-1-0xAbc….json), so they match the
 * descriptor pattern below and would otherwise be parsed as descriptors.
 */
const EXCLUDED_DIRS = new Set(['tests', 'testsv2', 'sigs']);

/**
 * Collects descriptor paths under registry/, repo-relative and sorted.
 *
 * Only calldata-*.json / eip712-*.json files are descriptors. Shared files
 * pulled in via "includes" (common-*.json, *-common-*.json) do not match the
 * prefix and are therefore never indexed in their own right — they only
 * contribute through the descriptors that include them.
 *
 * Sorting matters: it keeps the generated arrays, and the collision messages
 * below, identical from one run to the next.
 */
function findDescriptors(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) findDescriptors(abs, found);
    } else if (
      /^(calldata|eip712)-.*\.json$/.test(entry.name) &&
      !entry.name.endsWith('.tests.json')
    ) {
      found.push(path.relative(REPO_ROOT, abs));
    }
  }
  return found.sort();
}

/** EIP-712 encodeType strings are keyed by "PrimaryType(...)" — take the head. */
function extractPrimaryType(encodeType) {
  const open = encodeType.indexOf('(');
  return open <= 0 ? undefined : encodeType.slice(0, open);
}

function keccak256Hex(str) {
  return `0x${keccak_256(str)}`;
}

function caip(chainId, address) {
  return `eip155:${chainId}:${address.trim().toLowerCase()}`;
}

/**
 * A salt-based EIP-712 domain, EIP712Domain(string name,string version,address
 * verifyingContract,bytes32 salt), carries the chain id in `salt` and has no
 * `chainId` member. Per the specification, an eip712.deployments constraint
 * requires the message to have one, so such a descriptor cannot declare
 * deployments and therefore has no (chainId, address) key. It binds through
 * eip712.domainSeparator instead, so it is keyed by that separator.
 *
 * The prefix keeps these keys disjoint from the eip155: ones, so a consumer
 * that only understands deployment keys skips them rather than mis-resolving.
 */
function domainSeparatorKey(domainSeparator) {
  return `eip712-domain-separator:${domainSeparator.trim().toLowerCase()}`;
}

/**
 * Indexes one already-include-resolved descriptor.
 *
 * Descriptors routinely inherit half their content through "includes" — some
 * declare deployments locally and inherit display.formats, others the reverse —
 * so callers must resolve includes before indexing, or entries go missing.
 */
function indexDescriptor(descriptor, descriptorPath, index) {
  const context = descriptor.context;
  if (!context) return;

  if (context.contract) {
    for (const deployment of context.contract.deployments ?? []) {
      const { chainId, address } = deployment;
      if (chainId === undefined || !address) continue;
      const key = caip(chainId, address);
      // Each (chainId, address) must map to exactly one calldata descriptor.
      // Surface a genuine collision (two different descriptors) rather than
      // silently dropping one; the same descriptor listing a deployment twice
      // is idempotent and allowed.
      const existing = index.calldata[key];
      if (existing && existing !== descriptorPath) {
        throw new Error(
          `Duplicate calldata deployment ${key}: declared by both ${existing} ` +
            `and ${descriptorPath}. Each (chainId, address) may map to only one ` +
            `calldata descriptor.`,
        );
      }
      index.calldata[key] = descriptorPath;
    }
    return;
  }

  if (!context.eip712) return;
  const formats = descriptor.display?.formats;
  if (!formats) return;

  // A descriptor may declare several formats sharing one primary type, so the
  // hashes are grouped per primary type. Consumers match a message by hashing
  // its encodeType and looking for it in encodeTypeHashes.
  const hashesByPrimaryType = new Map();
  for (const encodeType of Object.keys(formats)) {
    const primaryType = extractPrimaryType(encodeType);
    if (!primaryType) continue;
    const hashes = hashesByPrimaryType.get(primaryType) ?? [];
    hashes.push(keccak256Hex(encodeType));
    hashesByPrimaryType.set(primaryType, hashes);
  }
  if (hashesByPrimaryType.size === 0) return;

  const keys = [];
  for (const deployment of context.eip712.deployments ?? []) {
    const { chainId, address } = deployment;
    if (chainId === undefined || !address) continue;
    keys.push(caip(chainId, address));
  }
  if (!keys.length && context.eip712.domainSeparator) {
    keys.push(domainSeparatorKey(context.eip712.domainSeparator));
  }
  if (!keys.length) return;

  for (const key of keys) {
    const byPrimaryType = (index.eip712[key] ??= {});
    for (const [primaryType, encodeTypeHashes] of hashesByPrimaryType) {
      const entries = (byPrimaryType[primaryType] ??= []);
      // Multiple descriptors may share one (address, primaryType) — consumers
      // disambiguate by the encodeType hash. But if two different descriptors
      // register the *same* hash, a consumer cannot tell them apart, so surface
      // that ambiguity instead of storing an indistinguishable duplicate.
      for (const hash of encodeTypeHashes) {
        const clash = entries.find(
          (e) => e.path !== descriptorPath && e.encodeTypeHashes.includes(hash),
        );
        if (clash) {
          throw new Error(
            `Duplicate eip712 encodeType ${hash} for ${key} (${primaryType}): ` +
              `declared by both ${clash.path} and ${descriptorPath}. Two ` +
              `descriptors cannot map the same encodeType at one address.`,
          );
        }
      }
      entries.push({ path: descriptorPath, encodeTypeHashes });
    }
  }
}

/**
 * Sorts object keys so the output is canonical regardless of how the registry
 * is traversed — both the CAIP keys and, below them, the primary types.
 *
 * Arrays are returned untouched, which keeps the entry objects inside them
 * ({ path, encodeTypeHashes }) in their declared field order. Entry order
 * within an array is already deterministic because findDescriptors() sorts.
 */
function sortKeys(value) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** Builds both indexes from the descriptors on disk. */
function generateIndexes() {
  const index = { calldata: {}, eip712: {} };
  const errors = [];

  for (const descriptorPath of findDescriptors(REGISTRY_DIR)) {
    let descriptor;
    try {
      descriptor = resolveDescriptor(path.join(REPO_ROOT, descriptorPath));
    } catch (error) {
      errors.push(`${descriptorPath}: ${error.message}`);
      continue;
    }
    indexDescriptor(descriptor, descriptorPath, index);
  }

  return {
    calldata: sortKeys(index.calldata),
    eip712: sortKeys(index.eip712),
    errors,
  };
}

function serialize(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const validate = process.argv.includes('--validate');

  // indexDescriptor() throws when two descriptors claim one index key. Report
  // that as a plain message rather than a stack trace — it is a registry
  // problem for a contributor to fix, not a bug in this script.
  let calldata;
  let eip712;
  let errors;
  try {
    ({ calldata, eip712, errors } = generateIndexes());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  if (errors.length) {
    for (const error of errors) process.stderr.write(`Failed to resolve ${error}\n`);
    process.exit(1);
  }

  if (validate) {
    process.stdout.write(
      `Index is buildable (${Object.keys(calldata).length} calldata, ` +
        `${Object.keys(eip712).length} eip712 entries).\n`,
    );
    return;
  }

  let stale = false;
  for (const [file, generated] of [
    [CALLDATA_INDEX, calldata],
    [EIP712_INDEX, eip712],
  ]) {
    const contents = serialize(generated);
    if (check) {
      if (fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') !== contents) {
        process.stderr.write(`${file} is out of date\n`);
        stale = true;
      }
    } else {
      fs.writeFileSync(path.join(REPO_ROOT, file), contents, 'utf8');
      process.stdout.write(`Wrote ${file} (${Object.keys(generated).length} entries)\n`);
    }
  }

  if (stale) {
    process.stderr.write('\nRun `npm run generate-index` and commit the result.\n');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { caip, domainSeparatorKey, indexDescriptor };
