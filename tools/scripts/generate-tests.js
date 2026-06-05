#!/usr/bin/env node
/**
 * ERC-7730 Test Generator
 *
 * Generates test files for ERC-7730 clear signing descriptors by:
 * - Fetching real transactions from block explorers (Etherscan, etc.)
 * - Using LLM to generate EIP-712 message examples
 * - Inferring expected display values from the descriptor
 *
 * Usage:
 *   node tools/scripts/generate-tests.js <erc7730-file> [options]
 *
 * Options:
 *   --dry-run               Preview without writing files
 *   --verbose               Show detailed output
 *   --log <path>            Enable verbose logging and write to file
 *   -l                      Enable verbose logging to tools/scripts/logs/
 *   --depth <n>             Max transactions to search (default: 100)
 *   --max-tests <n>         Max tests to generate per function (default: 3, or 1 with --compact)
 *   --chain <id>            Only process specific chain ID
 *   --compact               Process only one deployment (single chain + address)
 *   --backend <name>        LLM backend: openai, anthropic, cursor (default: openai)
 *   --model <model>         Model name (default depends on backend)
 *   --api-key <key>         API key (overrides env var for the selected backend)
 *   --api-url <url>         Custom API base URL (openai/anthropic backends only)
 *   --no-test               Skip running the clear signing tester after generation
 *   --force-test            Force running the tester on existing tests even at 100% coverage
 *   --device <device>       Tester device: flex, stax, nanosp, nanox (default: flex)
 *   --test-log-level <lvl>  Tester log level: none, error, warn, info, debug (default: info)
 *   --no-refine             Skip refining expectedTexts from tester screen output
 *   --local-api             Auto-start a local Flask API server (patched erc7730)
 *   --local-api-port <port> Port for the local API server (default: 5000)
 *   --help, -h              Show this help message
 *
 * Environment Variables:
 *   ETHERSCAN_API_KEY      API key for Etherscan (Ethereum mainnet)
 *   POLYGONSCAN_API_KEY    API key for Polygonscan
 *   BSCSCAN_API_KEY        API key for BSCScan
 *   ARBISCAN_API_KEY       API key for Arbiscan
 *   OPTIMISM_API_KEY       API key for Optimism Etherscan
 *   BASESCAN_API_KEY       API key for Basescan
 *   OPENAI_API_KEY         API key for openai backend
 *   ANTHROPIC_API_KEY      API key for anthropic backend
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { execSync, spawn } = require("child_process");

// =============================================================================
// Configuration
// =============================================================================

const LOGS_DIR = path.join(__dirname, "logs");
const DEFAULT_LOG_FILE = path.join(LOGS_DIR, `generate-tests-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.verbose.log`);
const LOG_FILE_PATH = getLogFilePath();

const VALID_BACKENDS = ["openai", "anthropic", "cursor"];

const BACKEND_DEFAULTS = {
  openai: {
    model: "gpt-4o",
    url: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
  },
  anthropic: {
    model: "claude-sonnet-4-20250514",
    url: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
  },
  cursor: {
    model: "opus-4.6",
  },
};

const CONFIG = {
  dryRun: process.argv.includes("--dry-run"),
  verbose: process.argv.includes("--verbose"),
  logVerbose: Boolean(LOG_FILE_PATH),
  logFile: LOG_FILE_PATH,
  depth: getArgValue("--depth", 100),
  maxTests: getArgValue("--max-tests", process.argv.includes("--compact") ? 1 : 3),
  chainFilter: getArgValue("--chain", null),
  compact: process.argv.includes("--compact"),
  backend: getArgValue("--backend", "openai"),
  model: getArgValue("--model", null),
  apiKey: getArgValue("--api-key", null),
  apiUrl: getArgValue("--api-url", null),
  runTest: !process.argv.includes("--no-test"),
  forceTest: process.argv.includes("--force-test"),
  testDevice: getArgValue("--device", "flex"),
  testLogLevel: getArgValue("--test-log-level", "info"),
  refine: !process.argv.includes("--no-refine"),
  localApi: process.argv.includes("--local-api"),
  localApiPort: getArgValue("--local-api-port", 5000),
  emitTestEvents: process.argv.includes("--emit-test-events"),
  cursorTimeout: getArgValue("--cursor-timeout", 180) * 1000,
};

// Resolve backend-specific defaults
(function resolveBackendDefaults() {
  if (!VALID_BACKENDS.includes(CONFIG.backend)) {
    console.error(`Error: Unknown backend "${CONFIG.backend}". Valid backends: ${VALID_BACKENDS.join(", ")}`);
    process.exit(1);
  }
  const defaults = BACKEND_DEFAULTS[CONFIG.backend];
  CONFIG.model = CONFIG.model || defaults.model;
  if (CONFIG.backend !== "cursor") {
    CONFIG.apiUrl = CONFIG.apiUrl || defaults.url;
    CONFIG.apiKey = CONFIG.apiKey || process.env[defaults.envKey] || "";
  }
})();

function getArgValue(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    const val = process.argv[idx + 1];
    return isNaN(val) ? val : parseInt(val, 10);
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

function getInputFileArg() {
  const knownValueFlags = new Set([
    "--depth",
    "--max-tests",
    "--chain",
    "--backend",
    "--model",
    "--api-key",
    "--api-url",
    "--device",
    "--test-log-level",
    "--local-api-port",
    "--log",
  ]);
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "-l") continue;
    if (arg.startsWith("-")) {
      if (knownValueFlags.has(arg)) i++;
      continue;
    }
    if (arg.endsWith(".json")) return arg;
  }
  return null;
}

function printHelp(exitCode = 0, errorMessage = null) {
  const write = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    write(errorMessage);
    write("");
  }
  write("Usage: node tools/scripts/generate-tests.js <erc7730-file> [options]");
  write("\nOptions:");
  write("  --dry-run                Preview without writing files");
  write("  --verbose                Show detailed output");
  write("  --log <path>             Enable verbose logging and write to file");
  write("  -l                       Enable verbose logging to tools/scripts/logs/");
  write("  --depth <n>              Max transactions to search (default: 100)");
  write("  --max-tests <n>          Max tests per function (default: 3, or 1 with --compact)");
  write("  --chain <id>             Only process specific chain ID");
  write("  --compact                Only process one chain + one deployment address");
  write("  --backend <name>         LLM backend: openai, anthropic, cursor (default: openai)");
  write("  --model <model>          Model name (default: backend-specific)");
  write("  --api-key <key>          API key (overrides env var for the selected backend)");
  write("  --api-url <url>          Custom API base URL (openai/anthropic backends only)");
  write("  --no-test                Skip running the clear signing tester (on by default)");
  write("  --force-test             Force running tester on existing tests at 100% coverage");
  write("  --device <device>        Tester device: flex, stax, nanosp, nanox (default: flex)");
  write("  --test-log-level <lvl>   Tester log level: none, error, warn, info, debug (default: info)");
  write("  --no-refine              Skip refining expectedTexts from tester screen output");
  write("  --local-api              Auto-start local Flask API server (patched erc7730)");
  write("  --local-api-port <port>  Port for the local API server (default: 5000)");
  write("  --emit-test-events       Emit machine-readable test event lines for batch tooling");
  write("  --help, -h               Show this help message");
  write("\nEnvironment Variables:");
  write("  ETHERSCAN_API_KEY   For downloading transactions from Etherscan");
  write("  OPENAI_API_KEY      API key for the openai backend");
  write("  ANTHROPIC_API_KEY   API key for the anthropic backend");
  write("  GATING_TOKEN        Required for tester (Ledger auth token)");
  write("\nExamples:");
  write("  # OpenAI backend (default)");
  write("  OPENAI_API_KEY=sk-xxx node tools/scripts/generate-tests.js registry/uniswap/eip712-uniswap.json");
  write("");
  write("  # Anthropic backend");
  write("  node tools/scripts/generate-tests.js registry/uniswap/eip712-uniswap.json \\");
  write("    --backend anthropic --api-key YOUR-API-KEY");
  write("");
  write("  # Cursor backend");
  write("  node tools/scripts/generate-tests.js registry/uniswap/eip712-uniswap.json --backend cursor");
  write("");
  write("  # Generate tests and run on Ledger Stax");
  write("  node tools/scripts/generate-tests.js registry/ethena/calldata-ethena.json --device stax");
  write("");
  write("  # Generate tests without running the tester");
  write("  node tools/scripts/generate-tests.js registry/ethena/calldata-ethena.json --no-test");
  process.exit(exitCode);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp(0);
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

const TEST_EVENT_PREFIX = "@@TEST_EVENT@@";

function emitTestEvent(event, payload = {}) {
  if (!CONFIG.emitTestEvents) return;
  const body = { event, ...payload };
  try {
    console.log(`${TEST_EVENT_PREFIX}${JSON.stringify(body)}`);
  } catch {
    // Event emission should never interrupt generation flow.
  }
}

function classifyTesterResultText(resultText) {
  const text = String(resultText || "").toLowerCase();
  if (text.includes("clear signed")) return "clear";
  if (text.includes("partial")) return "partial";
  if (text.includes("blind")) return "blind";
  return "failed";
}

function appendLogLine(level, message) {
  if (!CONFIG.logFile) return;
  try {
    fs.appendFileSync(CONFIG.logFile, `[${new Date().toISOString()}] [${level}] ${stripAnsi(message)}\n`);
  } catch {
    // Logging should not break generation flow.
  }
}

function initLogFile() {
  if (!CONFIG.logFile) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    fs.appendFileSync(
      CONFIG.logFile,
      `\n[${new Date().toISOString()}] generate-tests start: ${process.argv.join(" ")}\n`
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

// =============================================================================
// Block Explorer Providers
// =============================================================================

// Chains where block explorer APIs are unreachable or time out.
// Deployments on these chains are skipped during test generation.
const CHAINS_SKIP_LINT = new Set([
  324,  // zkSync Era — Etherscan v2 API times out, other explorers unreachable
]);

/**
 * Provider registry - maps chainId to explorer configuration
 * Uses unified Etherscan V2 API (api.etherscan.io/v2/api?chainid=X)
 */
const PROVIDERS = {
  1: {
    name: "Etherscan",
    baseUrl: "api.etherscan.io",
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://etherscan.io/tx/",
  },
  56: {
    name: "BSCScan",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://bscscan.com/tx/",
  },
  137: {
    name: "Polygonscan",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://polygonscan.com/tx/",
  },
  42161: {
    name: "Arbiscan",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://arbiscan.io/tx/",
  },
  10: {
    name: "Optimism Etherscan",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://optimistic.etherscan.io/tx/",
  },
  8453: {
    name: "Basescan",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://basescan.org/tx/",
  },
  43114: {
    name: "Snowtrace",
    baseUrl: "api.etherscan.io", // V2 unified API
    apiKeyEnv: "ETHERSCAN_API_KEY",
    explorerUrl: "https://snowtrace.io/tx/",
  },
};

/**
 * Make an HTTPS GET request
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;

    client
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Fetch transactions for an address from a block explorer.
 * Uses Etherscan V2 API format: /v2/api?chainid=X
 * Retries transient failures (NOTOK, network errors) up to 3 times with backoff.
 *
 * @returns {{ transactions: object[], rateLimited: boolean }}
 */
async function fetchTransactions(chainId, address, depth = 100) {
  const provider = PROVIDERS[chainId];
  if (!provider) {
    log(`  ⚠️  No provider configured for chainId ${chainId}`);
    return { transactions: [], rateLimited: false };
  }

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    log(`  ⚠️  Missing API key: ${provider.apiKeyEnv}`);
    return { transactions: [], rateLimited: false };
  }

  const url =
    `https://${provider.baseUrl}/v2/api?chainid=${chainId}&module=account&action=txlist` +
    `&address=${address}&startblock=0&endblock=99999999` +
    `&page=1&offset=${depth}&sort=desc&apikey=${apiKey}`;

  verboseLog(`  📡 Fetching from ${provider.name} (chain ${chainId})...`);

  const maxRetries = 3;
  let wasRateLimited = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await httpsGet(url);
      if (response.status === "1" && Array.isArray(response.result)) {
        return {
          transactions: response.result.filter((tx) => tx.to?.toLowerCase() === address.toLowerCase()),
          rateLimited: false,
        };
      }
      if (response.message === "No transactions found") {
        return { transactions: [], rateLimited: false };
      }
      const detail = typeof response.result === "string" ? response.result : "";
      const isRateLimit = /rate limit/i.test(detail) || /rate limit/i.test(response.message || "");
      if (isRateLimit) wasRateLimited = true;
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 800;
        verboseLog(`  ⚠️  ${provider.name} API error: ${response.message || "Unknown"}${detail ? ` – ${detail}` : ""} (retry ${attempt + 1}/${maxRetries} in ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      log(`  ⚠️  ${provider.name} API error: ${response.message || "Unknown error"}${detail ? ` – ${detail}` : ""}`);
      return { transactions: [], rateLimited: wasRateLimited };
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 800;
        verboseLog(`  ⚠️  ${provider.name} request failed: ${error.message} (retry ${attempt + 1}/${maxRetries} in ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      log(`  ❌ ${provider.name} request failed: ${error.message}`);
      return { transactions: [], rateLimited: wasRateLimited };
    }
  }
  return { transactions: [], rateLimited: wasRateLimited };
}

// =============================================================================
// Ledger Explorer API
// =============================================================================

/**
 * Maps chainId to Ledger explorer API coin path.
 * API base: https://explorers.api.vault.ledger.com/blockchain/v4/{coin}/
 * No API key required.
 */
const LEDGER_EXPLORER_CHAINS = {
  1: "eth",
  56: "bnb",
  137: "matic",
  43114: "avax",
};

/**
 * Fetch transaction details from Ledger's explorer API.
 * Returns the full transaction object with input data.
 *
 * @param {number} chainId
 * @param {string} txHash
 * @returns {Promise<object|null>} Transaction data or null
 */
async function fetchTransactionFromLedger(chainId, txHash) {
  const coin = LEDGER_EXPLORER_CHAINS[chainId];
  if (!coin) {
    verboseLog(`   ⚠️  No Ledger explorer mapping for chainId ${chainId}`, "WARN");
    return null;
  }

  const url =
    `https://explorers.api.vault.ledger.com/blockchain/v4/${coin}/tx/${txHash}?noinput=false`;

  verboseLog(`   📡 Fetching tx details from Ledger explorer (${coin})...`);

  try {
    const response = await httpsGet(url);
    if (response && response.hash) {
      return response;
    }
    return null;
  } catch (error) {
    verboseLog(`   ⚠️  Ledger explorer request failed: ${error.message}`, "WARN");
    return null;
  }
}

// =============================================================================
// RLP Encoding (minimal implementation for unsigned transaction serialization)
// =============================================================================

/**
 * RLP-encode a value. Accepts Buffer/Uint8Array (byte string) or Array (list).
 * @param {Buffer|Uint8Array|Array} input
 * @returns {Buffer}
 */
function rlpEncode(input) {
  if (Array.isArray(input)) {
    // Encode as list: concatenate encoded items, then wrap with list prefix
    const encoded = Buffer.concat(input.map((item) => rlpEncode(item)));
    return Buffer.concat([rlpLength(encoded.length, 0xc0), encoded]);
  }

  // Ensure input is a Buffer
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // Single byte in [0x00, 0x7f]
  if (buf.length === 1 && buf[0] < 0x80) {
    return buf;
  }

  // Short string (0-55 bytes)
  return Buffer.concat([rlpLength(buf.length, 0x80), buf]);
}

/**
 * Encode the RLP length prefix.
 * For lengths <= 55: single byte (offset + length)
 * For lengths > 55: (offset + 55 + byte-length-of-length) || length bytes
 */
function rlpLength(len, offset) {
  if (len <= 55) {
    return Buffer.from([offset + len]);
  }
  const lenBytes = intToBuffer(len);
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

/**
 * Convert a non-negative integer to a big-endian Buffer with no leading zeros.
 * 0 returns empty Buffer (RLP encodes 0 as empty byte string).
 */
function intToBuffer(n) {
  if (typeof n === "string") {
    // Handle hex strings
    if (n.startsWith("0x") || n.startsWith("0X")) {
      const hex = n.slice(2);
      if (hex === "" || hex === "0") return Buffer.alloc(0);
      // Ensure even length
      const padded = hex.length % 2 === 0 ? hex : "0" + hex;
      return Buffer.from(padded, "hex");
    }
    // Decimal string
    n = BigInt(n);
  }
  if (typeof n === "number") {
    n = BigInt(n);
  }
  if (n === 0n || n === 0) return Buffer.alloc(0);

  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  return Buffer.from(padded, "hex");
}

/**
 * Convert an address string to a 20-byte Buffer.
 */
function addressToBuffer(addr) {
  if (!addr || addr === "0x" || addr === "0x0") return Buffer.alloc(0);
  return Buffer.from(addr.replace("0x", "").padStart(40, "0"), "hex");
}

/**
 * Convert a hex data string to a Buffer.
 */
function hexToBuffer(hex) {
  if (!hex || hex === "0x") return Buffer.alloc(0);
  return Buffer.from(hex.replace("0x", ""), "hex");
}

// =============================================================================
// Unsigned Transaction Serialization
// =============================================================================

/**
 * Build an unsigned raw transaction (RLP-encoded) from Ledger explorer tx data.
 *
 * Supports:
 *   - Type 0 (legacy) with EIP-155 replay protection
 *   - Type 1 (EIP-2930)
 *   - Type 2 (EIP-1559)
 *
 * @param {object} txData - Transaction data from Ledger explorer API
 * @param {number} chainId - Chain ID
 * @returns {string} Hex-encoded unsigned raw transaction (0x-prefixed)
 */
function buildUnsignedRawTx(txData, chainId) {
  const type = txData.transaction_type || 0;
  const nonce = intToBuffer(txData.nonce);
  const gasLimit = intToBuffer(txData.gas);
  const to = addressToBuffer(txData.to);
  const value = intToBuffer(txData.value || "0");
  const data = hexToBuffer(txData.input || "0x");

  if (type === 2) {
    // EIP-1559: 0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
    //                         gasLimit, to, value, data, accessList])
    const fields = [
      intToBuffer(chainId),
      nonce,
      intToBuffer(txData.max_priority_fee_per_gas || "0"),
      intToBuffer(txData.max_fee_per_gas || "0"),
      gasLimit,
      to,
      value,
      data,
      [], // accessList (empty)
    ];
    const payload = rlpEncode(fields);
    return "0x02" + payload.toString("hex");
  }

  if (type === 1) {
    // EIP-2930: 0x01 || RLP([chainId, nonce, gasPrice, gasLimit, to, value,
    //                         data, accessList])
    const fields = [
      intToBuffer(chainId),
      nonce,
      intToBuffer(txData.gas_price || "0"),
      gasLimit,
      to,
      value,
      data,
      [], // accessList (empty)
    ];
    const payload = rlpEncode(fields);
    return "0x01" + payload.toString("hex");
  }

  // Legacy (type 0) with EIP-155 replay protection:
  // RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
  const fields = [
    nonce,
    intToBuffer(txData.gas_price || "0"),
    gasLimit,
    to,
    value,
    data,
    intToBuffer(chainId),
    Buffer.alloc(0), // 0
    Buffer.alloc(0), // 0
  ];
  return "0x" + rlpEncode(fields).toString("hex");
}

// =============================================================================
// Raw Transaction Fetching
// =============================================================================

/**
 * Get the unsigned raw transaction for a given tx hash.
 *
 * Strategy:
 *   1. Fetch tx details from Ledger explorer API (no API key needed)
 *   2. Reconstruct the unsigned raw tx via RLP encoding
 *   3. Fallback: try Etherscan eth_getRawTransactionByHash
 *
 * @param {number} chainId
 * @param {string} txHash
 * @returns {Promise<string|null>} Hex-encoded unsigned raw tx, or null
 */
async function getRawTransaction(chainId, txHash) {
  // Strategy 1: Ledger explorer API + RLP reconstruction
  const ledgerTx = await fetchTransactionFromLedger(chainId, txHash);
  if (ledgerTx && ledgerTx.input) {
    try {
      const rawTx = buildUnsignedRawTx(ledgerTx, chainId);
      verboseLog(`   ✅ Built unsigned raw tx from Ledger explorer (type ${ledgerTx.transaction_type || 0})`, "INFO");
      return rawTx;
    } catch (error) {
      verboseLog(`   ⚠️  Failed to build raw tx: ${error.message}`, "WARN");
    }
  }

  // Strategy 2: Etherscan eth_getRawTransactionByHash (returns signed raw tx)
  const provider = PROVIDERS[chainId];
  if (provider) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (apiKey) {
      const url =
        `https://${provider.baseUrl}/v2/api?chainid=${chainId}&module=proxy&action=eth_getRawTransactionByHash` +
        `&txhash=${txHash}&apikey=${apiKey}`;

      try {
        const response = await httpsGet(url);
        if (response.result && response.result.startsWith("0x") && response.result.length > 10) {
          verboseLog("   ✅ Got signed raw tx from Etherscan", "INFO");
          return response.result;
        }
      } catch (error) {
        // Fall through
      }
    }
  }

  return null;
}

// =============================================================================
// Function Signature Utilities
// =============================================================================

/**
 * Compute function selector (first 4 bytes of keccak256 hash)
 */
function computeSelector(signature) {
  // Normalize signature: remove param names, spaces
  const normalized = normalizeSignature(signature);
  const hash = crypto.createHash("sha3-256");
  // Note: Node's sha3-256 is actually Keccak-256
  // For proper Keccak, we need to use a different approach
  return keccak256(normalized).slice(0, 10);
}

/**
 * Simple Keccak-256 implementation for function selectors
 */
function keccak256(input) {
  // Use the keccak256 from crypto if available (Node 16+)
  // Otherwise fall back to a pure JS implementation
  try {
    const { createHash } = require("crypto");
    // Node.js doesn't have native keccak, so we'll compute selector differently
    // For now, extract from signature pattern
    return computeSelectorFromSignature(input);
  } catch (e) {
    return computeSelectorFromSignature(input);
  }
}

/**
 * Compute selector using Web Crypto or manual implementation
 */
function computeSelectorFromSignature(signature) {
  // Keccak-256 implementation for function selectors
  const Keccak = require("./keccak-tiny");
  if (typeof Keccak !== "undefined") {
    return "0x" + Keccak.keccak256(signature).slice(0, 8);
  }

  // Fallback: use a lookup table for common functions
  // This is a simplified approach - in production, use a proper keccak library
  const hash = simpleHash(signature);
  return "0x" + hash.slice(0, 8);
}

/**
 * Simple hash fallback (not cryptographically secure, just for matching)
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/**
 * Normalize function signature for selector computation
 * "transfer(address to, uint256 amount)" -> "transfer(address,uint256)"
 */
function normalizeSignature(signature) {
  // Extract function name
  const match = signature.match(/^(\w+)\s*\(/);
  if (!match) return signature;

  const funcName = match[1];
  const paramsStart = signature.indexOf("(");
  const paramsEnd = signature.lastIndexOf(")");
  const paramsStr = signature.slice(paramsStart + 1, paramsEnd);

  // Parse parameters and extract only types
  const types = extractTypes(paramsStr);
  return `${funcName}(${types.join(",")})`;
}

/**
 * Extract parameter types from a parameter string
 */
function extractTypes(paramsStr) {
  if (!paramsStr.trim()) return [];

  const types = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < paramsStr.length; i++) {
    const char = paramsStr[i];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      types.push(extractType(current.trim()));
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    types.push(extractType(current.trim()));
  }

  return types;
}

/**
 * Extract type from a parameter declaration
 * "address to" -> "address"
 * "(address srcToken, uint256 amount) desc" -> "(address,uint256)"
 */
function extractType(param) {
  param = param.trim();

  // Handle tuple types
  if (param.startsWith("(")) {
    const tupleEnd = findMatchingParen(param, 0);
    const tupleContent = param.slice(1, tupleEnd);
    const innerTypes = extractTypes(tupleContent);
    const suffix = param.slice(tupleEnd + 1).trim();

    // Check for array notation
    let arrayNotation = "";
    const arrayMatch = suffix.match(/^(\[\d*\])+/);
    if (arrayMatch) {
      arrayNotation = arrayMatch[0];
    }

    return `(${innerTypes.join(",")})${arrayNotation}`;
  }

  // Handle simple types: "address to" -> "address"
  const parts = param.split(/\s+/);
  let type = parts[0];

  // Check if array notation is attached or separate
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].match(/^\[\d*\]/)) {
      type += parts[i];
    }
  }

  // Handle array notation in type itself
  const typeMatch = param.match(/^(\w+(?:\[\d*\])*)/);
  if (typeMatch) {
    return typeMatch[1];
  }

  return type;
}

/**
 * Find matching closing parenthesis
 */
function findMatchingParen(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "(") depth++;
    if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return str.length;
}

/**
 * Extract selector from calldata
 */
function extractSelector(input) {
  if (!input || input.length < 10) return null;
  return input.slice(0, 10).toLowerCase();
}

// =============================================================================
// ERC-7730 Parser
// =============================================================================

/**
 * Resolve a descriptor that uses `includes` via the erc7730 CLI, returning the
 * merged JSON with all includes inlined.  Falls back to null on any error so
 * callers can continue with the raw (unresolved) JSON.
 */
function resolveDescriptorWithCli(filePath, isV2) {
  const attempts = isV2 ? ["--v2", ""] : [""];
  for (const flag of attempts) {
    try {
      const cmd = flag ? `erc7730 resolve ${flag} "${filePath}"` : `erc7730 resolve "${filePath}"`;
      const output = execSync(cmd, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });
      return JSON.parse(output);
    } catch (err) {
      verboseLog(`  ⚠️  erc7730 resolve${flag ? ` ${flag}` : ""} failed for ${path.basename(filePath)}: ${err.message}`, "WARN");
    }
  }
  return null;
}

/**
 * Create a temporary file containing the resolved (includes-inlined) descriptor.
 * The tester / API requires a self-contained descriptor with `display`; files that
 * derive their formats via `includes` must be resolved first.
 *
 * @param {string} filePath - Original descriptor path
 * @returns {string|null} Path to the temp file, or null if resolution failed/unnecessary
 */
/**
 * Deep-merge two plain objects (b overrides a). Arrays are replaced, not concatenated.
 */
function deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (b[key] != null && typeof b[key] === "object" && !Array.isArray(b[key]) &&
        a[key] != null && typeof a[key] === "object" && !Array.isArray(a[key])) {
      result[key] = deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

/**
 * Recursively resolve the `includes` chain for a descriptor, producing a single
 * self-contained JSON in the **input** format (not the resolved/structured format).
 * Returns null if there are no includes.
 */
function mergeIncludes(filePath, visited = new Set()) {
  if (visited.has(filePath)) return null;
  visited.add(filePath);

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (raw.includes == null) return raw;

  const includeRef = typeof raw.includes === "string" ? raw.includes : null;
  if (!includeRef || /^[a-z]+:\/\//i.test(includeRef)) return raw;

  const includePath = path.resolve(path.dirname(filePath), includeRef);
  if (!fs.existsSync(includePath)) return raw;

  const base = mergeIncludes(includePath, visited);
  if (!base) return raw;

  const merged = deepMerge(base, raw);
  delete merged.includes;
  return merged;
}

/**
 * Create a temporary file containing the include-merged descriptor in input format.
 * The tester / API requires a self-contained descriptor with `display`.
 *
 * @param {string} filePath - Original descriptor path
 * @returns {string|null} Path to the temp file, or null if resolution failed/unnecessary
 */
function createResolvedDescriptorTempFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw.includes == null) return null;

    const merged = mergeIncludes(filePath);
    if (!merged || !merged.display) return null;

    const tmpPath = filePath.replace(/\.json$/, ".resolved.tmp.json");
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
    verboseLog(`  ℹ️  Created merged descriptor for tester: ${path.basename(tmpPath)}`, "INFO");
    return tmpPath;
  } catch (err) {
    verboseLog(`  ⚠️  Could not create merged descriptor: ${err.message}`, "WARN");
    return null;
  }
}

/**
 * Build a human-readable function signature from an ABI entry.
 *   { name: "deposit", inputs: [{type:"uint256",name:"assets"},{type:"address",name:"receiver"}] }
 *   => "deposit(uint256 assets,address receiver)"
 */
function abiEntryToSignature(entry) {
  const params = (entry.inputs || []).map((i) => `${i.type} ${i.name}`).join(",");
  return `${entry.name}(${params})`;
}

/**
 * Parse an ERC-7730 file and extract relevant information.
 * When the descriptor uses `includes`, the erc7730 CLI is used to resolve the
 * full merged descriptor so that inherited display.formats are visible.
 */
function parseErc7730(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(content);

  const hasIncludes = json.includes != null;
  const isV2 = json.$schema?.includes?.("erc7730-v2") ?? false;

  let resolved = null;
  if (hasIncludes) {
    resolved = resolveDescriptorWithCli(filePath, isV2);
  }

  const result = {
    filePath,
    fileName: path.basename(filePath),
    isCalldata: !!json.context?.contract || !!resolved?.context?.contract,
    isEip712: !!json.context?.eip712 || !!resolved?.context?.eip712,
    deployments: [],
    functions: [],
    messageTypes: [],
    metadata: json.metadata || {},
  };

  // Extract deployments — prefer raw JSON (leaf always has its own deployments)
  if (json.context?.contract?.deployments) {
    result.deployments = json.context.contract.deployments;
  } else if (json.context?.eip712?.deployments) {
    result.deployments = json.context.eip712.deployments;
  } else if (resolved?.context?.contract?.deployments) {
    result.deployments = resolved.context.contract.deployments;
  } else if (resolved?.context?.eip712?.deployments) {
    result.deployments = resolved.context.eip712.deployments;
  }

  // Determine the source for display.formats:
  //   - If the raw JSON has its own formats, use them (original behaviour).
  //   - Otherwise, if we resolved via CLI, reconstruct from the resolved output.
  const rawFormats = json.display?.formats;

  if (rawFormats && Object.keys(rawFormats).length > 0) {
    // Raw JSON has formats — use them directly (no include resolution needed)
    for (const [key, format] of Object.entries(rawFormats)) {
      if (result.isCalldata) {
        const selector = computeSelectorManual(key);
        result.functions.push({
          signature: key,
          selector,
          intent: format.intent || format.$id || key,
          fields: format.fields || [],
          required: format.required || [],
        });
      } else if (result.isEip712) {
        result.messageTypes.push({
          primaryType: extractPrimaryType(key),
          encodeType: key,
          intent: format.intent || key,
          fields: format.fields || [],
          required: format.required || [],
        });
      }
    }
  } else if (resolved?.display?.formats) {
    // Formats came from resolved includes — keys are 4-byte selectors (calldata)
    // or encodeType strings (EIP-712). Reconstruct human-readable signatures from
    // the ABI entries provided in the resolved output.
    const resolvedFormats = resolved.display.formats;

    if (result.isCalldata) {
      // Build selector -> signature map from ABI
      const abi = resolved.context?.contract?.abi || [];
      const selectorToSig = new Map();
      for (const entry of abi) {
        if (entry.name) {
          const sig = abiEntryToSignature(entry);
          const sel = computeSelectorManual(sig);
          selectorToSig.set(sel, sig);
        }
      }

      for (const [key, format] of Object.entries(resolvedFormats)) {
        const selector = key.startsWith("0x") ? key.toLowerCase() : computeSelectorManual(key);
        const signature = selectorToSig.get(selector) || key;
        result.functions.push({
          signature,
          selector,
          intent: format.intent || format.$id || key,
          fields: format.fields || [],
          required: format.required || [],
        });
      }
    } else if (result.isEip712) {
      for (const [key, format] of Object.entries(resolvedFormats)) {
        result.messageTypes.push({
          primaryType: extractPrimaryType(key),
          encodeType: key,
          intent: format.intent || key,
          fields: format.fields || [],
          required: format.required || [],
        });
      }
    }

    if (result.functions.length > 0 || result.messageTypes.length > 0) {
      verboseLog(
        `  ℹ️  Resolved ${result.functions.length + result.messageTypes.length} format(s) from includes for ${path.basename(filePath)}`,
        "INFO"
      );
    }
  }

  // Also check for EIP-712 schemas (v1 format)
  if (json.context?.eip712?.schemas && result.messageTypes.length === 0) {
    const schemas = json.context.eip712.schemas;
    if (Array.isArray(schemas)) {
      for (const schema of schemas) {
        if (schema.primaryType && schema.types) {
          result.messageTypes.push({
            primaryType: schema.primaryType,
            schema: schema,
            intent: schema.primaryType,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Extract primary type from encodeType string
 */
function extractPrimaryType(encodeType) {
  const match = encodeType.match(/^([\w:]+)\(/);
  return match ? match[1] : encodeType;
}

/**
 * Manually compute selector using a pure JS Keccak implementation
 */
function computeSelectorManual(signature) {
  const normalized = normalizeSignature(signature);
  // Use a simple lookup or compute
  return computeKeccak256Selector(normalized);
}

/**
 * Keccak-256 selector computation (simplified)
 * In production, use a proper library like 'keccak' or 'js-sha3'
 */
function computeKeccak256Selector(input) {
  // Try to use js-sha3 if available
  try {
    const { keccak256 } = require("js-sha3");
    return "0x" + keccak256(input).slice(0, 8);
  } catch (e) {
    // Fallback: use built-in crypto with SHA3-256 (not exactly Keccak but close for our purposes)
    try {
      const hash = crypto.createHash("sha3-256").update(input).digest("hex");
      return "0x" + hash.slice(0, 8);
    } catch (e2) {
      // Ultimate fallback
      return "0x" + simpleHash(input);
    }
  }
}

// =============================================================================
// Test Generation
// =============================================================================

/**
 * Generate test cases for calldata functions
 * @param {object} erc7730 - Parsed descriptor
 * @param {object} report - Generation report
 * @param {Set<string>} [coveredFunctions] - Function signatures already covered by existing tests
 */
async function generateCalldataTests(erc7730, report, coveredFunctions = new Set()) {
  const tests = [];
  let generatedTargets = 0;
  let skippedTargets = 0;
  let generatedTestCases = 0;
  const deploymentsToProcess = selectDeploymentsForGeneration(erc7730.deployments);
  const txCache = new Map();
  let deploymentRateLimited = false;

  function normalizeChainId(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function getTransactionsCached(chainId, address) {
    const key = `${chainId}:${String(address || "").toLowerCase()}`;
    if (txCache.has(key)) {
      return txCache.get(key);
    }
    const result = await fetchTransactions(chainId, address, CONFIG.depth);
    if (result.rateLimited) deploymentRateLimited = true;
    txCache.set(key, result.transactions);
    return result.transactions;
  }

  for (const deployment of deploymentsToProcess) {
    const { chainId, address } = deployment;
    const normalizedChainId = normalizeChainId(chainId);

    // Apply chain filter if specified
    if (!CONFIG.compact && CONFIG.chainFilter && chainId !== parseInt(CONFIG.chainFilter)) {
      continue;
    }

    if (CHAINS_SKIP_LINT.has(normalizedChainId)) {
      log(`\n⚠️  Skipping chain ${chainId} (${address}) — block explorer APIs unreachable for this chain`);
      continue;
    }

    log(`\n📍 Processing ${address} on chain ${chainId}`);

    const transactions = await getTransactionsCached(chainId, address);
    log(`   Found ${transactions.length} transactions`);

    for (const func of erc7730.functions) {
      const targetLabel = func.intent || func.signature;
      const selector = func.selector?.toLowerCase();
      if (!selector) {
        skippedTargets++;
        emitTestEvent("generation_target", {
          targetType: "function",
          target: func.signature,
          label: targetLabel,
          status: "skipped",
          reason: "missing_selector",
          testCases: 0,
        });
        continue;
      }

      // Skip functions already covered by existing tests
      if (coveredFunctions.has(func.signature)) {
        log(`   ✔️  ${targetLabel}: already covered — skipping`);
        skippedTargets++;
        emitTestEvent("generation_target", {
          targetType: "function",
          target: func.signature,
          label: targetLabel,
          status: "skipped",
          reason: "already_covered",
          testCases: 0,
        });
        continue;
      }

      // Find transactions matching this function
      const matching = transactions.filter((tx) => {
        const txSelector = extractSelector(tx.input);
        return txSelector === selector;
      });

      let matchingSourceAddress = address;
      let matchingSourceLabel = `selected deployment ${address}`;
      let fallbackAttempts = 0;
      let examples = matching.slice(0, CONFIG.maxTests);

      // Compact mode fallback:
      // if no examples on the selected deployment, try other deployments on same chain.
      if (CONFIG.compact && examples.length === 0 && normalizedChainId !== null) {
        const sameChainFallbacks = (erc7730.deployments || []).filter((d) => {
          const dChain = normalizeChainId(d?.chainId);
          const dAddress = String(d?.address || "").toLowerCase();
          return (
            dChain === normalizedChainId &&
            dAddress &&
            dAddress !== String(address || "").toLowerCase()
          );
        });

        for (const fallback of sameChainFallbacks) {
          fallbackAttempts++;
          const fallbackTxs = await getTransactionsCached(chainId, fallback.address);
          const fallbackMatching = fallbackTxs.filter((tx) => {
            const txSelector = extractSelector(tx.input);
            return txSelector === selector;
          });
          if (fallbackMatching.length > 0) {
            matchingSourceAddress = fallback.address;
            matchingSourceLabel = `fallback deployment ${fallback.address}`;
            examples = fallbackMatching.slice(0, CONFIG.maxTests);
            break;
          }
        }
      }

      if (CONFIG.compact && fallbackAttempts > 0) {
        log(
          `   🔍 ${targetLabel}: ${examples.length} matches (${matchingSourceLabel}; ${fallbackAttempts} fallback address(es) tried)`
        );
      } else {
        log(`   🔍 ${targetLabel}: ${examples.length} matches`);
      }

      let generatedForTarget = 0;
      for (const tx of examples) {
        // Get unsigned raw transaction (Ledger explorer + RLP reconstruction)
        let rawTx = await getRawTransaction(chainId, tx.hash);

        if (!rawTx) {
          // Could not fetch or reconstruct — skip this test case
          report.warnings.push(
            `Chain ${chainId}: Could not build raw tx for ${tx.hash} (no Ledger explorer support and Etherscan fallback failed)`
          );
          continue;
        }

        const testCase = {
          description: `${func.intent || extractFunctionName(func.signature)} - chain ${chainId}`,
          rawTx: rawTx,
          txHash: tx.hash,
        };

        // Infer expected texts (always include field, refinement fills it in later)
        testCase.expectedTexts = inferExpectedTexts(func, erc7730.metadata);

        tests.push(testCase);
        generatedForTarget++;
        generatedTestCases++;
        report.generated.push({
          type: "calldata",
          chainId,
          function: func.signature,
          address: matchingSourceAddress,
          txHash: tx.hash,
        });
      }

      if (examples.length === 0) {
        const rateLimitNote = deploymentRateLimited ? " (API rate limited — results may be incomplete)" : "";
        report.notFound.push({
          type: "calldata",
          chainId,
          function: func.signature,
          reason: CONFIG.compact
            ? `No matching transactions found on selected deployment or same-chain fallback addresses${rateLimitNote}`
            : `No matching transactions found${rateLimitNote}`,
        });
      }

      if (generatedForTarget > 0) {
        generatedTargets++;
        emitTestEvent("generation_target", {
          targetType: "function",
          target: func.signature,
          label: targetLabel,
          status: "generated",
          reason: null,
          testCases: generatedForTarget,
        });
      } else {
        skippedTargets++;
        const noDataReason = deploymentRateLimited
          ? "rate_limited"
          : examples.length === 0
            ? "no_matching_transactions"
            : "no_usable_transactions";
        emitTestEvent("generation_target", {
          targetType: "function",
          target: func.signature,
          label: targetLabel,
          status: deploymentRateLimited ? "rate_limited" : "no_data",
          reason: noDataReason,
          testCases: 0,
        });
      }
    }
  }

  emitTestEvent("generation_summary", {
    targetType: "function",
    generatedTargets,
    skippedTargets,
    generatedTestCases,
  });

  return tests;
}

/**
 * Select deployments to process.
 * In compact mode, picks exactly one deployment using this preference order:
 *   1) --chain value (if provided and present in descriptor)
 *   2) chainId 1 (Ethereum mainnet), if present
 *   3) first chainId from descriptor deployments
 * Then picks the first deployment address on that selected chain.
 */
function selectDeploymentsForGeneration(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return [];
  }

  if (!CONFIG.compact) {
    return deployments;
  }

  const normalizeChainId = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const requestedChain = normalizeChainId(CONFIG.chainFilter);
  const firstChainInFile = normalizeChainId(deployments[0]?.chainId);

  const preferredChains = [];
  if (requestedChain !== null) preferredChains.push(requestedChain);
  if (!preferredChains.includes(1)) preferredChains.push(1);
  if (firstChainInFile !== null && !preferredChains.includes(firstChainInFile)) {
    preferredChains.push(firstChainInFile);
  }

  let selectedChain = null;
  let selectionReason = "";
  for (const chainId of preferredChains) {
    if (deployments.some((d) => normalizeChainId(d.chainId) === chainId)) {
      selectedChain = chainId;
      if (requestedChain !== null && chainId === requestedChain) {
        selectionReason = "--chain";
      } else if (chainId === 1) {
        selectionReason = "ethereum-mainnet";
      } else {
        selectionReason = "first-chain-in-file";
      }
      break;
    }
  }

  if (selectedChain === null) {
    selectedChain = firstChainInFile;
    selectionReason = "first-chain-in-file";
  }

  const selectedDeployment = deployments.find(
    (d) => normalizeChainId(d.chainId) === selectedChain
  ) || deployments[0];

  console.log(
    `ℹ️  Compact mode: selected ${selectedDeployment.address} on chain ${selectedDeployment.chainId} (${selectionReason})`
  );

  return [selectedDeployment];
}

/**
 * Generate test cases for EIP-712 messages using LLM
 * @param {object} erc7730 - Parsed descriptor
 * @param {object} report - Generation report
 * @param {Set<string>} [coveredMessageTypes] - Primary types already covered by existing tests
 */
async function generateEip712Tests(erc7730, report, coveredMessageTypes = new Set()) {
  const tests = [];
  let generatedTargets = 0;
  let skippedTargets = 0;
  let generatedTestCases = 0;

  for (const msgType of erc7730.messageTypes) {
    // Skip message types already covered by existing tests
    if (coveredMessageTypes.has(msgType.primaryType)) {
      log(`\n✔️  ${msgType.primaryType}: already covered — skipping`);
      skippedTargets++;
      emitTestEvent("generation_target", {
        targetType: "messageType",
        target: msgType.primaryType,
        label: msgType.intent || msgType.primaryType,
        status: "skipped",
        reason: "already_covered",
        testCases: 0,
      });
      continue;
    }

    log(`\n📝 Generating EIP-712 test for: ${msgType.primaryType}`);

    // Try to generate example using LLM
    const example = await generateEip712Example(msgType, erc7730);

    if (example) {
      const testCase = {
        description: `${msgType.intent || msgType.primaryType}`,
        data: example,
      };

      // Infer expected texts (always include field, refinement fills it in later)
      testCase.expectedTexts = inferExpectedTextsEip712(msgType, erc7730.metadata);

      tests.push(testCase);
      generatedTargets++;
      generatedTestCases++;
      report.generated.push({
        type: "eip712",
        messageType: msgType.primaryType,
      });
      emitTestEvent("generation_target", {
        targetType: "messageType",
        target: msgType.primaryType,
        label: msgType.intent || msgType.primaryType,
        status: "generated",
        reason: null,
        testCases: 1,
      });
    } else {
      skippedTargets++;
      report.notFound.push({
        type: "eip712",
        messageType: msgType.primaryType,
        reason: "Could not generate example",
      });
      emitTestEvent("generation_target", {
        targetType: "messageType",
        target: msgType.primaryType,
        label: msgType.intent || msgType.primaryType,
        status: "skipped",
        reason: "generation_failed",
        testCases: 0,
      });
    }
  }

  emitTestEvent("generation_summary", {
    targetType: "messageType",
    generatedTargets,
    skippedTargets,
    generatedTestCases,
  });

  return tests;
}

/**
 * Generate EIP-712 example data using LLM or schema
 */
async function generateEip712Example(msgType, erc7730) {
  // If we have a schema, generate example from it
  if (msgType.schema) {
    return generateFromSchema(msgType.schema, erc7730.deployments[0]);
  }

  // Try using LLM
  if (CONFIG.backend !== "cursor" && !CONFIG.apiKey) {
    log(`   ⚠️  No API key set for ${CONFIG.backend} backend (use --api-key or env var), generating placeholder example`);
    return generatePlaceholderExample(msgType, erc7730.deployments[0]);
  }

  try {
    const prompt = buildEip712Prompt(msgType, erc7730);
    const response = await invokeLLM(prompt);
    return extractJson(response);
  } catch (error) {
    log(`   ❌ LLM generation failed: ${error.message}`);
    return generatePlaceholderExample(msgType, erc7730.deployments[0]);
  }
}

/**
 * Generate example from EIP-712 schema
 */
function generateFromSchema(schema, deployment) {
  const types = schema.types;
  const primaryType = schema.primaryType;

  // Build domain
  const domain = {
    name: "Example",
    version: "1",
    chainId: deployment?.chainId || 1,
    verifyingContract: deployment?.address || "0x0000000000000000000000000000000000000000",
  };

  // Generate message based on types
  const message = generateMessageFromTypes(types, primaryType);

  return {
    types,
    primaryType,
    domain,
    message,
  };
}

/**
 * Generate message object from type definitions
 */
function generateMessageFromTypes(types, typeName) {
  const typeFields = types[typeName];
  if (!typeFields) return {};

  const message = {};
  for (const field of typeFields) {
    message[field.name] = generateFieldValue(field.type, types);
  }
  return message;
}

/**
 * Generate a placeholder value for a field type
 */
function generateFieldValue(type, types) {
  // Handle arrays
  if (type.endsWith("[]")) {
    const baseType = type.slice(0, -2);
    return [generateFieldValue(baseType, types)];
  }

  // Handle custom types
  if (types && types[type]) {
    return generateMessageFromTypes(types, type);
  }

  // Handle basic types
  switch (type) {
    case "address":
      return "0x" + "1".repeat(40);
    case "uint256":
    case "uint128":
    case "uint64":
    case "uint48":
    case "uint32":
    case "uint16":
    case "uint8":
      return "1000000000000000000";
    case "int256":
    case "int128":
    case "int64":
    case "int32":
    case "int16":
    case "int8":
      return "0";
    case "bool":
      return true;
    case "string":
      return "example";
    case "bytes":
      return "0x";
    case "bytes32":
      return "0x" + "0".repeat(64);
    default:
      if (type.startsWith("bytes")) {
        const len = parseInt(type.slice(5)) || 32;
        return "0x" + "0".repeat(len * 2);
      }
      if (type.startsWith("uint")) {
        return "0";
      }
      return "0x0";
  }
}

/**
 * Generate placeholder example when no schema or LLM available
 */
function generatePlaceholderExample(msgType, deployment) {
  // Parse encodeType to extract fields
  const fields = parseEncodeType(msgType.encodeType || msgType.primaryType);

  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  };

  // Add primary type
  types[msgType.primaryType] = fields;

  return {
    types,
    primaryType: msgType.primaryType,
    domain: {
      name: "Example",
      version: "1",
      chainId: deployment?.chainId || 1,
      verifyingContract: deployment?.address || "0x0000000000000000000000000000000000000000",
    },
    message: generateMessageFromTypes(types, msgType.primaryType),
  };
}

/**
 * Parse encodeType string to extract fields
 */
function parseEncodeType(encodeType) {
  const match = encodeType.match(/^[\w:]+\(([^)]*)\)/);
  if (!match) return [];

  const fieldsStr = match[1];
  if (!fieldsStr) return [];

  return fieldsStr.split(",").map((field) => {
    const parts = field.trim().split(/\s+/);
    return { name: parts[1] || parts[0], type: parts[0] };
  });
}

/**
 * Load a prompt template from the prompts/ directory.
 */
function loadPrompt(filename) {
  const promptPath = path.join(__dirname, "prompts", filename);
  try {
    return fs.readFileSync(promptPath, "utf-8");
  } catch (err) {
    console.error(`Failed to load prompt ${promptPath}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Build prompt for LLM to generate EIP-712 example
 */
function buildEip712Prompt(msgType, erc7730) {
  const systemPrompt = loadPrompt("eip712-test-example.md");

  const contextParts = [
    systemPrompt,
    "",
    "## Message Context",
    "",
    `- Primary type: ${msgType.primaryType}`,
  ];
  if (msgType.encodeType) contextParts.push(`- Encode type: ${msgType.encodeType}`);
  if (msgType.intent) contextParts.push(`- Intent: ${msgType.intent}`);
  if (erc7730.deployments[0]) {
    contextParts.push(`- Contract: ${erc7730.deployments[0].address}`);
    contextParts.push(`- Chain ID: ${erc7730.deployments[0].chainId}`);
  }

  return contextParts.join("\n");
}

// =============================================================================
// JSON Extraction
// =============================================================================

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // noop
    }
  }

  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start = -1;
  let end = -1;
  let openChar, closeChar;

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    start = firstBrace;
    openChar = "{";
    closeChar = "}";
  } else if (firstBracket >= 0) {
    start = firstBracket;
    openChar = "[";
    closeChar = "]";
  }

  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === openChar) depth++;
      else if (text[i] === closeChar) depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end));
      } catch {
        // noop
      }
    }
  }

  throw new Error("Could not extract valid JSON from LLM response");
}

// =============================================================================
// LLM Backends (shared abstraction matching generate-7730.js)
// =============================================================================

/**
 * Invoke the LLM via the configured backend.
 * Returns the raw text response from the model.
 */
async function invokeLLM(prompt) {
  verboseLog(`   Invoking LLM [${CONFIG.backend}] (${prompt.length} chars)...`);

  switch (CONFIG.backend) {
    case "openai":
      return await invokeLangGraphOpenAI(prompt);
    case "anthropic":
      return await invokeLangGraphAnthropic(prompt);
    case "cursor":
      return await invokeCursorAgent(prompt);
    default:
      throw new Error(`Unknown backend: ${CONFIG.backend}`);
  }
}

async function invokeLangGraphOpenAI(prompt) {
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { ChatOpenAI } = await import("@langchain/openai");

  if (!CONFIG.apiKey) {
    throw new Error("OpenAI backend requires an API key. Set OPENAI_API_KEY or pass --api-key.");
  }

  verboseLog(`   📡 OpenAI endpoint: ${CONFIG.apiUrl}, model: ${CONFIG.model}`);

  const model = new ChatOpenAI({
    model: CONFIG.model,
    temperature: 0.7,
    configuration: {
      baseURL: CONFIG.apiUrl,
      apiKey: CONFIG.apiKey,
    },
  });

  const agent = createReactAgent({ llm: model, tools: [] });
  return await streamAgent(agent, prompt);
}

async function invokeLangGraphAnthropic(prompt) {
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { ChatAnthropic } = await import("@langchain/anthropic");

  if (!CONFIG.apiKey) {
    throw new Error("Anthropic backend requires an API key. Set ANTHROPIC_API_KEY or pass --api-key.");
  }

  verboseLog(`   📡 Anthropic model: ${CONFIG.model}`);

  const modelOpts = {
    model: CONFIG.model,
    temperature: 0.7,
    anthropicApiKey: CONFIG.apiKey,
  };
  if (CONFIG.apiUrl && CONFIG.apiUrl !== BACKEND_DEFAULTS.anthropic.url) {
    modelOpts.anthropicApiUrl = CONFIG.apiUrl;
  }

  const model = new ChatAnthropic(modelOpts);
  const agent = createReactAgent({ llm: model, tools: [] });
  return await streamAgent(agent, prompt);
}

async function streamAgent(agent, prompt) {
  const messages = [{ role: "user", content: prompt }];

  let fullContent = "";
  const stream = await agent.stream({ messages }, { streamMode: "messages" });

  for await (const [msgChunk] of stream) {
    const token = msgChunk?.content;
    if (typeof token === "string" && token.length > 0) {
      fullContent += token;
    }
  }

  return fullContent;
}

async function invokeCursorAgent(prompt) {
  const tmpDir = path.join(os.tmpdir(), "erc7730-generate");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `prompt-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, prompt, "utf-8");

  verboseLog(`   Wrote prompt to ${tmpFile} (${prompt.length} chars)`);

  const args = [
    "agent",
    "--mode", "ask",
    "--print",
    "--output-format", "text",
    "--trust",
  ];
  if (CONFIG.model) {
    args.push("--model", CONFIG.model);
  }
  args.push(
    `Read the file at ${tmpFile} and follow all instructions in it. ` +
    `Output ONLY the requested JSON, no extra text.`
  );

  verboseLog(`   Running: cursor ${args.join(" ")}`);

  const timeoutMs = CONFIG.cursorTimeout;
  return new Promise((resolve, reject) => {
    const proc = spawn("cursor", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } }, 5000);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
      reject(new Error(`Failed to start cursor agent: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
      if (killed) {
        reject(new Error(
          `Cursor agent timed out after ${timeoutMs / 1000}s` +
          (stdout ? ` (received ${stdout.length} chars)` : " (no output)")
        ));
      } else if (code !== 0) {
        reject(new Error(
          `Cursor agent exited with code ${code}` +
          (stderr ? ": " + stderr.slice(0, 500) : "")
        ));
      } else if (!stdout.trim()) {
        reject(new Error("Cursor agent returned empty output"));
      } else {
        resolve(stdout);
      }
    });
  });
}

// =============================================================================
// Expected Text Inference
// =============================================================================

/**
 * Infer expected display texts from function fields.
 * Only includes labels from fields with visible:"always" — other fields may
 * be hidden or conditionally shown depending on the device/firmware, so they
 * are not reliable for initial expectedTexts (refinement fills them in later).
 */
function inferExpectedTexts(func, metadata) {
  const texts = [];

  // Add intent if available
  if (func.intent) {
    // texts.push(func.intent); // Usually shown as title, not in field list
  }

  // v1: "required" array lists paths of always-visible fields
  const requiredPaths = new Set(func.required || []);

  for (const field of func.fields || []) {
    if (!field.label) continue;
    // v2: explicit visible property
    if (field.visible === "always") {
      texts.push(field.label);
    }
    // v1: field path is in the required array
    else if (requiredPaths.size > 0 && field.path && requiredPaths.has(field.path)) {
      texts.push(field.label);
    }
  }

  return texts;
}

/**
 * Infer expected texts for EIP-712 messages.
 * Supports v2 (visible:"always") and v1 (required array).
 */
function inferExpectedTextsEip712(msgType, metadata) {
  const texts = [];

  // v1: "required" array lists paths of always-visible fields
  const requiredPaths = new Set(msgType.required || []);

  for (const field of msgType.fields || []) {
    if (!field.label) continue;
    // v2: explicit visible property
    if (field.visible === "always") {
      texts.push(field.label);
    }
    // v1: field path is in the required array
    else if (requiredPaths.size > 0 && field.path && requiredPaths.has(field.path)) {
      texts.push(field.label);
    }
  }

  return texts;
}

/**
 * Extract function name from signature
 */
function extractFunctionName(signature) {
  const match = signature.match(/^(\w+)\(/);
  return match ? match[1] : signature;
}

// =============================================================================
// Existing Test Coverage Detection
// =============================================================================

/**
 * Compute the output test file path for a given descriptor.
 * @param {string} descriptorPath - Absolute path to the ERC-7730 descriptor
 * @returns {string} Absolute path to the corresponding .tests.json file
 */
function getTestFilePath(descriptorPath) {
  const dir = path.dirname(descriptorPath);
  const testsDir = path.join(dir, "tests");
  const baseName = path.basename(descriptorPath, ".json");
  return path.join(testsDir, `${baseName}.tests.json`);
}

/**
 * Load an existing test file and determine which functions / message types
 * are already covered by existing tests.
 *
 * Coverage detection:
 *   - EIP-712: uses `test.data.primaryType` to identify the message type.
 *   - Calldata: searches the raw tx hex for known function selectors.
 *
 * @param {string} testFilePath - Path to the .tests.json file
 * @param {object} erc7730 - Parsed ERC-7730 descriptor (from parseErc7730)
 * @returns {{ existingTests: object[], coveredFunctions: Set<string>, coveredMessageTypes: Set<string> }}
 */
function getExistingTestCoverage(testFilePath, erc7730) {
  const empty = { existingTests: [], coveredFunctions: new Set(), coveredMessageTypes: new Set() };

  if (!fs.existsSync(testFilePath)) return empty;

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(testFilePath, "utf8"));
  } catch {
    return empty;
  }

  const existingTests = existing.tests || [];
  const coveredFunctions = new Set();
  const coveredMessageTypes = new Set();

  for (const test of existingTests) {
    // EIP-712: identify by primaryType in test data
    if (test.data?.primaryType) {
      coveredMessageTypes.add(test.data.primaryType);
    }

    // Calldata: search rawTx hex for known function selectors
    if (test.rawTx) {
      const rawHex = test.rawTx.toLowerCase();
      for (const func of erc7730.functions || []) {
        if (func.selector) {
          const selectorHex = func.selector.toLowerCase().replace("0x", "");
          if (rawHex.includes(selectorHex)) {
            coveredFunctions.add(func.signature);
          }
        }
      }
    }
  }

  return { existingTests, coveredFunctions, coveredMessageTypes };
}

// =============================================================================
// Output
// =============================================================================

/**
 * Write test file, merging with existing tests.
 * Existing tests are preserved at the beginning, new tests are appended.
 */
function writeTestFile(erc7730, tests, report, existingTests = []) {
  const allTests = [...existingTests, ...tests];

  if (allTests.length === 0) {
    log("\n⚠️  No tests generated");
    return null;
  }

  if (tests.length === 0 && existingTests.length > 0) {
    log("\nℹ️  All functions/messages already covered by existing tests — nothing new to add");
    // Return the existing path so tester can still run on existing tests
    return getTestFilePath(erc7730.filePath);
  }

  const testFilePath = getTestFilePath(erc7730.filePath);
  const testsDir = path.dirname(testFilePath);

  // Build test file content
  const testFile = {
    $schema: "../../../specs/erc7730-tests.schema.json",
    tests: allTests,
  };

  if (CONFIG.dryRun) {
    log(`\n📄 Would write: ${testFilePath}`);
    if (existingTests.length > 0) {
      log(`   Preserving ${existingTests.length} existing test(s), adding ${tests.length} new test(s)`);
    }
    log(JSON.stringify(testFile, null, 2).slice(0, 500) + "...");
  } else {
    // Create tests directory if needed
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, JSON.stringify(testFile, null, 2) + "\n");
    if (existingTests.length > 0) {
      log(`\n✅ Written: ${testFilePath} (${existingTests.length} existing + ${tests.length} new)`);
    } else {
      log(`\n✅ Written: ${testFilePath}`);
    }
  }

  return testFilePath;
}

/**
 * Print summary report
 */
function printReport(report) {
  console.log("\n" + "=".repeat(60));
  console.log("📊 GENERATION REPORT");
  console.log("=".repeat(60));

  console.log(`\n✅ Generated: ${report.generated.length} test cases`);
  for (const item of report.generated) {
    if (item.type === "calldata") {
      console.log(`   • ${item.function} (chain ${item.chainId})`);
    } else {
      console.log(`   • ${item.messageType} (EIP-712)`);
    }
  }

  if (report.notFound.length > 0) {
    console.log(`\n⚠️  Not found: ${report.notFound.length} items`);
    for (const item of report.notFound) {
      if (item.type === "calldata") {
        console.log(`   • ${item.function} (chain ${item.chainId}): ${item.reason}`);
      } else {
        console.log(`   • ${item.messageType}: ${item.reason}`);
      }
    }
  }

  if (report.warnings.length > 0) {
    console.log(`\n⚡ Warnings: ${report.warnings.length}`);
    for (const warning of report.warnings) {
      console.log(`   • ${warning}`);
    }
  }

  if (report.errors.length > 0) {
    console.log(`\n❌ Errors: ${report.errors.length}`);
    for (const error of report.errors) {
      console.log(`   • ${error}`);
    }
  }

  console.log("\n" + "=".repeat(60));
}

// =============================================================================
// Logging
// =============================================================================

function log(message) {
  if (CONFIG.verbose || !message.startsWith("   ")) {
    console.log(message);
  } else if (CONFIG.logVerbose) {
    appendLogLine("DEBUG", message);
  }
}

function verboseLog(message, level = "DEBUG") {
  if (CONFIG.verbose) {
    log(message);
  } else if (CONFIG.logVerbose) {
    appendLogLine(level, message);
  }
}

function verboseError(message, level = "ERROR") {
  if (CONFIG.verbose) {
    console.error(message);
  } else if (CONFIG.logVerbose) {
    appendLogLine(level, message);
  }
}

// =============================================================================
// Local ERC7730 API Server Management
// =============================================================================

/** @type {import("child_process").ChildProcess | null} */
let _localApiProcess = null;

/**
 * Start the local Flask API server in the background.
 * Resolves once the server is accepting HTTP requests on the given port.
 *
 * @param {number} port  Port to run on
 * @returns {Promise<import("child_process").ChildProcess>}
 */
function startLocalApiServer(port) {
  return new Promise((resolve, reject) => {
    const repoRoot = path.resolve(__dirname, "../..");
    const runScript = path.join(repoRoot, "tools", "tester", "run-local-api.sh");

    if (!fs.existsSync(runScript)) {
      reject(new Error(
        `Local API script not found: ${runScript}\n` +
        "  Set up with: cd tools/tester && ./setup.sh"
      ));
      return;
    }

    console.log(`\n🚀 Starting local ERC7730 API server on port ${port}...`);

    // detached: true creates a new process group so we can kill bash + Flask together
    const child = spawn("bash", [runScript, String(port)], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: true,
    });

    _localApiProcess = child;

    // Accumulate stderr/stdout for diagnostics
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (CONFIG.verbose) process.stderr.write(chunk);
    });
    child.stdout.on("data", (chunk) => {
      if (CONFIG.verbose) process.stdout.write(chunk);
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start local API: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(
          `Local API server exited with code ${code}\n${stderr.slice(-500)}`
        ));
      }
    });

    // Poll until the server is accepting connections
    const startTime = Date.now();
    const timeout = 30000; // 30 s
    const poll = setInterval(() => {
      if (Date.now() - startTime > timeout) {
        clearInterval(poll);
        stopLocalApiServer();
        reject(new Error(
          `Local API server did not start within ${timeout / 1000}s\n${stderr.slice(-500)}`
        ));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        // Any HTTP response (even 404) means Flask is up
        clearInterval(poll);
        console.log(`✅ Local API server ready on http://127.0.0.1:${port}`);
        resolve(child);
      });
      req.on("error", () => { /* not ready yet, keep polling */ });
      req.end();
    }, 500);
  });
}

/**
 * Stop the local API server if it was started by us.
 * Kills the entire process group (bash + Flask) so nothing lingers.
 */
function stopLocalApiServer() {
  if (_localApiProcess && !_localApiProcess.killed) {
    console.log("\n🛑 Stopping local API server...");
    try {
      // Kill the entire process group (negative PID) so Flask dies too
      process.kill(-_localApiProcess.pid, "SIGTERM");
    } catch (e) {
      // Process group may already be gone
      try { _localApiProcess.kill("SIGTERM"); } catch {}
    }
    _localApiProcess = null;
  }
}

// Ensure the child process is cleaned up on unexpected exit
process.on("exit", stopLocalApiServer);
process.on("SIGINT", () => { stopLocalApiServer(); process.exit(130); });
process.on("SIGTERM", () => { stopLocalApiServer(); process.exit(143); });

// =============================================================================
// Clear Signing Tester Integration
// =============================================================================

function streamToLines(stream, onLine, onChunk) {
  let buffer = "";
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    if (onChunk) onChunk(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
  });
}

/**
 * Run the clear signing tester on the generated test file.
 * Invokes tools/tester/run-test.sh with the descriptor and test file.
 *
 * @param {string} descriptorPath - Absolute path to the ERC-7730 descriptor
 * @param {string} testFilePath   - Absolute path to the generated .tests.json
 * @returns {Promise<{ passed: boolean, logFile: string|null }>} test result and log file path
 */
async function runTester(descriptorPath, testFilePath) {
  // Resolve the run-test.sh script relative to the repository root
  const repoRoot = path.resolve(__dirname, "../..");
  const runTestScript = path.join(repoRoot, "tools", "tester", "run-test.sh");

  if (!fs.existsSync(runTestScript)) {
    console.log("\n⚠️  Tester script not found at: " + runTestScript);
    console.log("   Skipping test execution. Run setup first: cd tools/tester && ./setup.sh");
    emitTestEvent("tester_start", { descriptor: descriptorPath, testFile: testFilePath });
    emitTestEvent("tester_complete", {
      descriptor: descriptorPath,
      testFile: testFilePath,
      passed: false,
      exitCode: 1,
      screenshots: 0,
      verified: 0,
    });
    return { passed: false, logFile: null };
  }

  const device = CONFIG.testDevice;
  const logLevel = CONFIG.testLogLevel;

  console.log("\n" + "=".repeat(60));
  console.log("🧪 RUNNING CLEAR SIGNING TESTER");
  console.log("=".repeat(60));
  console.log(`\n   Descriptor: ${descriptorPath}`);
  console.log(`   Test file:  ${testFilePath}`);
  console.log(`   Device:     ${device}`);
  console.log(`   Log level:  ${logLevel}\n`);

  emitTestEvent("tester_start", { descriptor: descriptorPath, testFile: testFilePath });
  let passed = false;
  let exitCode = 1;
  let screenshotCount = 0;
  let verifiedCount = 0;

  await new Promise((resolve, reject) => {
    const child = spawn("bash", [runTestScript, descriptorPath, testFilePath, device, logLevel], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (line) => {
      const clean = stripAnsi(line);
      if (/Saved screenshot:/.test(clean)) {
        screenshotCount++;
        emitTestEvent("tester_screenshot", { count: screenshotCount });
      }
      const resultMatch = clean.match(/Result:\s*(.+)$/);
      if (resultMatch) {
        verifiedCount++;
        const resultText = resultMatch[1].trim();
        emitTestEvent("tester_case_result", {
          index: verifiedCount - 1,
          status: classifyTesterResultText(resultText),
          resultText,
        });
      }
    };

    streamToLines(child.stdout, onLine, (text) => process.stdout.write(text));
    streamToLines(child.stderr, onLine, (text) => process.stderr.write(text));

    child.on("error", reject);
    child.on("close", (code) => {
      exitCode = code ?? 1;
      passed = exitCode === 0;
      resolve();
    });
  });

  if (passed) {
    console.log("\n✅ Clear signing tests passed!");
  } else {
    console.log(`\n❌ Clear signing tests failed (exit code: ${exitCode})`);
  }

  // Find the most recent test output log
  const logsDir = path.join(repoRoot, "tools", "tester", "output", "logs");
  const logFile = findMostRecentFile(logsDir, "test-output-");
  emitTestEvent("tester_complete", {
    descriptor: descriptorPath,
    testFile: testFilePath,
    passed,
    exitCode,
    screenshots: screenshotCount,
    verified: verifiedCount,
    logFile,
  });
  return { passed, logFile };
}

/**
 * Find the most recent file in a directory matching a prefix.
 */
function findMostRecentFile(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

// =============================================================================
// Test Refinement — extract expectedTexts from tester screen output
// =============================================================================

/**
 * Generic UI patterns to filter out from screen texts.
 * These are standard Ledger device chrome, not descriptor-specific content.
 */
const GENERIC_UI_PATTERNS = [
  /^Review transaction/i,
  /^Sign transaction/i,
  /^Transaction signed/i,
  /Swipe to review/i,
  /Hold to sign/i,
  /Reject \d+ of \d+/i,
  /^Ethereum\b.*Quit app/i,
];

/**
 * Parse tester log output to extract per-test screen text blocks.
 *
 * Each "SCREEN TEXT ANALYSIS" section in the log corresponds to one test case
 * (in order). Returns an array of arrays, one per test, each containing the
 * raw screen text strings.
 *
 * Supports two log formats:
 *   Legacy:  `Accumulated screen texts from device:\n [0] "text"\n ... Expected texts from test file:`
 *   Current: `screen-analyzer Accumulated screen texts from device: {\n  data: {\n    accumulatedTexts: [\n      'text',\n ...\n`
 *
 * @param {string} logContent - Full tester log file content
 * @returns {string[][]} Per-test arrays of screen text strings
 */
/**
 * Parse per-test result statuses from the tester log.
 *
 * Looks for the TYPED DATA / CALLDATA TEST RESULTS table output by the tester,
 * which maps each test index to a description and status (clear/blind/partial/error).
 *
 * @param {string} logContent - Full tester log content
 * @returns {Array<{index: number, description: string, status: string}>}
 */
function parseTesterStatuses(logContent) {
  const statuses = [];
  const rowRegex = /│\s+(\d+)\s+│\s+'([^']+)'\s+│\s+'([^']+)'\s+│/g;
  let match;
  while ((match = rowRegex.exec(logContent)) !== null) {
    const rawStatus = match[3];
    let status;
    if (rawStatus.includes("clear signed")) status = "clear";
    else if (rawStatus.includes("blind signed")) status = "blind";
    else if (/partially/i.test(rawStatus)) status = "partial";
    else status = "error";
    statuses.push({ index: parseInt(match[1], 10), description: match[2], status });
  }
  return statuses;
}

function parseTesterScreenTexts(logContent) {
  const allTests = [];

  // Strategy 1: legacy format (bounded by "Expected texts from test file:")
  const legacyRegex = /Accumulated screen texts from device:\n([\s\S]*?)Expected texts from test file:/g;
  let match;
  while ((match = legacyRegex.exec(logContent)) !== null) {
    const block = match[1];
    const texts = [];
    const lineRegex = /\[\d+\]\s+"(.*?)"/g;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      texts.push(lineMatch[1]);
    }
    allTests.push(texts);
  }

  if (allTests.length > 0) return allTests;

  // Strategy 2: current format — JS object dump with accumulatedTexts array
  const currentRegex = /Accumulated screen texts from device:\s*\{[\s\S]*?accumulatedTexts:\s*\[([\s\S]*?)\]\s*\n?\s*\}/g;
  while ((match = currentRegex.exec(logContent)) !== null) {
    const arrayBlock = match[1];
    const texts = [];
    const entryRegex = /'((?:[^'\\]|\\.)*)'/g;
    let entryMatch;
    while ((entryMatch = entryRegex.exec(arrayBlock)) !== null) {
      texts.push(entryMatch[1]);
    }
    allTests.push(texts);
  }

  return allTests;
}

/**
 * Extract refined expectedTexts from screen texts for one test case.
 *
 * Filters out generic UI, identifies the data screen(s) containing
 * "Interaction with", and extracts label + shortened value pairs.
 *
 * @param {string[]} screenTexts - Raw screen texts for one test
 * @param {string[]} descriptorLabels - Field labels from the ERC-7730 descriptor
 * @returns {string[]} Refined expected text strings
 */
function extractExpectedTexts(screenTexts, descriptorLabels) {
  const expectedTexts = [];

  // All known labels that can delimit values on screen
  const allLabels = [...new Set([...descriptorLabels, "Interaction with", "Max fees"])];

  for (const text of screenTexts) {
    // Find all label positions in this screen text
    const labelPositions = [];
    for (const label of allLabels) {
      const idx = text.indexOf(label);
      if (idx !== -1) {
        labelPositions.push({ label, start: idx });
      }
    }

    // Skip screens with no known labels (generic UI screens)
    if (labelPositions.length === 0) continue;

    // Sort labels by their position in the text
    labelPositions.sort((a, b) => a.start - b.start);

    // Find the "Reject X of Y" position as the final boundary
    const rejectMatch = text.match(/Reject\s+\d+\s+of\s+\d+/);
    const endBoundary = rejectMatch ? rejectMatch.index : text.length;

    // Extract label and value as separate items
    for (let i = 0; i < labelPositions.length; i++) {
      const { label, start } = labelPositions[i];
      const nextStart = i + 1 < labelPositions.length
        ? labelPositions[i + 1].start
        : endBoundary;

      // Push the label itself
      expectedTexts.push(label);

      // Push the value (text after the label, up to the next label or end boundary)
      const value = text.slice(start + label.length, nextStart).trim();
      if (value) {
        expectedTexts.push(value);
      }
    }
  }

  return expectedTexts;
}

/**
 * Check if a screen text is generic Ledger UI chrome.
 */
function isGenericUI(text) {
  return GENERIC_UI_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extract a label + shortened value from a data screen text.
 *
 * Finds the label in the text, then captures the value that follows.
 * Returns "Label shortvalue" or null if not found.
 *
 * For numeric/token values: first ~8 significant characters
 * For address values (0x...): first ~10 hex characters
 *
 * @param {string} text - Full data screen text
 * @param {string} label - Field label to search for
 * @returns {string|null}
 */
function extractShortLabelValue(text, label) {
  const idx = text.indexOf(label);
  if (idx === -1) return null;

  // Get the text after the label
  const afterLabel = text.slice(idx + label.length).trimStart();

  // Known delimiters that mark the end of a value: next label, "Max fees", "Reject"
  // We grab a reasonable chunk and truncate
  const valuePortion = afterLabel.split(/\s+(?:Max fees|Reject\s+\d)/).shift() || "";

  if (!valuePortion.trim()) return label;

  // Remove device line-break artifacts: join tokens back, then shorten
  const tokens = valuePortion.trim().split(/\s+/);

  // Detect address value (starts with 0x)
  if (tokens[0] && tokens[0].startsWith("0x")) {
    // Rejoin hex fragments that were split by line breaks
    const fullHex = tokens.join("");
    // Keep "0x" + first 8 hex chars
    const shortAddr = fullHex.slice(0, 10);
    return `${label} ${shortAddr}`;
  }

  // Detect numeric value (starts with digit or decimal point)
  if (tokens[0] && /^[\d.]/.test(tokens[0])) {
    // Rejoin numeric fragments (line breaks can split "65500.978878409520 354251")
    // Take just the first token which has the significant start
    const numStr = tokens[0];
    // Find decimal point position for truncation
    const dotIdx = numStr.indexOf(".");
    if (dotIdx !== -1) {
      // Keep up to 2 decimal places
      const short = numStr.slice(0, dotIdx + 3);
      return `${label} ${short}`;
    }
    // Integer: take first 8 chars
    return `${label} ${numStr.slice(0, 8)}`;
  }

  // Fallback: just label + first token (shortened)
  return `${label} ${tokens[0].slice(0, 10)}`;
}

/**
 * Refine the expectedTexts in a test file using actual tester screen output.
 *
 * @param {string} testFilePath - Path to the .tests.json file
 * @param {string} logFile      - Path to the tester output log
 * @param {object} erc7730      - Parsed ERC-7730 descriptor
 * @returns {boolean} true if refinement was applied
 */
function refineTestFile(testFilePath, logFile, erc7730) {
  const logContent = fs.readFileSync(logFile, "utf8");
  const perTestScreens = parseTesterScreenTexts(logContent);

  if (perTestScreens.length === 0) {
    console.log("   ⚠️  No screen text analysis found in tester log");
    emitTestEvent("refinement_complete", {
      testFile: testFilePath,
      refined: 0,
      failed: 0,
      total: 0,
      reason: "no_screen_analysis",
    });
    return { applied: false, refined: 0, failed: 0, total: 0 };
  }

  const testFile = JSON.parse(fs.readFileSync(testFilePath, "utf8"));
  const tests = testFile.tests;
  emitTestEvent("refinement_start", {
    testFile: testFilePath,
    totalTests: Array.isArray(tests) ? tests.length : 0,
  });

  // When screen count doesn't match test count, try partial refinement by
  // identifying which tests were clear-signed vs blind-signed from the tester
  // result table, and only refining the clear-signed subset.
  let clearSignedIndices = null;
  if (perTestScreens.length !== tests.length) {
    const statuses = parseTesterStatuses(logContent);
    const clearIndices = statuses
      .filter((s) => s.status === "clear" || s.status === "partial")
      .map((s) => s.index);

    if (clearIndices.length > 0 && clearIndices.length === perTestScreens.length) {
      const blindCount = tests.length - clearIndices.length;
      console.log(
        `   ℹ️  ${blindCount} blind-signed test(s) detected — refining ${clearIndices.length}/${tests.length} clear-signed test(s)`
      );
      clearSignedIndices = new Set(clearIndices);
    } else {
      console.log(
        `   ⚠️  Screen text count (${perTestScreens.length}) doesn't match test count (${tests.length}) and could not resolve from tester statuses, skipping refinement`
      );
      emitTestEvent("refinement_complete", {
        testFile: testFilePath,
        refined: 0,
        failed: tests.length,
        total: tests.length,
        reason: "screen_count_mismatch",
      });
      return { applied: false, refined: 0, failed: tests.length, total: tests.length };
    }
  }

  const labelsByIntent = buildLabelsByIntent(erc7730);

  let refined = 0;
  let failed = 0;
  let skipped = 0;
  let needsWrite = false;
  let screenIdx = 0;
  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];

    if (clearSignedIndices && !clearSignedIndices.has(i)) {
      skipped++;
      emitTestEvent("refinement_case", {
        index: i,
        description: test.description || "",
        status: "skipped",
      });
      continue;
    }

    const screenTexts = perTestScreens[screenIdx++];
    const labels = findLabelsForTest(test, labelsByIntent, erc7730);
    const newExpectedTexts = extractExpectedTexts(screenTexts, labels);

    if (newExpectedTexts.length > 0) {
      test.expectedTexts = newExpectedTexts;
      refined++;
      emitTestEvent("refinement_case", {
        index: i,
        description: test.description || "",
        status: "refined",
      });
    } else if (!test.expectedTexts) {
      test.expectedTexts = [];
      needsWrite = true;
      failed++;
      emitTestEvent("refinement_case", {
        index: i,
        description: test.description || "",
        status: "failed",
      });
    } else {
      failed++;
      emitTestEvent("refinement_case", {
        index: i,
        description: test.description || "",
        status: "failed",
      });
    }
  }

  if (refined > 0 || needsWrite) {
    fs.writeFileSync(testFilePath, JSON.stringify(testFile, null, 2) + "\n");
    const skippedSuffix = skipped > 0 ? ` (${skipped} blind-signed skipped)` : "";
    console.log(`   ✅ Refined expectedTexts for ${refined}/${tests.length} test cases${skippedSuffix}`);
  }

  emitTestEvent("refinement_complete", {
    testFile: testFilePath,
    refined,
    failed,
    skipped,
    total: tests.length,
  });
  return { applied: refined > 0 || needsWrite, refined, failed, skipped, total: tests.length };
}

/**
 * Build a mapping from intent/function name to field labels from the descriptor.
 */
function buildLabelsByIntent(erc7730) {
  const map = {};

  // Calldata functions
  for (const func of erc7730.functions || []) {
    const intent = func.intent || extractFunctionName(func.signature);
    const labels = (func.fields || [])
      .map((f) => f.label)
      .filter(Boolean);
    map[intent] = labels;
    // Also index by function name
    const funcName = extractFunctionName(func.signature);
    if (funcName !== intent) {
      map[funcName] = labels;
    }
  }

  // EIP-712 message types
  for (const msgType of erc7730.messageTypes || []) {
    const intent = msgType.intent || msgType.primaryType;
    const labels = (msgType.fields || [])
      .map((f) => f.label)
      .filter(Boolean);
    map[intent] = labels;
  }

  return map;
}

/**
 * Find the descriptor labels that apply to a given test case.
 * Matches test description against known intents/function names.
 */
function findLabelsForTest(test, labelsByIntent, erc7730) {
  const desc = test.description || "";

  // Try to match the test description against known intents
  for (const [intent, labels] of Object.entries(labelsByIntent)) {
    if (desc.includes(intent)) {
      return labels;
    }
  }

  // Fallback: return all labels from the descriptor
  const allLabels = [];
  for (const func of erc7730.functions || []) {
    for (const f of func.fields || []) {
      if (f.label) allLabels.push(f.label);
    }
  }
  for (const msgType of erc7730.messageTypes || []) {
    for (const f of msgType.fields || []) {
      if (f.label) allLabels.push(f.label);
    }
  }
  return [...new Set(allLabels)];
}

// =============================================================================
// Formatting — invoke `erc7730 format` to normalize generated test files
// =============================================================================

/**
 * Format a test file using the `erc7730 format` CLI command.
 * Tries the linter venv first, then falls back to a globally installed `erc7730`.
 *
 * @param {string} filePath - Absolute path to the file to format
 */
function formatTestFile(filePath) {
  const repoRoot = path.resolve(__dirname, "../..");
  const venvBin = path.join(repoRoot, "tools", "linter", "python-erc7730", ".venv", "bin", "erc7730");

  const erc7730Bin = fs.existsSync(venvBin) ? venvBin : "erc7730";

  console.log(`\n📐 Formatting test file with erc7730 format...`);
  verboseLog(`   Using: ${erc7730Bin} format ${filePath}`);

  try {
    execSync(`"${erc7730Bin}" format "${filePath}"`, {
      cwd: repoRoot,
      stdio: CONFIG.verbose ? "inherit" : "pipe",
      timeout: 30000,
    });
    console.log(`   ✅ Formatted: ${filePath}`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    console.log(`   ⚠️  Formatting failed (non-fatal): ${stderr}`);
    verboseError(err.stack || err.message);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("ERC-7730 Test Generator");
  console.log("=======================");
  if (CONFIG.dryRun) {
    console.log("🔍 DRY RUN MODE - No files will be written\n");
  }

  // Get input file
  const inputFile = getInputFileArg();

  if (!inputFile) {
    printHelp(1, "Error: An ERC-7730 descriptor file argument is required.");
  }

  const filePath = path.resolve(inputFile);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Only generate tests for leaf descriptors (calldata-* / eip712-* files).
  // Non-leaf files (e.g. common-*) are shared includes that cannot be tested standalone.
  const baseName = path.basename(filePath);
  if (!baseName.startsWith("calldata") && !baseName.startsWith("eip712")) {
    console.log(`⚠️  Skipping non-leaf file: ${baseName}`);
    console.log("   Tests can only be generated for leaf descriptors (calldata-* / eip712-* files).");
    return;
  }

  console.log(`Input: ${filePath}\n`);

  // Start local API server if requested
  if (CONFIG.localApi) {
    try {
      await startLocalApiServer(CONFIG.localApiPort);
      // Set env var so the tester subprocess (run-test.sh) uses the local server
      process.env.ERC7730_API_URL = `http://127.0.0.1:${CONFIG.localApiPort}`;
      console.log(`   ERC7730_API_URL set to ${process.env.ERC7730_API_URL}\n`);
    } catch (err) {
      console.error(`\n❌ Could not start local API server: ${err.message}`);
      process.exit(1);
    }
  }

  // Initialize report
  const report = {
    generated: [],
    notFound: [],
    warnings: [],
    errors: [],
  };

  try {
    // Parse ERC-7730 file
    const erc7730 = parseErc7730(filePath);
    console.log(`Type: ${erc7730.isCalldata ? "Calldata" : "EIP-712"}`);
    console.log(`Deployments: ${erc7730.deployments.length}`);
    console.log(
      `Functions/Types: ${erc7730.functions.length || erc7730.messageTypes.length}`
    );

    // Check for existing tests and determine coverage
    const testFileTarget = getTestFilePath(filePath);
    const { existingTests, coveredFunctions, coveredMessageTypes } =
      getExistingTestCoverage(testFileTarget, erc7730);

    if (existingTests.length > 0) {
      console.log(`Existing tests: ${existingTests.length}`);
      if (coveredFunctions.size > 0) {
        console.log(`Covered functions: ${[...coveredFunctions].join(", ")}`);
      }
      if (coveredMessageTypes.size > 0) {
        console.log(`Covered message types: ${[...coveredMessageTypes].join(", ")}`);
      }
    }

    const totalCoverageTargets = erc7730.isCalldata
      ? erc7730.functions.length
      : erc7730.messageTypes.length;
    const coveredTargets = erc7730.isCalldata
      ? coveredFunctions.size
      : coveredMessageTypes.size;
    const hasFullCoverage = totalCoverageTargets > 0 && coveredTargets >= totalCoverageTargets;

    if (CONFIG.forceTest && existingTests.length > 0 && hasFullCoverage) {
      console.log(
        "ℹ️  --force-test enabled: running tester against existing test file despite full coverage"
      );
    }

    let tests = [];

    // Generate tests only for uncovered functions/message types
    if (erc7730.isCalldata) {
      tests = await generateCalldataTests(erc7730, report, coveredFunctions);
    } else if (erc7730.isEip712) {
      tests = await generateEip712Tests(erc7730, report, coveredMessageTypes);
    }

    // Write output (merge existing + new)
    const testFilePath = writeTestFile(erc7730, tests, report, existingTests);

    // Print report
    printReport(report);

    // Run clear signing tester if enabled and tests were written
    if ((CONFIG.runTest || CONFIG.forceTest) && !CONFIG.dryRun && testFilePath) {
      // For descriptors using `includes`, the tester needs a resolved (self-contained)
      // descriptor because the API rejects files without a `display` section.
      const resolvedTmpFile = createResolvedDescriptorTempFile(filePath);
      const testerDescriptor = resolvedTmpFile || filePath;

      try {
        const { passed, logFile } = await runTester(testerDescriptor, testFilePath);
        if (!passed) {
          process.exitCode = 1;
        }

        // Refine expectedTexts from tester screen output
        if (CONFIG.refine && logFile) {
          console.log("\n" + "=".repeat(60));
          console.log("🔍 REFINING expectedTexts FROM TESTER OUTPUT");
          console.log("=".repeat(60));
          console.log(`\n   Log file: ${logFile}`);
          try {
            refineTestFile(testFilePath, logFile, erc7730);
          } catch (err) {
            console.log(`   ⚠️  Refinement failed: ${err.message}`);
            verboseError(err.stack);
          }
        } else if (!CONFIG.refine) {
          console.log("\nℹ️  Refinement skipped (--no-refine)");
        }
      } finally {
        if (resolvedTmpFile && fs.existsSync(resolvedTmpFile)) {
          fs.unlinkSync(resolvedTmpFile);
          verboseLog(`  ℹ️  Cleaned up temp resolved descriptor: ${path.basename(resolvedTmpFile)}`, "INFO");
        }
      }
    } else if (!CONFIG.runTest) {
      console.log("\nℹ️  Tester skipped (--no-test)");
    }

    // Format the generated/refined test file
    if (!CONFIG.dryRun && testFilePath) {
      formatTestFile(testFilePath);
    }
  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    verboseError(error.stack);
    process.exit(1);
  } finally {
    // Clean up local API server if we started one
    stopLocalApiServer();
  }
}

main();
