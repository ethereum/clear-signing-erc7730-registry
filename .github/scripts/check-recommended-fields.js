#!/usr/bin/env node
/**
 * Finds optional improvements for the descriptors that a pull request adds or
 * changes: a display format with no "interpolatedIntent", and the deprecated
 * keys "context.contract.abi" and "context.eip712.schemas". None is an error.
 *
 * Reads the changed files from CHANGED_FILES and from the arguments. Writes
 * one JSON document to stdout, always, also when there is nothing to suggest:
 *
 *   {
 *     "version": 1,
 *     "items": [
 *       { "type": "no-interpolated-intent", "file", "pointer", "format", "message" },
 *       { "type": "deprecated-key", "file", "pointer", "key", "message" }
 *     ],
 *     "includes": { "<descriptor>": ["<included file>", ...] }
 *   }
 *
 * "file" is the repository path of the file to edit. "pointer" is an RFC 6901
 * JSON Pointer into that file: for a missing interpolatedIntent it points to
 * the format, for a deprecated key to the key.
 *
 * It reads a shared file as well, but it does not resolve "includes". A format
 * belongs to the file that declares it, so an item names the file that the
 * author must edit, and not the descriptors that inherit the format.
 *
 * "includes" is there so that the test report can give each descriptor the
 * items of the files it includes. It maps each descriptor named in
 * AFFECTED_DESCRIPTORS (a JSON array of repository paths) to its transitive
 * "includes" chain, nearest first, with the same walk that
 * list-affected-descriptors.js uses to find the affected descriptors. The
 * test report runs in another workflow, without the files of the pull
 * request, so the chain must travel with the items. It is empty when
 * AFFECTED_DESCRIPTORS is not set.
 *
 * The test report bundle reads this output, see
 * .github/test-runner-docs/bundle.md.
 */

const fs = require('fs');
const path = require('path');
// The same include walk as the affected-descriptors detection, so the two
// scripts cannot disagree on what a descriptor includes.
const { includeClosure } = require('./list-affected-descriptors');

const MESSAGES = {
  'no-interpolated-intent':
    'The format has no interpolatedIntent. A wallet prefers it over intent, because it puts the values of the transaction in the sentence that the signer reads.',
  'deprecated-key': 'Keep this key only for backward compatibility. A new descriptor should use display.formats.',
};

/** One segment of an RFC 6901 JSON Pointer. */
const segment = (value) => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
const pointer = (...parts) => parts.map((p) => `/${segment(p)}`).join('');

const warn = (message) => process.stderr.write(`warning: ${message}\n`);

/** The repository path of an absolute path, or null when it is outside the repository. */
function repoPath(absPath) {
  const rel = path.relative(process.cwd(), absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function main() {
  const changed = [...process.argv.slice(2), ...(process.env.CHANGED_FILES || '').split(/\s+/)]
    .map((f) => f.trim())
    // A descriptor or a shared file, at any depth, as the other tools accept
    // one. The second test keeps out a fixture and an attestation.
    .filter(
      (f) =>
        /^(registry|ercs)\/(.+\/)?(calldata|eip712|common)-[^/]*\.json$/.test(f) &&
        !/\/(tests|testsv2|sigs)\//.test(f),
    );

  const items = [];
  for (const file of changed) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // A deleted file, or one that another check already rejects.
      warn(`cannot read ${file}: ${error.message}`);
      continue;
    }

    for (const [selector, format] of Object.entries(doc?.display?.formats ?? {})) {
      if (format && typeof format === 'object' && !('interpolatedIntent' in format)) {
        items.push({
          type: 'no-interpolated-intent',
          file,
          pointer: pointer('display', 'formats', selector),
          format: selector,
          message: MESSAGES['no-interpolated-intent'],
        });
      }
    }

    for (const key of ['context.contract.abi', 'context.eip712.schemas']) {
      const [, parent, field] = key.split('.');
      const container = doc?.context?.[parent];
      if (container && typeof container === 'object' && field in container) {
        items.push({
          type: 'deprecated-key',
          file,
          pointer: pointer('context', parent, field),
          key,
          message: MESSAGES['deprecated-key'],
        });
      }
    }
  }

  const includes = {};
  let affected = [];
  try {
    affected = JSON.parse(process.env.AFFECTED_DESCRIPTORS || '[]');
  } catch (error) {
    warn(`AFFECTED_DESCRIPTORS is not JSON: ${error.message}`);
  }
  for (const descriptor of Array.isArray(affected) ? affected : []) {
    if (typeof descriptor !== 'string' || repoPath(path.resolve(descriptor)) === null) continue;
    includes[descriptor] = [...includeClosure(path.resolve(descriptor))];
  }

  process.stdout.write(`${JSON.stringify({ version: 1, items, includes }, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { pointer };
