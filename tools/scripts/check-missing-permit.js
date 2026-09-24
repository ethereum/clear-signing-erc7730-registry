#!/usr/bin/env node
/**
 * Detect ERC-7730 entities whose contracts expose a permit-style function
 * (EIP-2612, Permit2) but have no matching descriptor in the registry.
 *
 * The script has two phases:
 *
 *   Phase 1 (no network, default):
 *     Walks registry/ and reports entities where:
 *       - the entity has one or more calldata descriptors, AND
 *       - no descriptor in the entity (calldata or eip712) is permit-shaped
 *         by filename or by 'display.formats' key.
 *
 *   Phase 2 (--check-onchain):
 *     For each candidate from phase 1, fetches the contract ABI via
 *     tools/scripts/lib/abi-fetcher.js and confirms that the contract
 *     actually exposes 'permit', 'permitSingle', 'permitBatch',
 *     'permitTransferFrom', or 'permitWitnessTransferFrom'.
 *
 * Usage:
 *   node tools/scripts/check-missing-permit.js              # phase 1 (offline)
 *   node tools/scripts/check-missing-permit.js --check-onchain --chain 1
 *   node tools/scripts/check-missing-permit.js --entity aave
 *   node tools/scripts/check-missing-permit.js --json
 *
 * Environment (phase 2 only):
 *   ETHERSCAN_API_KEY
 */

const fs = require("fs");
const path = require("path");
const {
  PROVIDERS,
  fetchResolvedAbi,
  setLogger,
} = require("./lib/abi-fetcher");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_DIR = path.join(REPO_ROOT, "registry");

const PERMIT_FUNCTION_NAMES = new Set([
  "permit",
  "permitsingle",
  "permitbatch",
  "permittransferfrom",
  "permitwitnesstransferfrom",
]);

function getArg(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return defaultValue;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("-")) return true;
  return next;
}

const CONFIG = {
  entity: getArg("--entity", null),
  checkOnchain: process.argv.includes("--check-onchain"),
  chainId: Number(getArg("--chain", 1)),
  json: process.argv.includes("--json"),
  verbose: process.argv.includes("--verbose"),
};

if (CONFIG.verbose) setLogger((msg) => console.error(msg));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}

function descriptorIsPermitShaped(filePath, json) {
  const base = path.basename(filePath).toLowerCase();
  for (const name of PERMIT_FUNCTION_NAMES) {
    if (base.includes(name)) return true;
  }
  const formats = json && json.display && json.display.formats;
  if (formats && typeof formats === "object") {
    for (const key of Object.keys(formats)) {
      const lk = key.toLowerCase().trim();
      const nameMatch = lk.match(/^([a-z_][\w]*)\s*\(/);
      if (nameMatch && PERMIT_FUNCTION_NAMES.has(nameMatch[1])) return true;
      if (lk.startsWith("permit(")) return true;
    }
  }
  return false;
}

function collectDeployments(json) {
  const dep =
    (json && json.context && json.context.contract && json.context.contract.deployments) || [];
  return dep
    .filter((d) => d && typeof d.chainId === "number" && typeof d.address === "string")
    .map((d) => ({ chainId: d.chainId, address: d.address }));
}

function analyzeEntityOffline(entityDir) {
  const entity = path.basename(entityDir);
  const calldataFiles = listFiles(entityDir, "calldata");
  const eip712Files = listFiles(entityDir, "eip712");

  if (calldataFiles.length === 0) {
    return { entity, status: "skip-no-calldata", deployments: [] };
  }

  const allDescriptors = [...calldataFiles, ...eip712Files];
  let hasPermit = false;
  for (const f of allDescriptors) {
    const json = readJson(f);
    if (!json) continue;
    if (descriptorIsPermitShaped(f, json)) {
      hasPermit = true;
      break;
    }
  }

  if (hasPermit) {
    return { entity, status: "has-permit", deployments: [] };
  }

  // Collect candidate deployment addresses from all calldata descriptors.
  const deployments = [];
  for (const f of calldataFiles) {
    const json = readJson(f);
    if (!json) continue;
    for (const d of collectDeployments(json)) {
      deployments.push({ ...d, source: path.basename(f) });
    }
  }

  return { entity, status: "candidate", deployments };
}

async function confirmOnchain(candidates) {
  const provider = PROVIDERS[CONFIG.chainId];
  if (!provider) {
    throw new Error(`Chain ${CONFIG.chainId} is not in the supported PROVIDERS registry`);
  }
  if (!process.env[provider.apiKeyEnv]) {
    throw new Error(`Missing ${provider.apiKeyEnv} for chain ${CONFIG.chainId}`);
  }

  const confirmed = [];
  for (const cand of candidates) {
    const deployments = cand.deployments.filter((d) => d.chainId === CONFIG.chainId);
    if (deployments.length === 0) {
      cand.onchain = { checked: false, reason: `no deployment on chain ${CONFIG.chainId}` };
      continue;
    }
    cand.onchain = { checked: true, hits: [] };
    for (const dep of deployments) {
      try {
        const { resolvedAddress, proxyInfo, abi } = await fetchResolvedAbi(
          dep.chainId,
          dep.address
        );
        const permitFns = (Array.isArray(abi) ? abi : [])
          .filter((e) => e && e.type === "function" && typeof e.name === "string")
          .filter((e) => PERMIT_FUNCTION_NAMES.has(e.name.toLowerCase()))
          .map((e) => e.name);
        if (permitFns.length > 0) {
          cand.onchain.hits.push({
            address: dep.address,
            resolvedAddress,
            proxyInfo,
            permitFunctions: [...new Set(permitFns)],
            source: dep.source,
          });
        }
      } catch (e) {
        cand.onchain.hits.push({
          address: dep.address,
          error: e.message,
          source: dep.source,
        });
      }
    }
    if (cand.onchain.hits.some((h) => Array.isArray(h.permitFunctions))) {
      confirmed.push(cand);
    }
  }
  return confirmed;
}

function listEntities() {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  return fs
    .readdirSync(REGISTRY_DIR)
    .map((n) => path.join(REGISTRY_DIR, n))
    .filter((p) => fs.statSync(p).isDirectory())
    .filter((p) => !CONFIG.entity || path.basename(p) === CONFIG.entity)
    .sort();
}

function renderText(candidates, confirmed) {
  const lines = [];
  lines.push(`Missing-permit candidates (offline scan): ${candidates.length}`);
  for (const c of candidates) {
    lines.push(`  - ${c.entity} (${c.deployments.length} deployment(s))`);
  }
  if (CONFIG.checkOnchain) {
    lines.push("");
    lines.push(`On-chain confirmed (chain ${CONFIG.chainId}): ${confirmed.length}`);
    for (const c of confirmed) {
      const hits = c.onchain.hits.filter((h) => Array.isArray(h.permitFunctions));
      const fns = [...new Set(hits.flatMap((h) => h.permitFunctions))];
      lines.push(`  - ${c.entity}: ${fns.join(", ")}`);
      for (const h of hits) {
        lines.push(`      ${h.address}  (${h.source})${h.resolvedAddress && h.resolvedAddress !== h.address ? ` -> ${h.resolvedAddress}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

async function main() {
  const entities = listEntities();
  const candidates = entities
    .map(analyzeEntityOffline)
    .filter((r) => r.status === "candidate");

  let confirmed = [];
  if (CONFIG.checkOnchain) {
    confirmed = await confirmOnchain(candidates);
  }

  if (CONFIG.json) {
    process.stdout.write(
      JSON.stringify(
        {
          chainChecked: CONFIG.checkOnchain ? CONFIG.chainId : null,
          candidates,
          confirmed,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stdout.write(renderText(candidates, confirmed) + "\n");
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
