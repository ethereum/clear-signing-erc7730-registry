#!/usr/bin/env node
/**
 * ERC-7730 Contract Function Consistency Checker
 *
 * Validates that function keys in `display.formats` match verified on-chain
 * contract ABI functions for contract descriptors (not EIP-712 files).
 *
 * Usage:
 *   node tools/scripts/check-contract-functions.js --file <descriptor.json> [options]
 *   node tools/scripts/check-contract-functions.js <descriptor.json> [options]
 *
 * Options:
 *   --file <path>    Descriptor file path (alternative to positional arg)
 *   --chain <id>     Single chain to validate (default: 1)
 *   --all-chains     Validate all deployment chains supported by configured explorers
 *   --verbose        Print debug details
 *   --log <path>     Enable verbose logging and write to file
 *   -l               Enable verbose logging to tools/scripts/logs/
 *   --help, -h       Show this help message
 *
 * Environment:
 *   ETHERSCAN_API_KEY (required for supported Etherscan-like chains)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { keccak256 } = require("js-sha3");

const ROOT_DIR = path.join(__dirname, "..", "..");
const MIN_REQUEST_INTERVAL_MS = 380;
let _lastExplorerRequestAt = 0;
const LOGS_DIR = path.join(__dirname, "logs");
const DEFAULT_LOG_FILE = path.join(LOGS_DIR, `check-contract-functions-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.verbose.log`);
const LOG_FILE_PATH = getLogFilePath();

const CONFIG = {
  verbose: process.argv.includes("--verbose"),
  logVerbose: Boolean(LOG_FILE_PATH),
  logFile: LOG_FILE_PATH,
  allChains: process.argv.includes("--all-chains"),
  chainExplicit: process.argv.includes("--chain"),
  chainId: getArgValue("--chain", 1),
  filePath: getFilePathArg(),
};

/**
 * Provider registry using Etherscan V2 API.
 * Same supported chain set as tools/scripts/generate-tests.js.
 */
const PROVIDERS = {
  1: { name: "Etherscan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  10: { name: "Optimism Etherscan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  56: { name: "BSCScan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  137: { name: "Polygonscan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  8453: { name: "Basescan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  42161: { name: "Arbiscan", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
  43114: { name: "Snowtrace", baseUrl: "api.etherscan.io", apiKeyEnv: "ETHERSCAN_API_KEY" },
};

function getArgValue(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    const raw = process.argv[idx + 1];
    const asNum = Number(raw);
    return Number.isNaN(asNum) ? raw : asNum;
  }
  return defaultValue;
}

function getLogFilePath() {
  const logFlagIndex = process.argv.indexOf("--log");
  if (logFlagIndex !== -1) {
    const provided = process.argv[logFlagIndex + 1];
    if (!provided || provided.startsWith("-")) {
      console.error("Missing log file path for --log");
      process.exit(1);
    }
    return path.resolve(provided);
  }
  if (process.argv.includes("-l")) {
    return DEFAULT_LOG_FILE;
  }
  return null;
}

function getFilePathArg() {
  const fileFlag = getArgValue("--file", null);
  if (fileFlag) return fileFlag;

  const knownValueFlags = new Set(["--file", "--chain", "--log"]);
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "-l") continue;
    if (arg.startsWith("-")) {
      if (knownValueFlags.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return null;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

function appendLogLine(level, message) {
  if (!CONFIG.logFile) return;
  try {
    fs.appendFileSync(CONFIG.logFile, `[${new Date().toISOString()}] [${level}] ${stripAnsi(message)}\n`);
  } catch {
    // Logging should not break validation flow.
  }
}

function initLogFile() {
  if (!CONFIG.logFile) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    fs.appendFileSync(
      CONFIG.logFile,
      `\n[${new Date().toISOString()}] check-contract-functions start: ${process.argv.join(" ")}\n`
    );
  } catch (error) {
    console.error(`Failed to initialize log file ${CONFIG.logFile}: ${error.message}`);
    process.exit(1);
  }
}

const baseConsoleLog = console.log.bind(console);
const baseConsoleWarn = console.warn.bind(console);
const baseConsoleError = console.error.bind(console);
console.log = (...args) => {
  appendLogLine("INFO", args.join(" "));
  baseConsoleLog(...args);
};
console.warn = (...args) => {
  appendLogLine("WARN", args.join(" "));
  baseConsoleWarn(...args);
};
console.error = (...args) => {
  appendLogLine("ERROR", args.join(" "));
  baseConsoleError(...args);
};
initLogFile();

function log(msg) {
  if (CONFIG.verbose) {
    console.log(msg);
  } else if (CONFIG.logVerbose) {
    appendLogLine("DEBUG", msg);
  }
}

function printHelp(exitCode = 0, errorMessage = null) {
  const write = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    write(errorMessage);
    write("");
  }
  write("Usage: node tools/scripts/check-contract-functions.js --file <descriptor.json> [options]");
  write("");
  write("Options:");
  write("  --file <path>    Descriptor file path (or positional arg)");
  write("  --chain <id>     Single chain to validate (default: 1)");
  write("  --all-chains     Validate all supported deployment chains with API key");
  write("  --verbose        Verbose output");
  write("  --log <path>     Enable verbose logging and write to file");
  write("  -l               Enable verbose logging to tools/scripts/logs/");
  write("  --help, -h       Show this help message");
  write("");
  write(`Explorer requests are rate-limited to ~${Math.floor(1000 / MIN_REQUEST_INTERVAL_MS)} req/s.`);
  write("");
  write("Examples:");
  write("  node tools/scripts/check-contract-functions.js registry/uniswap/calldata-uniswap.json");
  write("  node tools/scripts/check-contract-functions.js --file registry/uniswap/calldata-uniswap.json --all-chains");
  write("  node tools/scripts/check-contract-functions.js registry/ethena/calldata-ethena.json --chain 1 --verbose");
  process.exit(exitCode);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp(0);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    client
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedHttpsGet(url) {
  const now = Date.now();
  const elapsed = now - _lastExplorerRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  _lastExplorerRequestAt = Date.now();
  return httpsGet(url);
}

async function callExplorerWithRetry(url, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await rateLimitedHttpsGet(url);
      return response;
    } catch (e) {
      lastError = e;
    }
    if (attempt < retries) {
      await sleep((attempt + 1) * 600);
    }
  }
  throw lastError || new Error("Unknown explorer request failure");
}

function findMatchingParen(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "(") depth++;
    if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractType(param) {
  const p = String(param || "").trim();
  if (!p) return "";

  if (p.startsWith("(")) {
    const tupleEnd = findMatchingParen(p, 0);
    if (tupleEnd === -1) return p;
    const tupleContent = p.slice(1, tupleEnd);
    const innerTypes = extractTypes(tupleContent);
    const suffix = p.slice(tupleEnd + 1).trim();
    const arrayMatch = suffix.match(/^(\[\d*\])+/);
    const arraySuffix = arrayMatch ? arrayMatch[0] : "";
    return `(${innerTypes.join(",")})${arraySuffix}`;
  }

  const typeMatch = p.match(/^([A-Za-z_]\w*(?:\[\d*\])*)/);
  return typeMatch ? typeMatch[1] : p;
}

function extractTypes(paramsStr) {
  const raw = String(paramsStr || "").trim();
  if (!raw) return [];

  const types = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) types.push(extractType(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) types.push(extractType(current.trim()));
  return types;
}

function normalizeSignature(signature) {
  const sig = String(signature || "").trim();
  const match = sig.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!match) return null;
  const name = match[1];
  const start = sig.indexOf("(");
  const end = findMatchingParen(sig, start);
  if (start === -1 || end === -1) return null;
  const types = extractTypes(sig.slice(start + 1, end));
  return `${name}(${types.join(",")})`;
}

function extractNameAndTypesKey(signature) {
  const normalized = normalizeSignature(signature);
  if (!normalized) return null;
  const idx = normalized.indexOf("(");
  return {
    name: normalized.slice(0, idx),
    typesKey: normalized.slice(idx),
    normalized,
  };
}

function computeSelector(signature) {
  const normalized = normalizeSignature(signature);
  if (!normalized) return null;
  return `0x${keccak256(normalized).slice(0, 8)}`;
}

function buildHumanReadableSignature(abiEntry) {
  if (!abiEntry || abiEntry.type !== "function") return null;

  function formatParam(param) {
    let t = param.type;
    if (t === "tuple" || t === "tuple[]") {
      const components = Array.isArray(param.components) ? param.components : [];
      const inner = components.map(formatParam).join(", ");
      t = t === "tuple[]" ? `(${inner})[]` : `(${inner})`;
    }
    const name = param.name || "";
    return `${t}${name ? ` ${name}` : ""}`;
  }

  const name = abiEntry.name;
  const inputs = Array.isArray(abiEntry.inputs) ? abiEntry.inputs : [];
  const params = inputs.map(formatParam).join(", ");
  return `${name}(${params})`;
}

function getAbiFunctionEntries(abi) {
  if (!Array.isArray(abi)) return [];
  return abi.filter((entry) => entry && entry.type === "function" && typeof entry.name === "string");
}

function buildAbiIndex(abiEntries) {
  const byNormalized = new Map();
  const byTypes = new Map();
  const byHumanReadable = new Map();
  const bySelector = new Map();
  const functions = [];

  for (const fn of abiEntries) {
    const human = buildHumanReadableSignature(fn);
    if (!human) continue;
    const normalized = normalizeSignature(human);
    if (!normalized) continue;
    const idx = normalized.indexOf("(");
    const typesKey = normalized.slice(idx);

    const item = {
      name: fn.name,
      normalized,
      typesKey,
      humanReadable: human,
      selector: computeSelector(human),
    };
    functions.push(item);
    byNormalized.set(normalized, item);
    byHumanReadable.set(human, item);
    if (!byTypes.has(typesKey)) byTypes.set(typesKey, []);
    byTypes.get(typesKey).push(item);
    if (item.selector) {
      if (!bySelector.has(item.selector)) bySelector.set(item.selector, []);
      bySelector.get(item.selector).push(item);
    }
  }

  return { functions, byNormalized, byTypes, byHumanReadable, bySelector };
}

function pickClosestOnchainFunction(parsed, abiIndex) {
  const targetNorm = parsed?.normalized || "";
  const targetName = parsed?.name || "";
  const targetArity = parsed?.typesKey === "()" ? 0 : parsed?.typesKey?.slice(1, -1).split(",").length || 0;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const fn of abiIndex.functions) {
    const fnArity = fn.typesKey === "()" ? 0 : fn.typesKey.slice(1, -1).split(",").length;
    const sameNameBonus = fn.name === targetName ? -3 : 0;
    const arityPenalty = Math.abs(fnArity - targetArity) * 2;
    const normDistance = levenshteinDistance(fn.normalized, targetNorm);
    const score = normDistance + arityPenalty + sameNameBonus;
    if (score < bestScore) {
      best = fn;
      bestScore = score;
    }
  }

  return best;
}

function levenshteinDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function pickBestByName(candidates, targetName) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = levenshteinDistance(candidates[0].name.toLowerCase(), targetName.toLowerCase());
  for (const c of candidates.slice(1)) {
    const score = levenshteinDistance(c.name.toLowerCase(), targetName.toLowerCase());
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

async function fetchAbiFromExplorer(chainId, address) {
  const provider = PROVIDERS[chainId];
  if (!provider) {
    throw new Error(`No supported explorer provider configured for chain ${chainId}`);
  }

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key env var: ${provider.apiKeyEnv}`);
  }

  const url =
    `https://${provider.baseUrl}/v2/api` +
    `?chainid=${chainId}` +
    `&module=contract&action=getabi` +
    `&address=${address}` +
    `&apikey=${apiKey}`;

  log(`  📡 Fetching ABI: chain=${chainId}, address=${address}`);
  const response = await callExplorerWithRetry(url);
  if (!response || typeof response !== "object") {
    throw new Error("Explorer response is not JSON");
  }
  if (response.status !== "1" || typeof response.result !== "string") {
    throw new Error(`Explorer error: ${response.message || "unknown"} (${response.result || "no result"})`);
  }

  let abi;
  try {
    abi = JSON.parse(response.result);
  } catch (e) {
    throw new Error(`Failed to parse ABI JSON from explorer: ${e.message}`);
  }
  return abi;
}

async function fetchContractSourceMetadata(chainId, address) {
  const provider = PROVIDERS[chainId];
  if (!provider) {
    throw new Error(`No supported explorer provider configured for chain ${chainId}`);
  }
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key env var: ${provider.apiKeyEnv}`);
  }

  const url =
    `https://${provider.baseUrl}/v2/api` +
    `?chainid=${chainId}` +
    `&module=contract&action=getsourcecode` +
    `&address=${address}` +
    `&apikey=${apiKey}`;

  const response = await callExplorerWithRetry(url);
  if (!response || typeof response !== "object") {
    throw new Error("Explorer response is not JSON");
  }
  if (response.status !== "1" || !Array.isArray(response.result)) {
    throw new Error(`Explorer getsourcecode error: ${response.message || "unknown"} (${response.result || "no result"})`);
  }
  const meta = response.result[0];
  if (!meta || typeof meta !== "object") {
    throw new Error("Explorer getsourcecode returned no metadata");
  }
  return meta;
}

function isNonZeroAddress(addr) {
  if (typeof addr !== "string") return false;
  const cleaned = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(cleaned)) return false;
  return cleaned.toLowerCase() !== "0x0000000000000000000000000000000000000000";
}

function getTargetChains(deployments) {
  const byChain = new Map();
  for (const dep of deployments) {
    if (!dep || typeof dep.chainId !== "number" || typeof dep.address !== "string") continue;
    if (!byChain.has(dep.chainId)) byChain.set(dep.chainId, []);
    byChain.get(dep.chainId).push(dep.address);
  }
  for (const [chainId, addrs] of byChain.entries()) {
    byChain.set(chainId, [...new Set(addrs)]);
  }

  if (!CONFIG.allChains) {
    const chainId = Number(CONFIG.chainId);
    if (!byChain.has(chainId) && CONFIG.chainExplicit) {
      return {
        selected: [],
        skipped: [],
        error: `No deployment found for requested chain ${chainId}`,
      };
    }

    const preferredChainId = byChain.has(chainId) ? chainId : null;
    let singleChainId = preferredChainId;
    if (singleChainId === null) {
      // Default behavior: prefer chain 1; if missing, fall back to first eligible chain.
      for (const depChainId of byChain.keys()) {
        const provider = PROVIDERS[depChainId];
        if (!provider) continue;
        const apiKey = process.env[provider.apiKeyEnv];
        if (!apiKey) continue;
        singleChainId = depChainId;
        break;
      }
      if (singleChainId === null) {
        singleChainId = byChain.keys().next().value;
      }
    }

    const provider = PROVIDERS[singleChainId];
    if (!provider && preferredChainId !== null) {
      return {
        selected: [],
        skipped: [],
        error: `Chain ${singleChainId} is not supported by configured explorer providers`,
      };
    }
    if (!provider && preferredChainId === null) {
      return {
        selected: [],
        skipped: [],
        error: "No supported explorer provider for any deployment chain",
      };
    }

    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey && preferredChainId !== null) {
      return {
        selected: [],
        skipped: [],
        error: `Missing API key for chain ${singleChainId} (${provider.apiKeyEnv})`,
      };
    }
    if (!apiKey && preferredChainId === null) {
      return {
        selected: [],
        skipped: [],
        error: `Missing API key for selected fallback chain ${singleChainId} (${provider.apiKeyEnv})`,
      };
    }

    return {
      selected: [{ chainId: singleChainId, addresses: byChain.get(singleChainId) }],
      skipped: [],
      error: null,
    };
  }

  const selected = [];
  const skipped = [];
  for (const [chainId, addresses] of byChain.entries()) {
    const provider = PROVIDERS[chainId];
    if (!provider) {
      skipped.push({ chainId, reason: "No supported explorer provider" });
      continue;
    }
    const apiKey = process.env[provider.apiKeyEnv];
    if (!apiKey) {
      skipped.push({ chainId, reason: `Missing API key (${provider.apiKeyEnv})` });
      continue;
    }
    selected.push({ chainId, addresses });
  }

  return { selected, skipped, error: null };
}

function analyzeFormatKeysAgainstAbi(formatKeys, abiIndex) {
  const matches = [];
  const mismatches = [];

  for (const key of formatKeys) {
    const parsed = extractNameAndTypesKey(key);
    if (!parsed) {
      const fallback = pickClosestOnchainFunction({ normalized: "", name: "", typesKey: "" }, abiIndex);
      mismatches.push({
        formatKey: key,
        formatKeySelector: null,
        reason: "Unparseable function signature key",
        proposed: fallback
          ? [{
              incorrect: key,
              incorrectSelector: null,
              correct: fallback.humanReadable,
              correctSelector: fallback.selector,
              reason: "Closest on-chain human-readable ABI",
            }]
          : [],
      });
      continue;
    }

    const inputSelector = computeSelector(key);
    const selectorMatches = inputSelector ? (abiIndex.bySelector.get(inputSelector) || []) : [];
    if (selectorMatches.length > 0) {
      const preferred = selectorMatches[0];
      matches.push({
        formatKey: key,
        normalized: parsed.normalized,
        selector: inputSelector,
        onchainHumanReadable: preferred.humanReadable,
      });
      continue;
    }

    const closest = pickClosestOnchainFunction(parsed, abiIndex);
    const proposals = closest
      ? [{
          incorrect: key,
          incorrectSelector: inputSelector,
          correct: closest.humanReadable,
          correctSelector: closest.selector,
          reason: "Selector does not exist on-chain; closest on-chain human-readable ABI",
        }]
      : [];

    mismatches.push({
      formatKey: key,
      formatKeySelector: inputSelector,
      reason: "Computed selector does not exist on-chain",
      proposed: proposals,
    });
  }

  return { matches, mismatches };
}

async function validateChain(filePath, descriptor, chainId, addresses) {
  const formats = descriptor.display?.formats;
  const formatKeys = formats && typeof formats === "object" ? Object.keys(formats) : [];

  if (formatKeys.length === 0) {
    return {
      chainId,
      address: Array.isArray(addresses) && addresses.length > 0 ? addresses[0] : "",
      errors: ["No display.formats keys found in descriptor"],
      addressReports: [],
    };
  }

  const chainAddresses = Array.isArray(addresses) ? addresses : [addresses].filter(Boolean);
  const addressReports = [];
  const errors = [];

  for (const address of chainAddresses) {
    let resolvedAddress = address;
    let proxyInfo = "not-proxy";
    try {
      const meta = await fetchContractSourceMetadata(chainId, address);
      const isProxy = String(meta.Proxy || "").trim() === "1";
      const implementation = String(meta.Implementation || "").trim();
      if (isProxy) {
        if (isNonZeroAddress(implementation)) {
          resolvedAddress = implementation;
          proxyInfo = `proxy->${resolvedAddress}`;
        } else {
          proxyInfo = "proxy->(missing implementation)";
        }
      }
    } catch (e) {
      proxyInfo = `proxy-check-failed: ${e.message}`;
    }

    let abi;
    try {
      abi = await fetchAbiFromExplorer(chainId, resolvedAddress);
    } catch (e) {
      errors.push(`${address}: ${e.message}`);
      addressReports.push({
        address,
        resolvedAddress,
        proxyInfo,
        abiSource: "on-chain explorer",
        abiFunctionCount: 0,
        error: e.message,
        matches: [],
        mismatches: formatKeys.map((k) => ({
          formatKey: k,
          formatKeySelector: computeSelector(k),
          reason: "Could not validate address ABI from explorer",
          proposed: [],
        })),
      });
      continue;
    }

    const abiFunctions = getAbiFunctionEntries(abi);
    const abiIndex = buildAbiIndex(abiFunctions);
    const { matches, mismatches } = analyzeFormatKeysAgainstAbi(formatKeys, abiIndex);
    addressReports.push({
      address,
      resolvedAddress,
      proxyInfo,
      abiSource: "on-chain explorer",
      abiFunctionCount: abiFunctions.length,
      error: null,
      matches,
      mismatches,
    });
  }

  return {
    chainId,
    address: chainAddresses[0] || "",
    errors,
    addressReports,
  };
}

function printReport(filePath, results, skippedChains) {
  console.log("ERC-7730 On-chain Function Consistency Check");
  console.log("============================================");
  console.log(`File: ${path.relative(ROOT_DIR, filePath)}`);
  console.log("");

  if (skippedChains.length > 0) {
    console.log("Skipped chains:");
    for (const s of skippedChains) {
      console.log(`  - chain ${s.chainId}: ${s.reason}`);
    }
    console.log("");
  }

  let totalMismatches = 0;
  let totalAddressWarnings = 0;
  let totalErrors = 0;

  for (const r of results) {
    const chainReports = Array.isArray(r.addressReports) ? r.addressReports : [];
    const chainMismatches = chainReports.reduce((acc, rep) => acc + rep.mismatches.length, 0);
    const mismatchedReports = chainReports.filter((rep) => rep.mismatches.length > 0);
    const fullMatchReports = chainReports.filter((rep) => rep.mismatches.length === 0);
    const chainWarnings = mismatchedReports.length;
    totalMismatches += chainMismatches;
    totalAddressWarnings += chainWarnings;
    totalErrors += r.errors.length;

    console.log(`Chain ${r.chainId}`);
    if (r.errors.length > 0) {
      for (const err of r.errors) {
        console.log(`  ❌ ${err}`);
      }
    }

    console.log(`  Implementations checked: ${chainReports.length}`);
    console.log(`  ✅ Fully matching implementations: ${fullMatchReports.length}`);
    console.log(`  ⚠️  Implementations with mismatches: ${chainWarnings}`);

    if (fullMatchReports.length > 0) {
      console.log("  Fully matching implementation addresses:");
      for (const rep of fullMatchReports) {
        if (rep.resolvedAddress && rep.resolvedAddress.toLowerCase() !== rep.address.toLowerCase()) {
          console.log(`    - ${rep.address} -> ${rep.resolvedAddress}`);
        } else {
          console.log(`    - ${rep.address}`);
        }
      }
    }

    if (mismatchedReports.length > 0) {
      console.log("  Mismatching implementation details:");
    }

    for (const rep of mismatchedReports) {
      console.log(`  - Address ${rep.address}`);
      if (rep.resolvedAddress && rep.resolvedAddress.toLowerCase() !== rep.address.toLowerCase()) {
        console.log(`    Implementation: ${rep.resolvedAddress}`);
      }
      if (rep.proxyInfo) {
        console.log(`    Proxy info:    ${rep.proxyInfo}`);
      }
      console.log(`    ABI source:    ${rep.abiSource}`);
      console.log(`    ABI functions: ${rep.abiFunctionCount}`);
      console.log(`    ✅ Matches:     ${rep.matches.length}`);
      console.log(`    ❌ Mismatches:  ${rep.mismatches.length}`);

      if (rep.error) {
        console.log(`    ⚠️  ${rep.error}`);
      }

      if (rep.mismatches.length > 0) {
        console.log("    Missing descriptor selectors on this implementation:");
        for (const mismatch of rep.mismatches) {
          if (mismatch.proposed.length === 0) {
            console.log(`      - key: "${mismatch.formatKey}"`);
            console.log(`        selector: ${mismatch.formatKeySelector || "n/a"}`);
            console.log("        closest on-chain: (none)");
            continue;
          }
          const best = mismatch.proposed[0];
          console.log(`      - key: "${mismatch.formatKey}"`);
          console.log(`        selector: ${mismatch.formatKeySelector || "n/a"}`);
          console.log(`        closest on-chain: "${best.correct}" (${best.correctSelector || "n/a"})`);
        }
      }
    }
    console.log("");
  }

  if (results.length === 0) {
    console.error("No chains validated.");
    process.exit(1);
  }

  if (totalErrors > 0) {
    console.error(`Finished with ${totalErrors} chain error(s).`);
    process.exit(1);
  }
  if (totalMismatches > 0) {
    console.error(
      `Finished with ${totalMismatches} mismatch(es) across ${totalAddressWarnings} implementation address(es).`
    );
    process.exit(2);
  }

  console.log("All implementation addresses include all descriptor selectors.");
}

async function main() {
  if (!CONFIG.filePath) printHelp(1, "Error: A descriptor file path is required.");

  const filePath = path.resolve(CONFIG.filePath);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`Invalid JSON file: ${e.message}`);
    process.exit(1);
  }

  if (!descriptor.context?.contract) {
    console.error("Input must be a contract descriptor (missing context.contract).");
    process.exit(1);
  }
  if (descriptor.context?.eip712) {
    console.error("EIP-712 descriptors are not supported by this checker.");
    process.exit(1);
  }

  const deployments = Array.isArray(descriptor.context.contract.deployments)
    ? descriptor.context.contract.deployments
    : [];
  if (deployments.length === 0) {
    console.error("No contract deployments found in descriptor.");
    process.exit(1);
  }

  const chainSelection = getTargetChains(deployments);
  if (chainSelection.error) {
    console.error(chainSelection.error);
    if (!CONFIG.allChains) {
      console.error("Use --all-chains to validate all supported deployment chains.");
    }
    process.exit(1);
  }
  if (chainSelection.selected.length === 0) {
    console.error("No deployment chains are eligible for validation (provider/API key constraints).");
    process.exit(1);
  }

  const results = [];
  for (const { chainId, addresses } of chainSelection.selected) {
    const result = await validateChain(filePath, descriptor, chainId, addresses);
    results.push(result);
  }

  printReport(filePath, results, chainSelection.skipped);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  if (CONFIG.verbose) {
    console.error(err.stack);
  } else if (CONFIG.logVerbose) {
    appendLogLine("ERROR", err.stack);
  }
  process.exit(1);
});
