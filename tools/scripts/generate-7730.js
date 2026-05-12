#!/usr/bin/env node
/**
 * ERC-7730 Descriptor Generator
 *
 * Generates ERC-7730 v2 clear signing descriptor files using an LLM.
 * Produces calldata descriptors (and optionally EIP-712 descriptors) from a contract
 * ABI and/or source code.
 *
 * Supports multiple LLM backends: openai, anthropic, and cursor (agent CLI).
 *
 * Usage:
 *   node tools/scripts/generate-7730.js --address <addr> --output <dir> [options]
 *   node tools/scripts/generate-7730.js --abi <path> --output <dir> [options]
 *   node tools/scripts/generate-7730.js --source <dir> --output <dir> [options]
 *
 * Input modes (at least one required):
 *   --address <addr>        On-chain contract address (downloads ABI + source automatically)
 *   --abi <path>            Path to ABI JSON file (local)
 *   --source <path>         Path to folder with Solidity source files (local)
 *
 * When only --address is given, the script tries to download:
 *   1. ABI + source from Sourcify
 *   2. ABI + source from Etherscan (requires ETHERSCAN_API_KEY)
 *
 * --address can be combined with --abi or --source to supply local data
 * and still use the address for deployment context.
 *
 * Options:
 *   --output <path>         Destination folder for generated files (created if missing)
 *   --chain <id>            Chain ID (default: 1)
 *   --name <name>           Protocol / owner name
 *   --contract-name <name>  Contract name (defaults to ABI filename or source folder name)
 *   --url <url>             Protocol website URL
 *   --include-admin         Also generate admin/governance functions
 *   --dry-run               Preview without writing files
 *   --verbose               Show detailed output
 *   --log <path>            Enable verbose logging to file
 *   -l                      Enable verbose logging to tools/scripts/logs/
 *   --backend <name>        LLM backend: openai, anthropic, cursor (default: openai)
 *   --model <model>         Model name (default depends on backend)
 *   --api-key <key>         API key (overrides env var for the selected backend)
 *   --api-url <url>         Custom API base URL (openai/anthropic only)
 *   --rpc-url <url>         JSON-RPC endpoint for proxy detection (overrides RPC_URL env)
 *   --schema-path <path>    Relative schema path in output (default: ../../specs/erc7730-v2.schema.json)
 *   --help, -h              Show this help message
 *
 * Environment Variables:
 *   OPENAI_API_KEY       API key for OpenAI backend
 *   ANTHROPIC_API_KEY    API key for Anthropic backend
 *   ETHERSCAN_API_KEY    For downloading source code from Etherscan
 *   RPC_URL              JSON-RPC endpoint for proxy detection
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

// =============================================================================
// Configuration
// =============================================================================

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, "..", "..");
const LOGS_DIR = path.join(__dirname, "logs");
const DEFAULT_LOG_FILE = path.join(LOGS_DIR, `generate-7730-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.verbose.log`);
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
  abiPath: getArgValue("--abi", null),
  sourcePath: getArgValue("--source", null),
  outputPath: getArgValue("--output", null),
  chainId: getArgValue("--chain", 1),
  address: getArgValue("--address", null),
  protocolName: getArgValue("--name", null),
  contractName: getArgValue("--contract-name", null),
  protocolUrl: getArgValue("--url", null),
  includeAdmin: process.argv.includes("--include-admin"),
  backend: getArgValue("--backend", "openai"),
  model: getArgValue("--model", null),
  apiKey: getArgValue("--api-key", null),
  apiUrl: getArgValue("--api-url", null),
  rpcUrl: getArgValue("--rpc-url", process.env.RPC_URL || null),
  schemaPath: getArgValue("--schema-path", "../../specs/erc7730-v2.schema.json"),
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

const ACCEPTED_OPTIONS = [
  "  --address <addr>        On-chain contract address (downloads ABI + source)",
  "  --abi <path>            Path to local ABI JSON file",
  "  --source <path>         Path to folder with Solidity source files",
  "  --output <path>         Destination folder for generated files",
  "  --chain <id>            Chain ID (default: 1)",
  "  --name <name>           Protocol / owner name",
  "  --contract-name <name>  Contract name",
  "  --url <url>             Protocol website URL",
  "  --include-admin         Include admin/governance functions",
  "  --dry-run               Preview without writing files",
  "  --verbose               Show detailed output",
  "  --log <path>            Enable verbose logging to file",
  "  -l                      Enable verbose logging to tools/scripts/logs/",
  "  --backend <name>        LLM backend: openai, anthropic, cursor (default: openai)",
  "  --model <model>         Model name (default: backend-specific)",
  "  --api-key <key>         API key (overrides env var for the selected backend)",
  "  --api-url <url>         Custom API base URL (openai/anthropic backends only)",
  "  --rpc-url <url>         JSON-RPC endpoint for proxy detection (overrides RPC_URL env)",
  "  --schema-path <path>    Relative schema path (default: ../../specs/erc7730-v2.schema.json)",
  "  --help, -h              Show this help message",
];

// =============================================================================
// CLI Helpers (aligned with tools/scripts/ convention)
// =============================================================================

function getArgValue(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    const val = process.argv[idx + 1];
    if (/^0x[0-9a-fA-F]+$/.test(val)) return val;
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

function printHelp(exitCode = 0, errorMessage = null) {
  const write = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    write(errorMessage);
    write("");
  }
  write("Usage: node tools/scripts/generate-7730.js [options]");
  write("\nOptions:");
  for (const opt of ACCEPTED_OPTIONS) write(opt);
  write("\nExamples:");
  write("  # From on-chain address (OpenAI backend, default)");
  write("  node tools/scripts/generate-7730.js --address 0x1234... --output registry/myprotocol --name MyProtocol");
  write("");
  write("  # Using Anthropic backend with a specific model");
  write("  node tools/scripts/generate-7730.js --address 0x1234... --output registry/myprotocol --backend anthropic --model claude-sonnet-4-20250514");
  write("");
  write("  # Using Cursor agent CLI backend");
  write("  node tools/scripts/generate-7730.js --address 0x1234... --output registry/myprotocol --backend cursor");
  write("");
  write("  # From a local ABI file");
  write("  node tools/scripts/generate-7730.js --abi abi.json --output registry/myprotocol --address 0x1234... --name MyProtocol");
  write("");
  write("  # From local source code");
  write("  node tools/scripts/generate-7730.js --source ./contracts --output registry/myprotocol --name MyProtocol --include-admin");
  write("\nBackends:");
  write("  openai       Uses OpenAI-compatible API (default model: gpt-4o)");
  write("  anthropic    Uses Anthropic API (default model: claude-sonnet-4-20250514)");
  write("  cursor       Uses Cursor agent CLI in ask mode (default model: opus-4.6)");
  write("\nEnvironment Variables:");
  write("  OPENAI_API_KEY      API key for the openai backend");
  write("  ANTHROPIC_API_KEY   API key for the anthropic backend");
  write("  ETHERSCAN_API_KEY   For downloading contract source from Etherscan");
  write("  RPC_URL             JSON-RPC endpoint for proxy detection (default: public RPC per chain)");
  process.exit(exitCode);
}

// =============================================================================
// Logging (same pattern as tools/scripts/)
// =============================================================================

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

function appendLogLine(level, message) {
  if (!CONFIG.logFile) return;
  try {
    fs.appendFileSync(CONFIG.logFile, `[${new Date().toISOString()}] [${level}] ${stripAnsi(message)}\n`);
  } catch {
    // noop
  }
}

function initLogFile() {
  if (!CONFIG.logFile) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    fs.appendFileSync(
      CONFIG.logFile,
      `\n[${new Date().toISOString()}] generate-7730 start: ${process.argv.join(" ")}\n`
    );
  } catch (error) {
    console.error(`Failed to initialize log file ${CONFIG.logFile}: ${error.message}`);
    process.exit(1);
  }
}

const baseLog = console.log.bind(console);
const baseWarn = console.warn.bind(console);
const baseError = console.error.bind(console);
console.log = (...args) => { appendLogLine("INFO", args.join(" ")); baseLog(...args); };
console.warn = (...args) => { appendLogLine("WARN", args.join(" ")); baseWarn(...args); };
console.error = (...args) => { appendLogLine("ERROR", args.join(" ")); baseError(...args); };

function log(msg) { console.log(msg); }
function verboseLog(msg) {
  appendLogLine("DEBUG", msg);
  if (CONFIG.verbose) console.log(msg);
}

// =============================================================================
// HTTP Helpers
// =============================================================================

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === "https:" ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    }).on("error", reject);
  });
}

function httpPost(urlStr, payload, contentType = "application/json") {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === "https:" ? https : http;
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = client.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// =============================================================================
// Proxy Detection
// =============================================================================

const DEFAULT_RPC_URLS = {
  1: "https://eth.llamarpc.com",
  10: "https://mainnet.optimism.io",
  56: "https://bsc-dataseed.binance.org",
  100: "https://rpc.gnosischain.com",
  137: "https://polygon-rpc.com",
  250: "https://rpc.ftm.tools",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  43114: "https://api.avax.network/ext/bc/C/rpc",
  59144: "https://rpc.linea.build",
};

// ERC-1967 implementation storage slot: keccak256("eip1967.proxy.implementation") - 1
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_ADDRESS = "0x" + "0".repeat(40);

function getRpcUrl(chainId) {
  return CONFIG.rpcUrl || DEFAULT_RPC_URLS[chainId] || null;
}

function isLikelyProxyAbi(abi) {
  if (!Array.isArray(abi) || abi.length === 0) return false;
  const functions = abi.filter((e) => e.type === "function");
  if (functions.length > 10) return false;
  const proxyNames = new Set([
    "admin", "implementation", "upgradeTo", "upgradeToAndCall",
    "changeAdmin", "proxyAdmin", "pendingAdmin", "acceptAdmin",
  ]);
  const proxyFnCount = functions.filter((f) => proxyNames.has(f.name)).length;
  return functions.length === 0 || proxyFnCount >= Math.ceil(functions.length / 2);
}

async function detectProxyViaEtherscan(chainId, address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    verboseLog("  Etherscan: no API key, skipping proxy check");
    return null;
  }
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=contract&action=getsourcecode&address=${address}` +
    `&apikey=${apiKey}`;
  verboseLog(`  Checking Etherscan proxy status for ${address}...`);
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode !== 200) return null;
    const data = JSON.parse(body);
    if (data.status === "1" && data.result && data.result[0]) {
      const result = data.result[0];
      if (result.Proxy === "1" && result.Implementation) {
        log(`  ✓ Etherscan reports proxy → implementation: ${result.Implementation}`);
        return result.Implementation;
      }
    }
    return null;
  } catch (err) {
    verboseLog(`  Etherscan proxy check error: ${err.message}`);
    return null;
  }
}

async function detectProxyViaERC1967(chainId, address) {
  const rpcUrl = getRpcUrl(chainId);
  if (!rpcUrl) {
    verboseLog(`  No RPC URL for chain ${chainId}, skipping ERC-1967 slot check`);
    return null;
  }
  verboseLog(`  Reading ERC-1967 slot for ${address} via ${rpcUrl}...`);
  try {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getStorageAt",
      params: [address, ERC1967_IMPL_SLOT, "latest"],
      id: 1,
    });
    const { statusCode, body } = await httpPost(rpcUrl, payload);
    if (statusCode !== 200) {
      verboseLog(`  RPC returned ${statusCode}`);
      return null;
    }
    const data = JSON.parse(body);
    if (data.error) {
      verboseLog(`  RPC error: ${data.error.message || JSON.stringify(data.error)}`);
      return null;
    }
    if (data.result && data.result !== "0x" + "0".repeat(64)) {
      const impl = "0x" + data.result.slice(-40);
      if (impl.toLowerCase() !== ZERO_ADDRESS && impl.toLowerCase() !== address.toLowerCase()) {
        log(`  ✓ ERC-1967 implementation slot → ${impl}`);
        return impl;
      }
    }
    return null;
  } catch (err) {
    verboseLog(`  ERC-1967 slot read error: ${err.message}`);
    return null;
  }
}

/**
 * Detect whether an address is a proxy contract and resolve its implementation.
 * Tries Etherscan first (explicit proxy flag), then reads the ERC-1967 storage slot.
 * Returns the implementation address, or null if not a proxy.
 */
async function resolveProxyImplementation(chainId, address) {
  verboseLog(`  Checking if ${address} is a proxy...`);

  const etherscanImpl = await detectProxyViaEtherscan(chainId, address);
  if (etherscanImpl) return etherscanImpl;

  const erc1967Impl = await detectProxyViaERC1967(chainId, address);
  if (erc1967Impl) return erc1967Impl;

  return null;
}

// =============================================================================
// Source Code Retrieval
// =============================================================================

async function fetchFromSourcify(chainId, address) {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`;
  verboseLog(`  Trying Sourcify: ${url}`);
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode !== 200) {
      verboseLog(`  Sourcify returned ${statusCode}`);
      return null;
    }
    const data = JSON.parse(body);
    if (!data || (!data.sourceCode && !data.sources)) {
      verboseLog("  Sourcify: no source code in response");
      return null;
    }
    // Sourcify v2 returns sources as an object keyed by filename
    const sources = data.sources || data.sourceCode;
    if (typeof sources === "object" && sources !== null) {
      const parts = [];
      for (const [filename, content] of Object.entries(sources)) {
        const src = typeof content === "string" ? content : content.content || "";
        if (src) parts.push(`// --- ${filename} ---\n${src}`);
      }
      if (parts.length > 0) {
        log(`  ✓ Retrieved source from Sourcify (${parts.length} files)`);
        return parts.join("\n\n");
      }
    }
    if (typeof sources === "string") {
      log("  ✓ Retrieved source from Sourcify");
      return sources;
    }
    verboseLog("  Sourcify: could not extract source code");
    return null;
  } catch (err) {
    verboseLog(`  Sourcify error: ${err.message}`);
    return null;
  }
}

async function fetchFromEtherscan(chainId, address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    verboseLog("  Etherscan: no ETHERSCAN_API_KEY set, skipping");
    return null;
  }
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=contract&action=getsourcecode&address=${address}` +
    `&apikey=${apiKey}`;
  verboseLog(`  Trying Etherscan: chainId=${chainId} address=${address}`);
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode !== 200) {
      verboseLog(`  Etherscan returned ${statusCode}`);
      return null;
    }
    const data = JSON.parse(body);
    if (data.status !== "1" || !data.result || !data.result[0]) {
      verboseLog(`  Etherscan: ${data.message || "no result"}`);
      return null;
    }
    const result = data.result[0];
    let sourceCode = result.SourceCode || "";

    // Etherscan double-wraps multi-file sources in {{ }}
    if (sourceCode.startsWith("{{")) {
      try {
        const inner = JSON.parse(sourceCode.slice(1, -1));
        const sources = inner.sources || inner;
        const parts = [];
        for (const [filename, entry] of Object.entries(sources)) {
          const src = typeof entry === "string" ? entry : entry.content || "";
          if (src) parts.push(`// --- ${filename} ---\n${src}`);
        }
        sourceCode = parts.join("\n\n");
      } catch {
        // Use as-is if parsing fails
      }
    }

    if (sourceCode) {
      log(`  ✓ Retrieved source from Etherscan`);
      return sourceCode;
    }
    verboseLog("  Etherscan: empty source code");
    return null;
  } catch (err) {
    verboseLog(`  Etherscan error: ${err.message}`);
    return null;
  }
}

async function fetchSourceCode(chainId, address) {
  log(`\n📡 Fetching source code for ${address} on chain ${chainId}...`);
  let source = await fetchFromSourcify(chainId, address);
  if (!source) {
    source = await fetchFromEtherscan(chainId, address);
  }
  if (!source) {
    log("  ⚠ No source code found; will generate from ABI only");
  }
  return source;
}

// =============================================================================
// ABI Retrieval (for --address without --abi)
// =============================================================================

async function fetchAbiFromSourcify(chainId, address) {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`;
  verboseLog(`  Trying Sourcify for ABI: ${url}`);
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode !== 200) {
      verboseLog(`  Sourcify returned ${statusCode}`);
      return null;
    }
    const data = JSON.parse(body);
    if (data && data.abi) {
      const abi = typeof data.abi === "string" ? JSON.parse(data.abi) : data.abi;
      if (Array.isArray(abi) && abi.length > 0) {
        log(`  ✓ Retrieved ABI from Sourcify (${abi.length} entries)`);
        return abi;
      }
    }
    verboseLog("  Sourcify: no ABI in response");
    return null;
  } catch (err) {
    verboseLog(`  Sourcify ABI error: ${err.message}`);
    return null;
  }
}

async function fetchAbiFromEtherscan(chainId, address) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    verboseLog("  Etherscan: no ETHERSCAN_API_KEY set, skipping ABI fetch");
    return null;
  }
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=contract&action=getabi&address=${address}` +
    `&apikey=${apiKey}`;
  verboseLog(`  Trying Etherscan for ABI: chainId=${chainId} address=${address}`);
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode !== 200) {
      verboseLog(`  Etherscan returned ${statusCode}`);
      return null;
    }
    const data = JSON.parse(body);
    if (data.status !== "1" || !data.result) {
      verboseLog(`  Etherscan ABI: ${data.message || "no result"}`);
      return null;
    }
    const abi = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
    if (Array.isArray(abi) && abi.length > 0) {
      log(`  ✓ Retrieved ABI from Etherscan (${abi.length} entries)`);
      return abi;
    }
    verboseLog("  Etherscan: empty or invalid ABI");
    return null;
  } catch (err) {
    verboseLog(`  Etherscan ABI error: ${err.message}`);
    return null;
  }
}

async function fetchAbi(chainId, address) {
  log(`\n📡 Fetching ABI for ${address} on chain ${chainId}...`);
  let abi = await fetchAbiFromSourcify(chainId, address);
  if (!abi) {
    abi = await fetchAbiFromEtherscan(chainId, address);
  }
  if (!abi) {
    log("  ⚠ Could not download ABI");
  }
  return abi;
}

/**
 * Fetch ABI + source from Sourcify and/or Etherscan for a single address.
 * Does NOT perform proxy resolution (see fetchContractData for that).
 */
async function fetchContractDataDirect(chainId, address) {
  let abi = null;
  let sourceCode = null;
  let contractName = null;

  // Sourcify: try to get everything in one request
  const sourcifyUrl = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`;
  verboseLog(`  Trying Sourcify (full): ${sourcifyUrl}`);
  try {
    const { statusCode, body } = await httpGet(sourcifyUrl);
    if (statusCode === 200) {
      const data = JSON.parse(body);

      if (data.abi) {
        abi = typeof data.abi === "string" ? JSON.parse(data.abi) : data.abi;
        if (Array.isArray(abi) && abi.length > 0) {
          log(`  ✓ ABI from Sourcify (${abi.length} entries)`);
        } else {
          abi = null;
        }
      }

      const sources = data.sources || data.sourceCode;
      if (typeof sources === "object" && sources !== null && !Array.isArray(sources)) {
        const parts = [];
        for (const [filename, content] of Object.entries(sources)) {
          const src = typeof content === "string" ? content : content.content || "";
          if (src) parts.push(`// --- ${filename} ---\n${src}`);
        }
        if (parts.length > 0) {
          sourceCode = parts.join("\n\n");
          log(`  ✓ Source from Sourcify (${parts.length} files)`);
        }
      } else if (typeof sources === "string" && sources) {
        sourceCode = sources;
        log("  ✓ Source from Sourcify");
      }

      if (data.name) contractName = data.name;
      else if (data.contractName) contractName = data.contractName;
    }
  } catch (err) {
    verboseLog(`  Sourcify error: ${err.message}`);
  }

  // Etherscan fallback for anything still missing
  if (!abi || !sourceCode) {
    const apiKey = process.env.ETHERSCAN_API_KEY;
    if (apiKey) {
      const url =
        `https://api.etherscan.io/v2/api?chainid=${chainId}` +
        `&module=contract&action=getsourcecode&address=${address}` +
        `&apikey=${apiKey}`;
      verboseLog(`  Trying Etherscan fallback: chainId=${chainId}`);
      try {
        const { statusCode, body } = await httpGet(url);
        if (statusCode === 200) {
          const data = JSON.parse(body);
          if (data.status === "1" && data.result && data.result[0]) {
            const result = data.result[0];

            if (!abi && result.ABI && result.ABI !== "Contract source code not verified") {
              try {
                abi = JSON.parse(result.ABI);
                if (Array.isArray(abi) && abi.length > 0) {
                  log(`  ✓ ABI from Etherscan (${abi.length} entries)`);
                } else {
                  abi = null;
                }
              } catch {
                abi = null;
              }
            }

            if (!sourceCode) {
              let src = result.SourceCode || "";
              if (src.startsWith("{{")) {
                try {
                  const inner = JSON.parse(src.slice(1, -1));
                  const srcs = inner.sources || inner;
                  const parts = [];
                  for (const [filename, entry] of Object.entries(srcs)) {
                    const s = typeof entry === "string" ? entry : entry.content || "";
                    if (s) parts.push(`// --- ${filename} ---\n${s}`);
                  }
                  src = parts.join("\n\n");
                } catch {
                  // use as-is
                }
              }
              if (src) {
                sourceCode = src;
                log(`  ✓ Source from Etherscan`);
              }
            }

            if (!contractName && result.ContractName) {
              contractName = result.ContractName;
            }
          }
        }
      } catch (err) {
        verboseLog(`  Etherscan error: ${err.message}`);
      }
    } else if (!abi) {
      log("  ⚠ No ETHERSCAN_API_KEY set; cannot fetch from Etherscan");
    }
  }

  return { abi, sourceCode, contractName };
}

/**
 * Fetch both ABI and source code for an on-chain address.
 * Detects proxy contracts and automatically fetches from the implementation.
 */
async function fetchContractData(chainId, address) {
  log(`\n📡 Fetching contract data for ${address} on chain ${chainId}...`);

  // Step 1: detect proxy before fetching ABI/source
  const implAddress = await resolveProxyImplementation(chainId, address);

  if (implAddress) {
    log(`  🔀 Proxy detected! Fetching ABI & source from implementation ${implAddress}`);
    const result = await fetchContractDataDirect(chainId, implAddress);

    // Heuristic safety check: if the implementation ABI also looks like a proxy, warn
    if (result.abi && isLikelyProxyAbi(result.abi)) {
      log("  ⚠ Implementation ABI also looks like a proxy — results may be incomplete");
    }

    return { ...result, implementationAddress: implAddress };
  }

  // No proxy detected — fetch directly
  const result = await fetchContractDataDirect(chainId, address);

  // Post-hoc heuristic: warn if the ABI looks proxy-like but we couldn't resolve
  if (result.abi && isLikelyProxyAbi(result.abi)) {
    log("  ⚠ ABI looks like a proxy contract but no implementation address could be resolved.");
    log("    Try providing --rpc-url or setting ETHERSCAN_API_KEY for proxy detection.");
  }

  return result;
}

function readSourceFolder(folderPath) {
  log(`\n📂 Reading source files from ${folderPath}...`);
  const parts = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".sol")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        parts.push(`// --- ${path.relative(folderPath, fullPath)} ---\n${content}`);
      }
    }
  }
  walk(folderPath);
  log(`  ✓ Read ${parts.length} Solidity files`);
  return parts.join("\n\n");
}

// =============================================================================
// Reference Material Loading
// =============================================================================

function loadSpec() {
  const specPath = path.join(ROOT_DIR, "specs", "erc-7730.md");
  try {
    return fs.readFileSync(specPath, "utf-8");
  } catch {
    console.warn(`  ⚠ Could not read spec from ${specPath}`);
    return "";
  }
}

function loadSchema() {
  const schemaPath = path.join(ROOT_DIR, "specs", "erc7730-v2.schema.json");
  try {
    return fs.readFileSync(schemaPath, "utf-8");
  } catch {
    console.warn(`  ⚠ Could not read schema from ${schemaPath}`);
    return "";
  }
}

function loadPrompt(filename) {
  const promptPath = path.join(SCRIPT_DIR, "prompts", filename);
  try {
    return fs.readFileSync(promptPath, "utf-8");
  } catch (err) {
    console.error(`Failed to load prompt ${promptPath}: ${err.message}`);
    process.exit(1);
  }
}

async function fetchExample() {
  const url = "https://eips.ethereum.org/assets/eip-7730/example-main.json";
  try {
    const { statusCode, body } = await httpGet(url);
    if (statusCode === 200) return body;
  } catch {
    // non-critical
  }
  return null;
}

// =============================================================================
// LLM Backends
// =============================================================================

/**
 * Invoke the LLM via the configured backend.
 * Returns the raw text response from the model.
 */
async function invokeLLM(systemPrompt, userContent) {
  verboseLog(`  Invoking LLM [${CONFIG.backend}] (system: ${systemPrompt.length} chars, user: ${userContent.length} chars)...`);

  if (CONFIG.verbose) {
    log("  ── System prompt (first 500 chars) ──");
    log("  " + systemPrompt.slice(0, 500).replace(/\n/g, "\n  ") + (systemPrompt.length > 500 ? "\n  ..." : ""));
    log("  ── User message (first 500 chars) ──");
    log("  " + userContent.slice(0, 500).replace(/\n/g, "\n  ") + (userContent.length > 500 ? "\n  ..." : ""));
    log("  ── Waiting for LLM response ──");
  }

  const startTime = Date.now();
  let result;

  switch (CONFIG.backend) {
    case "openai":
      result = await invokeLangGraphOpenAI(systemPrompt, userContent);
      break;
    case "anthropic":
      result = await invokeLangGraphAnthropic(systemPrompt, userContent);
      break;
    case "cursor":
      result = await invokeCursorAgent(systemPrompt, userContent);
      break;
    default:
      throw new Error(`Unknown backend: ${CONFIG.backend}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!result || result.trim().length === 0) {
    throw new Error(`No content received from LLM [${CONFIG.backend}] after ${elapsed}s`);
  }

  if (CONFIG.verbose) {
    log(`  ── LLM response complete: ${result.length} chars, ${elapsed}s ──`);
    log(`  Response preview: ${result.slice(0, 300).replace(/\n/g, "\\n")}...`);
  } else {
    verboseLog(`  LLM response: ${result.length} chars in ${elapsed}s`);
  }

  return result;
}

// --- OpenAI backend (LangGraph + ChatOpenAI) --------------------------------

async function invokeLangGraphOpenAI(systemPrompt, userContent) {
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { ChatOpenAI } = await import("@langchain/openai");

  if (!CONFIG.apiKey) {
    throw new Error("OpenAI backend requires an API key. Set OPENAI_API_KEY or pass --api-key.");
  }

  verboseLog(`  OpenAI endpoint: ${CONFIG.apiUrl}`);
  verboseLog(`  OpenAI model: ${CONFIG.model}`);

  const model = new ChatOpenAI({
    model: CONFIG.model,
    temperature: 0,
    configuration: {
      baseURL: CONFIG.apiUrl,
      apiKey: CONFIG.apiKey,
    },
  });

  const agent = createReactAgent({ llm: model, tools: [] });
  return await streamAgent(agent, systemPrompt, userContent);
}

// --- Anthropic backend (LangGraph + ChatAnthropic) --------------------------

async function invokeLangGraphAnthropic(systemPrompt, userContent) {
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { ChatAnthropic } = await import("@langchain/anthropic");

  if (!CONFIG.apiKey) {
    throw new Error("Anthropic backend requires an API key. Set ANTHROPIC_API_KEY or pass --api-key.");
  }

  verboseLog(`  Anthropic model: ${CONFIG.model}`);
  if (CONFIG.apiUrl && CONFIG.apiUrl !== BACKEND_DEFAULTS.anthropic.url) {
    verboseLog(`  Anthropic URL override: ${CONFIG.apiUrl}`);
  }

  const modelOpts = {
    model: CONFIG.model,
    temperature: 0,
    anthropicApiKey: CONFIG.apiKey,
  };
  if (CONFIG.apiUrl && CONFIG.apiUrl !== BACKEND_DEFAULTS.anthropic.url) {
    modelOpts.anthropicApiUrl = CONFIG.apiUrl;
  }

  const model = new ChatAnthropic(modelOpts);
  const agent = createReactAgent({ llm: model, tools: [] });
  return await streamAgent(agent, systemPrompt, userContent);
}

// --- Shared streaming helper for LangGraph agents ---------------------------

async function streamAgent(agent, systemPrompt, userContent) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  let fullContent = "";
  let chunkCount = 0;
  const startTime = Date.now();

  const stream = await agent.stream({ messages }, { streamMode: "messages" });

  for await (const [msgChunk] of stream) {
    const token = msgChunk?.content;
    if (typeof token === "string" && token.length > 0) {
      fullContent += token;
      chunkCount++;

      if (CONFIG.verbose) {
        if (chunkCount <= 3) {
          log(`  [chunk ${chunkCount}] ${token.slice(0, 200)}${token.length > 200 ? "..." : ""}`);
        } else if (chunkCount % 50 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log(`  [${elapsed}s] ...${fullContent.length} chars received (${chunkCount} chunks)`);
        }
      }
    }
  }

  return fullContent;
}

// --- Cursor agent CLI backend -----------------------------------------------

async function invokeCursorAgent(systemPrompt, userContent) {
  const combinedPrompt = [
    "# System Instructions",
    "",
    systemPrompt,
    "",
    "# User Input",
    "",
    userContent,
    "",
    "# Output Requirements",
    "",
    "Output ONLY the requested JSON object. No markdown fences, no commentary, no explanations.",
  ].join("\n");

  // Write prompt to a temp file to avoid OS argument length limits
  const tmpDir = path.join(os.tmpdir(), "erc7730-generate");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `prompt-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, combinedPrompt, "utf-8");

  verboseLog(`  Wrote prompt to ${tmpFile} (${combinedPrompt.length} chars)`);

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

  verboseLog(`  Running: cursor ${args.join(" ")}`);

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

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (CONFIG.verbose && stdout.length % 5000 < text.length) {
        log(`  [cursor] ...${stdout.length} chars received`);
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

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

function extractJson(text) {
  // Try to parse the entire text as JSON first
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  // Try to find JSON within markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // noop
    }
  }

  // Try to find an object or array
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
// Generation Workflows
// =============================================================================

async function generateCalldata(abi, sourceCode, contextInfo) {
  log("\n🔧 Generating calldata ERC-7730 descriptor...");

  const systemPrompt = loadPrompt("system-calldata.md");

  const userParts = [];
  userParts.push("## Contract ABI\n```json\n" + JSON.stringify(abi, null, 2) + "\n```");

  if (sourceCode) {
    // Truncate source if very large to fit context window
    const maxSourceChars = 80000;
    const truncatedSource = sourceCode.length > maxSourceChars
      ? sourceCode.slice(0, maxSourceChars) + "\n\n// ... (source truncated for context limit)"
      : sourceCode;
    userParts.push("## Solidity Source Code\n```solidity\n" + truncatedSource + "\n```");
  }

  userParts.push("## Generation Parameters");
  userParts.push(`- Contract name: ${contextInfo.contractName}`);
  userParts.push(`- Protocol / owner name: ${contextInfo.protocolName || contextInfo.contractName}`);
  if (contextInfo.protocolUrl) userParts.push(`- Protocol URL: ${contextInfo.protocolUrl}`);
  if (contextInfo.address) {
    userParts.push(`- Deployment address: ${contextInfo.address}`);
    userParts.push(`- Chain ID: ${contextInfo.chainId}`);
  } else {
    userParts.push("- Deployment address: NOT PROVIDED (use placeholder)");
  }
  userParts.push(`- Schema path: ${CONFIG.schemaPath}`);
  userParts.push(`- Include admin functions: ${CONFIG.includeAdmin}`);

  // Include spec extract and example for reference
  const spec = loadSpec();
  if (spec) {
    const maxSpecChars = 30000;
    const truncatedSpec = spec.length > maxSpecChars
      ? spec.slice(0, maxSpecChars) + "\n\n... (spec truncated)"
      : spec;
    userParts.push("## ERC-7730 Specification (reference)\n" + truncatedSpec);
  }

  const schema = loadSchema();
  if (schema) {
    userParts.push("## ERC-7730 v2 JSON Schema (reference)\n```json\n" + schema + "\n```");
  }

  const example = await fetchExample();
  if (example) {
    userParts.push("## Example ERC-7730 file\n```json\n" + example + "\n```");
  }

  const userContent = userParts.join("\n\n");
  const rawResponse = await invokeLLM(systemPrompt, userContent);

  verboseLog(`  Raw LLM response length: ${rawResponse.length}`);
  if (CONFIG.verbose) verboseLog(`  Response preview: ${rawResponse.slice(0, 500)}...`);

  const descriptor = extractJson(rawResponse);
  return descriptor;
}

async function generateEip712(abi, sourceCode, contextInfo) {
  if (!sourceCode) {
    log("\n📝 Skipping EIP-712 generation (no source code available)");
    return [];
  }

  log("\n📝 Generating EIP-712 ERC-7730 descriptors...");

  const systemPrompt = loadPrompt("system-eip712.md");

  const userParts = [];
  userParts.push("## Contract ABI\n```json\n" + JSON.stringify(abi, null, 2) + "\n```");

  const maxSourceChars = 80000;
  const truncatedSource = sourceCode.length > maxSourceChars
    ? sourceCode.slice(0, maxSourceChars) + "\n\n// ... (source truncated for context limit)"
    : sourceCode;
  userParts.push("## Solidity Source Code\n```solidity\n" + truncatedSource + "\n```");

  userParts.push("## Generation Parameters");
  userParts.push(`- Contract name: ${contextInfo.contractName}`);
  userParts.push(`- Protocol / owner name: ${contextInfo.protocolName || contextInfo.contractName}`);
  if (contextInfo.protocolUrl) userParts.push(`- Protocol URL: ${contextInfo.protocolUrl}`);
  if (contextInfo.address) {
    userParts.push(`- Deployment address: ${contextInfo.address}`);
    userParts.push(`- Chain ID: ${contextInfo.chainId}`);
  } else {
    userParts.push("- Deployment address: NOT PROVIDED (use placeholder)");
  }
  userParts.push(`- Schema path: ${CONFIG.schemaPath}`);

  const rawResponse = await invokeLLM(systemPrompt, userParts.join("\n\n"));

  verboseLog(`  Raw EIP-712 LLM response length: ${rawResponse.length}`);

  const parsed = extractJson(rawResponse);

  if (Array.isArray(parsed)) {
    return parsed;
  }
  // If the LLM returned a single descriptor object, wrap it
  if (parsed && parsed.descriptor) {
    return [parsed];
  }
  if (parsed && parsed.$schema) {
    return [{ filename: `eip712-${contextInfo.contractName}.json`, descriptor: parsed }];
  }

  log("  ⚠ LLM returned unexpected format for EIP-712; skipping");
  return [];
}

// =============================================================================
// Output
// =============================================================================

function writeDescriptor(outputDir, filename, descriptor) {
  const filePath = path.join(outputDir, filename);
  const content = JSON.stringify(descriptor, null, 2) + "\n";

  if (CONFIG.dryRun) {
    log(`\n📄 Would write: ${filePath}`);
    log(content);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  log(`  ✓ Written: ${filePath}`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  initLogFile();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp(0);
  }

  // Validate inputs
  if (!CONFIG.abiPath && !CONFIG.sourcePath && !CONFIG.address) {
    printHelp(1, "Error: At least one of --address, --abi, or --source is required.");
  }
  if (CONFIG.abiPath && CONFIG.sourcePath) {
    printHelp(1, "Error: --abi and --source are mutually exclusive.");
  }
  if (!CONFIG.outputPath) {
    printHelp(1, "Error: --output is required.");
  }

  log("ERC-7730 Descriptor Generator");
  log("=============================");
  if (CONFIG.dryRun) log("🔍 DRY RUN MODE - No files will be written\n");

  let abi = null;
  let sourceCode = null;
  let fetchedContractName = null;
  let implementationAddress = null;

  // Mode 1: --address only (or --address with --abi/--source for supplemental data)
  if (CONFIG.address && !CONFIG.abiPath && !CONFIG.sourcePath) {
    // Address-only mode: download everything from on-chain
    const result = await fetchContractData(CONFIG.chainId, CONFIG.address);
    abi = result.abi;
    sourceCode = result.sourceCode;
    fetchedContractName = result.contractName;
    implementationAddress = result.implementationAddress || null;

    if (!abi) {
      console.error("\n❌ Could not retrieve ABI for address " + CONFIG.address);
      console.error("The contract may not be verified. Try providing --abi or --source instead.");
      process.exit(1);
    }
  } else {
    // Mode 2: --abi (local ABI file)
    if (CONFIG.abiPath) {
      const abiRaw = fs.readFileSync(path.resolve(CONFIG.abiPath), "utf-8");
      abi = JSON.parse(abiRaw);
      if (abi.abi && Array.isArray(abi.abi)) abi = abi.abi;
      log(`✓ Loaded ABI from ${CONFIG.abiPath} (${abi.length} entries)`);
    }

    // Mode 3: --source (local source folder)
    if (CONFIG.sourcePath) {
      const srcDir = path.resolve(CONFIG.sourcePath);
      if (!fs.existsSync(srcDir)) {
        console.error(`Error: Source directory not found: ${srcDir}`);
        process.exit(1);
      }
      sourceCode = readSourceFolder(srcDir);

      if (!abi) {
        abi = [];
        log("  ℹ No ABI provided; LLM will infer from source code");
      }
    }

    // If --address is also given alongside --abi or --source, fetch what's missing
    if (CONFIG.address) {
      if (!sourceCode) {
        sourceCode = await fetchSourceCode(CONFIG.chainId, CONFIG.address);
      }
      if (!abi || abi.length === 0) {
        const fetchedAbi = await fetchAbi(CONFIG.chainId, CONFIG.address);
        if (fetchedAbi) abi = fetchedAbi;
      }
    }
  }

  // Derive contract name
  const contractName =
    CONFIG.contractName ||
    fetchedContractName ||
    (CONFIG.abiPath ? path.basename(CONFIG.abiPath, ".json").replace(/^abi[-_]?/i, "") : null) ||
    (CONFIG.sourcePath ? path.basename(path.resolve(CONFIG.sourcePath)) : null) ||
    "Contract";

  const contextInfo = {
    contractName,
    protocolName: CONFIG.protocolName,
    protocolUrl: CONFIG.protocolUrl,
    address: CONFIG.address,
    chainId: CONFIG.chainId,
  };

  log(`\nContract: ${contractName}`);
  log(`Protocol: ${contextInfo.protocolName || "(not specified)"}`);
  log(`Chain: ${contextInfo.chainId}`);
  log(`Address: ${contextInfo.address || "(not specified)"}`);
  if (implementationAddress) {
    log(`Implementation: ${implementationAddress} (proxy resolved)`);
  }
  log(`Output: ${CONFIG.outputPath}`);
  log(`Include admin: ${CONFIG.includeAdmin}`);

  log(`\n🤖 LLM backend: ${CONFIG.backend} (model: ${CONFIG.model})`);
  if (CONFIG.backend !== "cursor") {
    log(`   Endpoint: ${CONFIG.apiUrl}`);
  }

  // Generate calldata descriptor
  let calldataDescriptor;
  try {
    calldataDescriptor = await generateCalldata(abi, sourceCode, contextInfo);
    const calldataFilename = `calldata-${contractName}.json`;
    writeDescriptor(path.resolve(CONFIG.outputPath), calldataFilename, calldataDescriptor);

    const formatCount = calldataDescriptor?.display?.formats
      ? Object.keys(calldataDescriptor.display.formats).length
      : 0;
    log(`  ✓ Calldata descriptor: ${formatCount} functions`);
  } catch (err) {
    console.error(`\n❌ Calldata generation failed: ${err.message}`);
    if (CONFIG.verbose) console.error(err.stack);
  }

  // Generate EIP-712 descriptors
  try {
    const eip712Results = await generateEip712(abi, sourceCode, contextInfo);
    if (eip712Results.length === 0) {
      log("\n  ℹ No EIP-712 messages found in source code");
    } else {
      for (const item of eip712Results) {
        const filename = item.filename || `eip712-${contractName}.json`;
        const descriptor = item.descriptor;
        writeDescriptor(path.resolve(CONFIG.outputPath), filename, descriptor);
        log(`  ✓ EIP-712 descriptor: ${filename}`);
      }
    }
  } catch (err) {
    console.error(`\n❌ EIP-712 generation failed: ${err.message}`);
    if (CONFIG.verbose) console.error(err.stack);
  }

  // Summary
  log("\n============================================================");
  log("📊 GENERATION COMPLETE");
  log("============================================================");
  if (CONFIG.dryRun) {
    log("\n🔍 Dry run complete - no files were written.");
  } else {
    log(`\nOutput directory: ${path.resolve(CONFIG.outputPath)}`);
    log("\nNext steps:");
    log("  1. Review the generated file(s) for accuracy");
    log("  2. Fill in any TODO placeholders (deployment addresses, etc.)");
    log("  3. Run linting:  source .env && source tools/linter/.venv/bin/activate && erc7730 lint <file>");
    log("  4. Generate tests: source .env && node tools/scripts/generate-tests.js <file>");
  }
}

main().catch((err) => {
  console.error(`\nUnexpected error: ${err.message}`);
  if (CONFIG.verbose) console.error(err.stack);
  process.exit(1);
});
