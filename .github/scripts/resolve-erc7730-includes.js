#!/usr/bin/env node
/**
 * Resolves "includes" in ERC-7730 descriptor JSON files by inlining referenced
 * files into a single merged descriptor. The clear signing tester does not
 * resolve includes, so this script must be run before invoking it.
 *
 * Usage: node resolve-erc7730-includes.js <descriptor.json> [output.json]
 *   If output.json is omitted, writes to stdout.
 *
 * Merge rules (per ERC-7730 spec):
 * - Including file wins on conflicts.
 * - For display.formats[].fields: merge by path (including overrides included).
 */

const fs = require('fs');
const path = require('path');

function loadDescriptor(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Descriptor not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  return { doc: JSON.parse(raw), dir: path.dirname(absPath), path: absPath };
}

function resolveInclude(includeRef, fromDir) {
  const resolved = path.resolve(fromDir, includeRef);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Include not found: ${includeRef} (resolved to ${resolved})`);
  }
  return resolved;
}

/**
 * Merge fields arrays by path: same path => single object with including overriding included;
 * then append including's fields whose path is not in included.
 */
function mergeFields(includedFields, includingFields) {
  if (!includedFields || !Array.isArray(includedFields)) return includingFields || [];
  if (!includingFields || !Array.isArray(includingFields)) return includedFields;

  const byPath = new Map();
  for (const f of includedFields) {
    const p = f.path;
    if (p !== undefined) byPath.set(p, { ...f });
  }
  for (const f of includingFields) {
    const p = f.path;
    if (p !== undefined) {
      const existing = byPath.get(p);
      byPath.set(p, existing ? { ...existing, ...f } : { ...f });
    }
  }
  const order = includedFields.map((f) => f.path).filter((p) => p !== undefined);
  const appended = includingFields.filter((f) => f.path !== undefined && !order.includes(f.path));
  return [...order.map((p) => byPath.get(p)), ...appended].filter(Boolean);
}

/**
 * Deep merge two objects. For display.formats[sig].fields we use mergeFields.
 * Value from b (including) wins over a (included) for conflicts.
 */
function deepMerge(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (typeof a !== 'object' || typeof b !== 'object') return b;
  if (Array.isArray(a) && Array.isArray(b)) return b;

  const out = { ...a };
  for (const key of Object.keys(b)) {
    if (key === 'fields' && Array.isArray(a.fields) && Array.isArray(b.fields)) {
      out.fields = mergeFields(a.fields, b.fields);
    } else if (
      key === 'formats' &&
      typeof a.formats === 'object' &&
      a.formats !== null &&
      typeof b.formats === 'object' &&
      b.formats !== null
    ) {
      out.formats = {};
      const allSigs = new Set([...Object.keys(a.formats), ...Object.keys(b.formats)]);
      for (const sig of allSigs) {
        out.formats[sig] = deepMerge(a.formats[sig] || {}, b.formats[sig] || {});
      }
    } else if (
      typeof b[key] === 'object' &&
      b[key] !== null &&
      !Array.isArray(b[key]) &&
      typeof a[key] === 'object' &&
      a[key] !== null &&
      !Array.isArray(a[key])
    ) {
      out[key] = deepMerge(a[key], b[key]);
    } else {
      out[key] = b[key];
    }
  }
  return out;
}

function resolveDescriptor(inputPath) {
  const { doc, dir } = loadDescriptor(inputPath);
  const includesRef = doc.includes;
  if (includesRef == null || includesRef === '') {
    return { ...doc };
  }
  const includePath = resolveInclude(includesRef, dir);
  const includedMerged = resolveDescriptor(includePath);
  const includingDoc = { ...doc };
  delete includingDoc.includes;
  return deepMerge(includedMerged, includingDoc);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write('Usage: node resolve-erc7730-includes.js <descriptor.json> [output.json]\n');
    process.exit(1);
  }
  const inputPath = path.resolve(args[0]);
  const outputPath = args[1] ? path.resolve(args[1]) : null;
  try {
    const merged = resolveDescriptor(inputPath);
    const json = JSON.stringify(merged, null, 0);
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();
