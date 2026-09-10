#!/usr/bin/env node
/**
 * Checks that every function a calldata descriptor formats has at least one
 * test case in its testsv2 file.
 *
 * For each descriptor, the script resolves "includes", derives the 4-byte
 * selector of every "display.formats" key, and reads the selector from the
 * first 4 bytes of the calldata of every "rawTx" in
 * registry/<entity>/testsv2/<descriptor-name>.tests.json. viem does the
 * parsing on both sides. A format whose
 * selector no test calls is an error. EIP-712 descriptors have no selector
 * and are skipped.
 *
 * Usage: node check-selector-coverage.js <descriptor.json|directory>...
 *   A directory is walked for calldata-*.json descriptors, skipping the
 *   tests/, testsv2/ and sigs/ folders.
 *
 * Prints GitHub Actions annotations, and exits 1 when a function has no test,
 * a format key is not a function signature, or a test cannot be decoded.
 */

const fs = require('fs');
const path = require('path');
const { parseAbiItem, parseTransaction, slice, toFunctionSelector } = require('viem');
const { resolveDescriptor } = require('./resolve-erc7730-includes');

const repoRoot = process.cwd();
const EXCLUDED_DIRS = new Set(['tests', 'testsv2', 'sigs']);

/** Repo-relative path with forward slashes. */
function rel(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function collectDescriptors(target, out) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collectDescriptors(full, out);
    } else if (/^calldata-.*\.json$/.test(entry.name) && !entry.name.endsWith('.tests.json')) {
      out.push(full);
    }
  }
  return out;
}

// --- Selectors ---------------------------------------------------------------

/** viem errors carry a one-line summary; other errors only have a message. */
function reason(error) {
  return error.shortMessage ?? error.message;
}

/**
 * The 4-byte selector of a "display.formats" key. The key is a function
 * signature with parameter names, so the ABI parser strips the names and
 * expands shorthands like "uint" before hashing.
 */
function selectorOf(key) {
  return toFunctionSelector(parseAbiItem(`function ${key.trim()}`));
}

/** The selector called by a test case. */
function testSelector(test) {
  // The schema allows an EIP-712 test in a calldata fixture; it covers nothing.
  if (typeof test.rawTx !== 'string') throw new Error('test has no rawTx');
  const data = parseTransaction(test.rawTx).data ?? '0x';
  if (data.length < 10) throw new Error('calldata shorter than 4 bytes');
  return slice(data, 0, 4);
}

// --- Check -------------------------------------------------------------------

/**
 * The errors of one descriptor, or null when there is nothing to check: the
 * descriptor cannot be read (another job reports it), it formats no function,
 * or it has no test file (the require-testsv2 job reports it).
 */
function checkDescriptor(descriptorAbs) {
  const descriptor = rel(descriptorAbs);
  const errors = [];

  let formats;
  try {
    formats = resolveDescriptor(descriptorAbs).display?.formats ?? {};
  } catch (error) {
    // Another job reports the malformed descriptor; there is nothing to cover.
    process.stderr.write(`warning: cannot read ${descriptor}: ${error.message}\n`);
    return null;
  }

  const selectors = new Map(); // selector -> the keys that hash to it
  for (const key of Object.keys(formats)) {
    let selector;
    try {
      selector = selectorOf(key);
    } catch (error) {
      errors.push(`Cannot derive a selector from the format key ${JSON.stringify(key)}: ${reason(error)}`);
      continue;
    }
    if (!selectors.has(selector)) selectors.set(selector, []);
    selectors.get(selector).push(key);
  }
  if (selectors.size === 0 && errors.length === 0) return null;

  const testFile = `${path.posix.dirname(descriptor)}/testsv2/${path.posix.basename(descriptor, '.json')}.tests.json`;
  let tests;
  try {
    tests = JSON.parse(fs.readFileSync(path.join(repoRoot, testFile), 'utf8')).tests;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // require-testsv2 reports the missing file; it is a different fix.
      process.stderr.write(`warning: ${descriptor} has no test file ${testFile}\n`);
      return errors.length > 0 ? errors : null;
    }
    errors.push(`Cannot read ${testFile}: ${error.message}`);
    return errors;
  }
  if (!Array.isArray(tests)) {
    errors.push(`${testFile} has no "tests" array`);
    return errors;
  }

  const covered = new Set();
  tests.forEach((test, i) => {
    try {
      covered.add(testSelector(test));
    } catch (error) {
      const name = test?.description ? JSON.stringify(test.description) : `#${i + 1}`;
      errors.push(`Test ${name} in ${testFile} has a rawTx that cannot be decoded: ${reason(error)}`);
    }
  });

  const uncovered = [...selectors].filter(([selector]) => !covered.has(selector));
  if (uncovered.length > 0) {
    const list = uncovered.map(([selector, keys]) => `${keys.join(' / ')} (${selector})`).join('; ');
    errors.push(
      `${uncovered.length} of ${selectors.size} function(s) have no test in ${testFile}. Add a test whose rawTx calls: ${list}`,
    );
  }
  return errors;
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    process.stderr.write('Usage: node check-selector-coverage.js <descriptor.json|directory>...\n');
    process.exit(2);
  }

  const descriptors = [...new Set(targets.flatMap((t) => collectDescriptors(path.resolve(t), [])))].sort();
  let checked = 0;
  let failed = 0;
  for (const descriptorAbs of descriptors) {
    const descriptor = rel(descriptorAbs);
    if (!/^calldata-/.test(path.basename(descriptor))) continue;
    const result = checkDescriptor(descriptorAbs);
    if (result === null) {
      console.log(`⏭️ ${descriptor} (nothing to check)`);
      continue;
    }
    checked++;
    if (result.length === 0) {
      console.log(`✅ ${descriptor}`);
      continue;
    }
    failed++;
    for (const message of result) console.log(`::error file=${descriptor},line=1::${message}`);
  }

  const summary = `${failed} of ${checked} descriptor(s) have a function without a test.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY && failed > 0) {
    // GitHub shows 10 annotations per step, so give the total as well.
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary} See the log for the full list.\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { selectorOf, testSelector };
