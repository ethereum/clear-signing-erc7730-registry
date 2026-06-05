#!/usr/bin/env node

/**
 * V1 vs V2 Migration Deep Comparison Test
 *
 * For each leaf descriptor (calldata-* or eip712-*), runs the linter CLI on both
 * the v1 (pre-migration) and v2 (post-migration) versions, compares the outputs
 * using the same normalization/filtering logic from migrate-v1-to-v2.js, and
 * produces a detailed report.
 *
 * Usage:
 *   node tools/scripts/test-v1-v2-compare.js [options]
 *
 * Options:
 *   --v1-ref <ref>       Git ref for v1 baseline (default: "v1-baseline")
 *   --concurrency <n>    Parallel workers (default: 4)
 *   --filter <glob>      Only test files matching pattern (e.g. "registry/safe/*")
 *   --verbose            Show per-file details
 *   --output <path>      JSON output path (default: tools/scripts/logs/v1-v2-compare-results.json)
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "../..");
const LINTER_MAX_BUFFER = 50 * 1024 * 1024;
const LINTER_TIMEOUT_MS = 120_000;
const CHAINS_SKIP_LINT = new Set([324]);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function getArg(name, defaultValue) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultValue;
}

const V1_REF = getArg("--v1-ref", "v1-baseline");
const CONCURRENCY = parseInt(getArg("--concurrency", "4"), 10);
const FILTER = getArg("--filter", null);
const VERBOSE = process.argv.includes("--verbose");
const OUTPUT_PATH = getArg(
  "--output",
  path.join(ROOT_DIR, "tools", "scripts", "logs", "v1-v2-compare-results.json")
);

// ---------------------------------------------------------------------------
// Linter discovery
// ---------------------------------------------------------------------------

const LOCAL_LINTER_PATH = path.join(ROOT_DIR, "tools", "linter", ".venv", "bin", "erc7730");

function getLinterCommand() {
  if (fs.existsSync(LOCAL_LINTER_PATH)) return LOCAL_LINTER_PATH;
  try {
    spawnSync("erc7730", ["--help"], { encoding: "utf8", stdio: "pipe" });
    return "erc7730";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utility functions (reused from migrate-v1-to-v2.js)
// ---------------------------------------------------------------------------

function isLeafDescriptor(filePath) {
  const baseName = path.basename(filePath);
  return baseName.startsWith("calldata") || baseName.startsWith("eip712");
}

function detectDescriptorTypeFromFileName(filePath) {
  const baseName = path.basename(filePath).replace(/\.v1-compare\.tmp\.json$/, "");
  if (baseName.startsWith("calldata")) return "contract";
  if (baseName.startsWith("eip712")) return "eip712";
  return null;
}

function detectDescriptorType(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(content);
    if (json.context?.contract) return "contract";
    if (json.context?.eip712) return "eip712";
  } catch {
    // fall through to filename-based detection
  }
  return detectDescriptorTypeFromFileName(filePath);
}

function detectDescriptorTypeFromContent(content, filePath) {
  try {
    const json = JSON.parse(content);
    if (json.context?.contract) return "contract";
    if (json.context?.eip712) return "eip712";
  } catch {
    // fall through to filename-based detection
  }
  return filePath ? detectDescriptorTypeFromFileName(filePath) : null;
}

function needsSkipLint(filePath) {
  if (CHAINS_SKIP_LINT.size === 0) return false;
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const deployments = [
      ...(json.context?.contract?.deployments || []),
      ...(json.context?.eip712?.deployments || []),
    ];
    return deployments.some((d) => CHAINS_SKIP_LINT.has(Number(d.chainId)));
  } catch {
    return false;
  }
}

function isEmptyJson(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return true;
  return false;
}

function parseJsonFromPossiblyPrefixedOutput(output) {
  const text = String(output || "");
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    const jsonStartLine = lines.findIndex((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith("[") || trimmed.startsWith("{");
    });
    if (jsonStartLine === -1) {
      throw new Error("No JSON payload found in command output");
    }
    return JSON.parse(lines.slice(jsonStartLine).join("\n"));
  }
}

function normalizeForComparison(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);

  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "enums" && Array.isArray(val)) {
      out[key] = [...val]
        .map(normalizeForComparison)
        .sort((a, b) => {
          const va = a?.value ?? 0;
          const vb = b?.value ?? 0;
          if (va !== vb) return va - vb;
          return JSON.stringify(a).localeCompare(JSON.stringify(b));
        });
    } else {
      out[key] = normalizeForComparison(val);
    }
  }
  return out;
}

function deepCompare(v1, v2, jsonPath = "$") {
  const diffs = [];
  if (v1 === v2) return diffs;

  if (typeof v1 !== typeof v2) {
    diffs.push(`${jsonPath}: type mismatch — v1 is ${typeof v1}, v2 is ${typeof v2}`);
    return diffs;
  }

  if (v1 === null || v2 === null) {
    if (v1 !== v2) {
      diffs.push(`${jsonPath}: v1=${JSON.stringify(v1)}, v2=${JSON.stringify(v2)}`);
    }
    return diffs;
  }

  if (Array.isArray(v1) && Array.isArray(v2)) {
    if (v1.length !== v2.length) {
      diffs.push(`${jsonPath}: array length mismatch — v1 has ${v1.length} elements, v2 has ${v2.length}`);
    }
    const maxLen = Math.max(v1.length, v2.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= v1.length) {
        diffs.push(`${jsonPath}[${i}]: missing in v1, present in v2`);
      } else if (i >= v2.length) {
        diffs.push(`${jsonPath}[${i}]: present in v1, missing in v2`);
      } else {
        diffs.push(...deepCompare(v1[i], v2[i], `${jsonPath}[${i}]`));
      }
    }
    return diffs;
  }

  if (typeof v1 === "object" && typeof v2 === "object") {
    const allKeys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
    for (const key of [...allKeys].sort()) {
      const subPath = `${jsonPath}.${key}`;
      if (!(key in v1)) {
        diffs.push(`${subPath}: missing in v1, present in v2`);
      } else if (!(key in v2)) {
        diffs.push(`${subPath}: present in v1, missing in v2`);
      } else {
        diffs.push(...deepCompare(v1[key], v2[key], subPath));
      }
    }
    return diffs;
  }

  diffs.push(`${jsonPath}: v1=${JSON.stringify(v1)}, v2=${JSON.stringify(v2)}`);
  return diffs;
}

function filterComparisonDifferences(differences, options = {}) {
  const { ignoreCreatorNameDrift = false } = options;
  if (!Array.isArray(differences) || differences.length === 0) {
    return differences;
  }

  const eip712DomainNewInV2Pattern = /\.schema\.EIP712Domain: missing in v1, present in v2$/;
  const eip712ContractNamePattern = /^\$\.\d+\.contracts\[\d+\]\.contractName:/;
  const transactionInfoPattern = /^\$\[(\d+)\]\.transaction_info\.(creator_name|descriptor):/;
  const itemPathPattern = /^\$\[(\d+)\]\./;

  const perItem = new Map();
  if (ignoreCreatorNameDrift) {
    for (const diff of differences) {
      const txMatch = diff.match(transactionInfoPattern);
      if (txMatch) {
        const index = txMatch[1];
        const field = txMatch[2];
        const state = perItem.get(index) || { creator: false, descriptor: false, other: false };
        if (field === "creator_name") state.creator = true;
        if (field === "descriptor") state.descriptor = true;
        perItem.set(index, state);
        continue;
      }
      const itemMatch = diff.match(itemPathPattern);
      if (itemMatch) {
        const index = itemMatch[1];
        const state = perItem.get(index) || { creator: false, descriptor: false, other: false };
        state.other = true;
        perItem.set(index, state);
      }
    }
  }

  return differences.filter((diff) => {
    if (eip712DomainNewInV2Pattern.test(diff)) return false;
    if (eip712ContractNamePattern.test(diff)) return false;
    if (!ignoreCreatorNameDrift) return true;

    const txMatch = diff.match(transactionInfoPattern);
    if (!txMatch) return true;

    const index = txMatch[1];
    const field = txMatch[2];
    const state = perItem.get(index) || { creator: false, descriptor: false, other: false };

    if (field === "creator_name") return false;
    if (field === "descriptor" && state.creator && !state.other) return false;

    return true;
  });
}

// ---------------------------------------------------------------------------
// Linter execution
// ---------------------------------------------------------------------------

function runCalldata(linterCmd, filePath) {
  const result = spawnSync(linterCmd, ["calldata", filePath], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: LINTER_MAX_BUFFER,
    timeout: LINTER_TIMEOUT_MS,
  });

  let jsonResult = null;
  const parseCandidates = [
    result.stdout || "",
    result.stderr || "",
    `${result.stdout || ""}\n${result.stderr || ""}`,
  ];
  for (const candidate of parseCandidates) {
    if (!candidate.trim()) continue;
    try {
      jsonResult = parseJsonFromPossiblyPrefixedOutput(candidate);
      break;
    } catch {
      // try next candidate
    }
  }
  return jsonResult;
}

function runConvert(linterCmd, filePath, tag) {
  const tempOutputPath = filePath + `.${tag}.eip712.tmp.json`;
  const tempOutputGlob = [];
  try {
    const result = spawnSync(linterCmd, ["convert", "erc7730-to-eip712", filePath, tempOutputPath], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: LINTER_MAX_BUFFER,
      timeout: LINTER_TIMEOUT_MS,
    });

    if (result.status !== 0) return null;

    const outputDir = path.dirname(tempOutputPath);
    const baseName = path.basename(tempOutputPath, ".json");
    const outputFiles = fs.readdirSync(outputDir).filter((f) => {
      return f.startsWith(baseName + ".") && f.endsWith(".json") && f !== path.basename(tempOutputPath);
    }).map((f) => path.join(outputDir, f));

    if (fs.existsSync(tempOutputPath)) outputFiles.push(tempOutputPath);
    if (outputFiles.length === 0) return null;

    tempOutputGlob.push(...outputFiles);

    const combined = {};
    for (const outFile of outputFiles) {
      const content = fs.readFileSync(outFile, "utf8");
      try {
        const parsed = JSON.parse(content);
        const key = parsed.chainId != null ? String(parsed.chainId) : path.basename(outFile);
        combined[key] = parsed;
      } catch {
        return null;
      }
    }
    return combined;
  } finally {
    for (const f of tempOutputGlob) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch { /* ignore */ }
  }
}

function runLinterOnFile(linterCmd, filePath, descriptorType, tag) {
  if (descriptorType === "contract") {
    return runCalldata(linterCmd, filePath);
  } else if (descriptorType === "eip712") {
    return runConvert(linterCmd, filePath, tag);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitShowFile(ref, relPath) {
  try {
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      maxBuffer: LINTER_MAX_BUFFER,
    });
  } catch {
    return null;
  }
}

function gitFileExistsAtRef(ref, relPath) {
  try {
    execSync(`git cat-file -e ${ref}:${relPath}`, { cwd: ROOT_DIR, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walkDir(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "node_modules" || entry.name === ".git") continue;
      walkDir(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

function discoverLeafDescriptors() {
  const dirs = [
    path.join(ROOT_DIR, "registry"),
    path.join(ROOT_DIR, "ercs"),
  ];

  const files = [];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      walkDir(dir, files);
    }
  }

  return files.filter((f) => isLeafDescriptor(f));
}

function getSchemaVersion(filePath) {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const schema = json.$schema;
    if (!schema) return "none";
    if (typeof schema !== "string") return "null";
    if (schema.includes("v2")) return "v2";
    if (schema.includes("v1")) return "v1";
    return "unknown";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Working tree swap helpers
// ---------------------------------------------------------------------------

function findAllChangedFiles() {
  const output = execSync(`git diff --name-only ${V1_REF}..HEAD -- registry/ ercs/`, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: LINTER_MAX_BUFFER,
  }).trim();
  return output ? output.split("\n").filter(Boolean) : [];
}

function swapToV1(changedFiles) {
  const saved = new Map();
  const newInV2 = [];
  for (const relPath of changedFiles) {
    const absPath = path.join(ROOT_DIR, relPath);
    const v2Content = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null;
    saved.set(relPath, v2Content);

    const v1Content = gitShowFile(V1_REF, relPath);
    if (v1Content !== null) {
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, v1Content);
    } else {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      newInV2.push(relPath);
    }
  }
  return { saved, newInV2 };
}

function restoreV2(saved) {
  for (const [relPath, v2Content] of saved) {
    const absPath = path.join(ROOT_DIR, relPath);
    if (v2Content !== null) {
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, v2Content);
    } else {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Single-file linter run (works on the file in-place)
// ---------------------------------------------------------------------------

function runLinterOnRealFile(linterCmd, relPath) {
  const absPath = path.join(ROOT_DIR, relPath);
  if (!fs.existsSync(absPath)) return { output: null, error: "file not found" };

  const descriptorType = detectDescriptorType(absPath);
  if (!descriptorType) return { output: null, error: "unknown descriptor type" };

  const tag = "cmp" + Date.now();
  const output = runLinterOnFile(linterCmd, absPath, descriptorType, tag);
  return { output, error: null, descriptorType };
}

// ---------------------------------------------------------------------------
// Parallel linter pass
// ---------------------------------------------------------------------------

async function runLinterPass(linterCmd, files, label) {
  const results = new Map();
  let nextIndex = 0;
  let completed = 0;
  const total = files.length;

  function printProgress() {
    process.stdout.write(`\r  ${label}: ${completed}/${total} files...`);
  }

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= files.length) break;

      const relPath = files[idx];
      results.set(relPath, runLinterOnRealFile(linterCmd, relPath));
      completed++;
      if (VERBOSE) {
        const r = results.get(relPath);
        const ok = r.output !== null && !isEmptyJson(r.output);
        console.log(`  ${ok ? "✓" : "✗"} [${label}] [${completed}/${total}] ${relPath}`);
      } else {
        printProgress();
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, files.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (!VERBOSE) process.stdout.write("\n");

  return results;
}

// ---------------------------------------------------------------------------
// Compare v1 and v2 results
// ---------------------------------------------------------------------------

function compareResults(filesToTest, v1Results, v2Results, v2SkipSet, newInV2Set) {
  const results = [];
  for (const relPath of filesToTest) {
    const result = {
      file: relPath,
      status: "unknown",
      descriptorType: null,
      v1Error: null,
      v2Error: null,
      v1Empty: false,
      v2Empty: false,
      rawDiffCount: 0,
      filteredDiffCount: 0,
      differences: [],
      skipped: false,
      skipReason: null,
    };

    if (newInV2Set.has(relPath)) {
      result.status = "new-in-v2";
      result.skipped = true;
      result.skipReason = "File does not exist in v1 baseline";
      results.push(result);
      continue;
    }

    if (v2SkipSet.has(relPath)) {
      result.status = "skipped";
      result.skipped = true;
      result.skipReason = "Deployment on chain with unreachable block explorer";
      results.push(result);
      continue;
    }

    const v1r = v1Results.get(relPath);
    const v2r = v2Results.get(relPath);

    result.descriptorType = v2r?.descriptorType || v1r?.descriptorType || null;

    if (!result.descriptorType) {
      result.status = "skipped";
      result.skipped = true;
      result.skipReason = "Could not detect descriptor type";
      results.push(result);
      continue;
    }

    const v1Out = v1r?.output;
    const v2Out = v2r?.output;

    result.v1Empty = v1Out === null || v1Out === undefined || isEmptyJson(v1Out);
    result.v2Empty = v2Out === null || v2Out === undefined || isEmptyJson(v2Out);

    if (v1r?.error) result.v1Error = v1r.error;
    if (v2r?.error) result.v2Error = v2r.error;

    if (result.v1Empty && result.v2Empty) {
      result.status = "both-empty";
      results.push(result);
      continue;
    }
    if (result.v1Empty) {
      result.status = "v1-empty";
      if (!result.v1Error) result.v1Error = "v1 output is empty or failed";
      results.push(result);
      continue;
    }
    if (result.v2Empty) {
      result.status = "v2-empty";
      if (!result.v2Error) result.v2Error = "v2 output is empty or failed";
      results.push(result);
      continue;
    }

    const rawDifferences = deepCompare(
      normalizeForComparison(v1Out),
      normalizeForComparison(v2Out)
    );
    const filteredDifferences = filterComparisonDifferences(rawDifferences, {
      ignoreCreatorNameDrift: true,
    });

    result.rawDiffCount = rawDifferences.length;
    result.filteredDiffCount = filteredDifferences.length;
    result.differences = filteredDifferences;

    if (filteredDifferences.length > 0) {
      result.status = "mismatch";
    } else if (rawDifferences.length > 0) {
      result.status = "match-after-filter";
    } else {
      result.status = "match";
    }

    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport(allLeafFiles, modifiedFiles, results, unmigratedFiles) {
  console.log("\n" + "=".repeat(80));
  console.log("  V1 vs V2 MIGRATION DEEP COMPARISON REPORT");
  console.log("=".repeat(80));

  // --- Unmigrated files ---
  console.log("\n--- UNMIGRATED FILES (still v1 on v2 branch) ---\n");
  if (unmigratedFiles.length === 0) {
    console.log("  None — all leaf descriptors have been migrated to v2.\n");
  } else {
    const grouped = {};
    for (const f of unmigratedFiles) {
      const parts = f.split("/");
      const entity = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0];
      (grouped[entity] = grouped[entity] || []).push(f);
    }
    for (const [entity, files] of Object.entries(grouped).sort()) {
      console.log(`  ${entity}/`);
      for (const f of files) {
        console.log(`    - ${path.basename(f)}`);
      }
    }
    console.log(`\n  Total unmigrated: ${unmigratedFiles.length} / ${allLeafFiles.length} leaf files\n`);
  }

  // --- Summary table ---
  const statusCounts = {};
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  console.log("--- SUMMARY ---\n");
  console.log(`  Total leaf descriptors on v2 branch:  ${allLeafFiles.length}`);
  console.log(`  Migrated to v2 schema:                ${allLeafFiles.length - unmigratedFiles.length}`);
  console.log(`  Still on v1 schema:                   ${unmigratedFiles.length}`);
  console.log(`  Modified files tested:                ${modifiedFiles.length}`);
  console.log("");
  console.log(`  ✅ Match (identical output):           ${statusCounts["match"] || 0}`);
  console.log(`  ⚠️  Match after filtering:              ${statusCounts["match-after-filter"] || 0}`);
  console.log(`  ❌ Mismatch:                           ${statusCounts["mismatch"] || 0}`);
  console.log(`  📭 v1 empty:                           ${statusCounts["v1-empty"] || 0}`);
  console.log(`  📭 v2 empty:                           ${statusCounts["v2-empty"] || 0}`);
  console.log(`  📭 Both empty:                         ${statusCounts["both-empty"] || 0}`);
  console.log(`  ⏭️  New in v2 (no v1 baseline):         ${statusCounts["new-in-v2"] || 0}`);
  console.log(`  ⏭️  Skipped:                            ${statusCounts["skipped"] || 0}`);
  console.log(`  ❓ Other:                              ${(statusCounts["v1-read-error"] || 0) + (statusCounts["unknown"] || 0)}`);

  // --- Empty result warnings ---
  const emptyFiles = results.filter((r) => r.status.includes("empty"));
  if (emptyFiles.length > 0) {
    console.log("\n--- EMPTY RESULT WARNINGS ---\n");
    for (const r of emptyFiles) {
      const side = r.v1Empty && r.v2Empty ? "BOTH" : r.v1Empty ? "V1" : "V2";
      console.log(`  ${side} empty: ${r.file}`);
    }
  }

  // --- Mismatch details ---
  const mismatches = results.filter((r) => r.status === "mismatch");
  if (mismatches.length > 0) {
    console.log("\n--- MISMATCH DETAILS ---\n");
    for (const r of mismatches) {
      console.log(`  ❌ ${r.file} (${r.filteredDiffCount} differences, ${r.rawDiffCount} raw):`);
      const shown = r.differences.slice(0, 10);
      for (const d of shown) {
        console.log(`      ${d}`);
      }
      if (r.differences.length > 10) {
        console.log(`      ... and ${r.differences.length - 10} more`);
      }
      console.log("");
    }
  }

  // --- Top-N diff patterns ---
  const allDiffs = results.flatMap((r) => r.differences);
  if (allDiffs.length > 0) {
    console.log("--- TOP DIFF PATTERNS ---\n");
    const patterns = {};
    for (const diff of allDiffs) {
      // Generalize paths: replace array indices and chain IDs with placeholders
      const pattern = diff
        .replace(/\$\[\d+\]/g, "$[*]")
        .replace(/\$\.\d+\./g, "$.<chainId>.")
        .replace(/\[\d+\]/g, "[*]")
        .replace(/: v1=.*/, ": <value differs>")
        .replace(/: v1 is .*, v2 is .*/, ": <type differs>");
      patterns[pattern] = (patterns[pattern] || 0) + 1;
    }
    const sorted = Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [pattern, count] of sorted) {
      console.log(`  [${count}x] ${pattern}`);
    }
  }

  console.log("\n" + "=".repeat(80));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("V1 vs V2 Migration Deep Comparison Test");
  console.log("========================================\n");

  // Validate linter
  const linterCmd = getLinterCommand();
  if (!linterCmd) {
    console.error("ERROR: erc7730 CLI not found. Install with: pip install erc7730");
    process.exit(1);
  }
  console.log(`  Linter: ${linterCmd}`);
  console.log(`  V1 ref: ${V1_REF}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (FILTER) console.log(`  Filter: ${FILTER}`);
  console.log("");

  // Verify v1 ref exists
  try {
    execSync(`git rev-parse ${V1_REF}`, { cwd: ROOT_DIR, encoding: "utf8", stdio: "pipe" });
  } catch {
    console.error(`ERROR: Git ref "${V1_REF}" not found. Create it with: git tag v1-baseline <commit>`);
    process.exit(1);
  }

  // Discover all leaf descriptors on the current (v2) branch
  console.log("  Discovering leaf descriptors...");
  let allLeafFiles = discoverLeafDescriptors().map((f) => path.relative(ROOT_DIR, f));

  if (FILTER) {
    const filterLower = FILTER.toLowerCase();
    allLeafFiles = allLeafFiles.filter((f) => f.toLowerCase().includes(filterLower));
  }

  console.log(`  Found ${allLeafFiles.length} leaf descriptor files.\n`);

  // Detect unmigrated files (still v1 on v2 branch)
  console.log("  Checking schema versions...");
  const unmigratedFiles = [];
  for (const relPath of allLeafFiles) {
    const version = getSchemaVersion(path.join(ROOT_DIR, relPath));
    if (version !== "v2") {
      unmigratedFiles.push(relPath);
    }
  }
  console.log(`  Migrated: ${allLeafFiles.length - unmigratedFiles.length}, Still v1: ${unmigratedFiles.length}\n`);

  // Find ALL files modified between v1 baseline and current HEAD
  console.log("  Finding all modified files...");
  const changedFiles = findAllChangedFiles();
  const changedSet = new Set(changedFiles);
  console.log(`  Total changed files: ${changedFiles.length}`);

  // Files to test: leaf descriptors that were modified
  let filesToTest = allLeafFiles.filter((f) => changedSet.has(f));
  console.log(`  Modified leaf descriptors to test: ${filesToTest.length}\n`);

  if (filesToTest.length === 0) {
    console.log("  No modified leaf descriptors found. Nothing to test.");
    process.exit(0);
  }

  // Build skip set (zkSync etc) — check while files are still at v2
  const v2SkipSet = new Set();
  for (const relPath of filesToTest) {
    if (needsSkipLint(path.join(ROOT_DIR, relPath))) v2SkipSet.add(relPath);
  }

  // Leaf files that are testable
  const testableFiles = filesToTest.filter((f) => !v2SkipSet.has(f));

  let v1Results, v2Results, newInV2Set;

  // Phase 1: swap working tree to v1, run v1 linter pass
  console.log("  Phase 1: Restoring v1 state for include resolution...");
  const { saved, newInV2 } = swapToV1(changedFiles);
  newInV2Set = new Set(newInV2);
  try {
    const v1Testable = testableFiles.filter((f) => !newInV2Set.has(f));
    console.log(`  Working tree swapped to v1 (${changedFiles.length} files, ${newInV2.length} new-in-v2). Running v1 linter...\n`);

    v1Results = await runLinterPass(linterCmd, v1Testable, "V1");
  } finally {
    // Always restore v2 state, even on error
    console.log("\n  Phase 2: Restoring v2 state...");
    restoreV2(saved);
    console.log("  Working tree restored to v2.");
  }

  // Phase 2 continued: run v2 linter pass
  const v2Testable = testableFiles.filter((f) => !newInV2Set.has(f));
  console.log(`  Running v2 linter...\n`);

  v2Results = await runLinterPass(linterCmd, v2Testable, "V2");

  // Phase 3: compare results
  console.log("\n  Phase 3: Comparing results...");
  const results = compareResults(filesToTest, v1Results, v2Results, v2SkipSet, newInV2Set);

  // Print report
  printReport(allLeafFiles, filesToTest, results, unmigratedFiles);

  // Write JSON output
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const jsonOutput = {
    timestamp: new Date().toISOString(),
    v1Ref: V1_REF,
    totalLeafDescriptors: allLeafFiles.length,
    unmigratedFiles,
    testedFiles: filesToTest.length,
    results: results.map((r) => ({
      ...r,
      differences: r.differences.length > 50 ? r.differences.slice(0, 50) : r.differences,
    })),
    summary: {
      match: results.filter((r) => r.status === "match").length,
      matchAfterFilter: results.filter((r) => r.status === "match-after-filter").length,
      mismatch: results.filter((r) => r.status === "mismatch").length,
      v1Empty: results.filter((r) => r.status === "v1-empty").length,
      v2Empty: results.filter((r) => r.status === "v2-empty").length,
      bothEmpty: results.filter((r) => r.status === "both-empty").length,
      newInV2: results.filter((r) => r.status === "new-in-v2").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(jsonOutput, null, 2));
  console.log(`\n  Full results written to: ${path.relative(ROOT_DIR, OUTPUT_PATH)}`);

  // Exit with non-zero if there are mismatches
  const mismatchCount = results.filter((r) => r.status === "mismatch").length;
  if (mismatchCount > 0) {
    console.log(`\n  ${mismatchCount} MISMATCH(ES) FOUND — review details above.\n`);
    process.exit(1);
  } else {
    console.log("\n  All tests passed.\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
