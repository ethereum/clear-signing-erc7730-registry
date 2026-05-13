/**
 * Shared Etherscan-style ABI fetcher used by tools/scripts/.
 *
 * Responsibilities:
 *   - Provider registry (chainId -> explorer config)
 *   - Rate-limited, retrying HTTPS GET
 *   - getabi and getsourcecode wrappers (with proxy resolution)
 *   - Address utility (isNonZeroAddress)
 *
 * No CLI / no process.exit / no implicit logging — callers inject a logger
 * via setLogger() if they want verbose traces.
 *
 * Extracted from tools/scripts/check-contract-functions.js without
 * behavior change so it can be reused by sibling scripts (e.g.
 * check-missing-permit.js).
 */

const https = require("https");
const http = require("http");

const MIN_REQUEST_INTERVAL_MS = 380;
let _lastExplorerRequestAt = 0;

let _log = () => {};

function setLogger(fn) {
  _log = typeof fn === "function" ? fn : () => {};
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isNonZeroAddress(addr) {
  if (typeof addr !== "string") return false;
  const cleaned = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(cleaned)) return false;
  return cleaned.toLowerCase() !== "0x0000000000000000000000000000000000000000";
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

  _log(`  📡 Fetching ABI: chain=${chainId}, address=${address}`);
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

/**
 * Resolve an address to its implementation ABI:
 *   - looks up getsourcecode metadata
 *   - if Proxy=1 and Implementation is a non-zero address, returns that address's ABI
 *   - otherwise returns the address's own ABI
 *
 * Returns { resolvedAddress, proxyInfo, abi }.
 */
async function fetchResolvedAbi(chainId, address) {
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
  const abi = await fetchAbiFromExplorer(chainId, resolvedAddress);
  return { resolvedAddress, proxyInfo, abi };
}

module.exports = {
  PROVIDERS,
  MIN_REQUEST_INTERVAL_MS,
  setLogger,
  sleep,
  httpsGet,
  rateLimitedHttpsGet,
  callExplorerWithRetry,
  isNonZeroAddress,
  fetchAbiFromExplorer,
  fetchContractSourceMetadata,
  fetchResolvedAbi,
};
