#!/usr/bin/env node
/**
 * Lists ERC-7730 descriptors affected by a set of changed files, following
 * "includes" references transitively.
 *
 * A descriptor (registry/<entity>/{calldata,eip712}-*.json) is affected when:
 * - the descriptor file itself changed, or
 * - its testsv2 file (registry/<entity>/testsv2/<name>.tests.json) changed, or
 * - any file in its transitive "includes" chain changed — e.g. a shared
 *   ercs/*.json file, or an entity-local common file (which may itself
 *   include another shared file).
 *
 * Changed files are passed whitespace-separated via the CHANGED_FILES
 * environment variable and/or as CLI arguments, as paths relative to the
 * repository root (the current working directory). Deleted files may be
 * passed too: a descriptor whose includes chain references a now-missing
 * changed file is still reported as affected.
 *
 * Prints a JSON object to stdout:
 *   {
 *     "affected_descriptors": [...],  // repo-relative descriptor paths, sorted
 *     "matrix": [{"descriptor", "test_file", "entity", "descriptor_name"}, ...],
 *     "missing_tests": [...],         // affected descriptors with no test file
 *     "has_affected": true|false,     // at least one affected descriptor
 *     "has_tests": true|false         // at least one matrix entry
 *   }
 *
 * "matrix" only contains affected descriptors that have an existing testsv2
 * file, in the shape consumed by the Descriptor Tests workflow.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();

const EXCLUDED_DIRS = new Set(['tests', 'testsv2', 'sigs']);

function isDescriptorBasename(name) {
  return /^(calldata|eip712)-.*\.json$/.test(name) && !name.endsWith('.tests.json');
}

/**
 * Recursively collect descriptor files under a directory, skipping the test
 * fixtures and the auditor attestations.
 */
function collectDescriptors(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectDescriptors(full, out);
    } else if (entry.isFile() && isDescriptorBasename(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative path with forward slashes. */
function rel(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/**
 * Transitive closure of "includes" references of a file, as repo-relative
 * paths. Missing include targets are still part of the closure (a dangling
 * include means the includer is affected by the target's change/deletion);
 * unreadable files and external URLs terminate the chain with a warning.
 */
function includeClosure(absFile) {
  const closure = new Set();
  const visited = new Set([absFile]);
  const stack = [absFile];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== absFile) closure.add(rel(current));
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(current, 'utf8'));
    } catch (e) {
      process.stderr.write(`warning: cannot read ${rel(current)}: ${e.message}\n`);
      continue;
    }
    const ref = doc.includes;
    if (typeof ref !== 'string' || ref === '') continue;
    if (/^https?:\/\//.test(ref)) {
      process.stderr.write(`warning: external include not followed in ${rel(current)}: ${ref}\n`);
      continue;
    }
    const target = path.resolve(path.dirname(current), ref);
    if (!visited.has(target)) {
      visited.add(target);
      stack.push(target);
    }
  }
  return closure;
}

function main() {
  const changed = new Set(
    [...process.argv.slice(2), ...(process.env.CHANGED_FILES || '').split(/\s+/)]
      .map((f) => f.trim().replace(/^\.\//, ''))
      .filter((f) => f !== '')
  );

  const descriptors = collectDescriptors(path.join(repoRoot, 'registry'), [])
    .map(rel)
    .sort();
  const descriptorSet = new Set(descriptors);

  const affected = new Set();
  const changedShared = [];

  for (const file of changed) {
    if (!file.endsWith('.json')) continue;
    if (/(^|\/)tests\//.test(file)) continue; // legacy tests/ fixtures — not covered here
    const testMatch = file.match(/^(.*)\/testsv2\/([^/]+)\.tests\.json$/);
    if (testMatch) {
      const descriptor = `${testMatch[1]}/${testMatch[2]}.json`;
      if (descriptorSet.has(descriptor)) affected.add(descriptor);
      continue;
    }
    if (file.endsWith('.tests.json')) continue;
    if (descriptorSet.has(file)) {
      affected.add(file);
    } else {
      // Not a descriptor: potentially a shared file included by descriptors.
      changedShared.push(file);
    }
  }

  if (changedShared.length > 0) {
    for (const descriptor of descriptors) {
      if (affected.has(descriptor)) continue;
      const closure = includeClosure(path.join(repoRoot, descriptor));
      if (changedShared.some((f) => closure.has(f))) affected.add(descriptor);
    }
  }

  const affectedSorted = [...affected].sort();
  const matrix = [];
  const missingTests = [];
  for (const descriptor of affectedSorted) {
    const descriptorName = path.posix.basename(descriptor, '.json');
    const testFile = `${path.posix.dirname(descriptor)}/testsv2/${descriptorName}.tests.json`;
    if (!fs.existsSync(path.join(repoRoot, testFile))) {
      missingTests.push(descriptor);
      continue;
    }
    matrix.push({
      descriptor,
      test_file: testFile,
      entity: descriptor.split('/')[1],
      descriptor_name: descriptorName,
    });
  }

  process.stdout.write(
    JSON.stringify({
      affected_descriptors: affectedSorted,
      matrix,
      missing_tests: missingTests,
      has_affected: affectedSorted.length > 0,
      has_tests: matrix.length > 0,
    })
  );
}

if (require.main === module) {
  main();
}
