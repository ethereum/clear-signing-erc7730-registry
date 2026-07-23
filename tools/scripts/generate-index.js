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
 * Usage: node tools/scripts/generate-index.js [--check]
 *   default   rewrites both index files in place
 *   --check   exits 1 if the committed files differ from the generated ones
 */

const fs = require('fs');
const path = require('path');
const { keccak_256 } = require('js-sha3');
const { resolveDescriptor } = require('../../.github/scripts/resolve-erc7730-includes.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REGISTRY_DIR = path.join(REPO_ROOT, 'registry');
const CALLDATA_INDEX = 'index.calldata.json';
const EIP712_INDEX = 'index.eip712.json';

/** Test fixtures live alongside descriptors but must never be indexed. */
const EXCLUDED_DIRS = new Set(['tests', 'testsv2']);

/**
 * Collects descriptor paths under registry/, repo-relative and sorted.
 *
 * Only calldata-*.json / eip712-*.json files are descriptors. Shared files
 * pulled in via "includes" (common-*.json, *-common-*.json) do not match the
 * prefix and are therefore never indexed in their own right — they only
 * contribute through the descriptors that include them.
 *
 * Sorting matters: it makes the "first descriptor wins" tie-break below
 * deterministic when two descriptors claim the same chain and address.
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
      // First descriptor wins; findDescriptors() sorts, so this is stable.
      if (!index.calldata[key]) index.calldata[key] = descriptorPath;
    }
    return;
  }

  if (!context.eip712) return;
  const deployments = context.eip712.deployments ?? [];
  const formats = descriptor.display?.formats;
  if (!deployments.length || !formats) return;

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

  for (const deployment of deployments) {
    const { chainId, address } = deployment;
    if (chainId === undefined || !address) continue;
    const byPrimaryType = (index.eip712[caip(chainId, address)] ??= {});
    for (const [primaryType, encodeTypeHashes] of hashesByPrimaryType) {
      (byPrimaryType[primaryType] ??= []).push({
        path: descriptorPath,
        encodeTypeHashes,
      });
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
  const { calldata, eip712, errors } = generateIndexes();

  if (errors.length) {
    for (const error of errors) process.stderr.write(`Failed to resolve ${error}\n`);
    process.exit(1);
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

main();
