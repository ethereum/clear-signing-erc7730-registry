#!/usr/bin/env node
/**
 * Fix ERC-7730 display field paths so @ethereum-sourcify/clear-signing can
 * resolve values (whole named tuples / arrays cannot use format "raw").
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VFAT = path.resolve(__dirname, "../../registry/vfat");

const ADDR_TYPES = {
  types: ["eoa", "contract", "token"],
  sources: ["local", "ens"],
};

function addrField(path, label, visible = "always") {
  return {
    path,
    label,
    format: "addressName",
    visible,
    params: ADDR_TYPES,
  };
}

function rawField(path, label, visible = "always") {
  return { path, label, format: "raw", visible };
}

const NEVER_RAW_PATHS = new Set([
  "params",
  "harvestParams",
  "withdrawParams",
  "increaseParams",
  "positionSettings",
  "steps",
  "routes",
  "proposal",
  "harvestSweepTokens",
  "withdrawSweepTokens",
  "sweepTokens",
  "callData",
  "values",
  "data",
  "permissions",
  "selectors",
  "claims",
  "nftClaims",
  "zap",
  "depositExtraData",
  "claimExtraData",
  "extraData",
  "addLiquidityParams",
  "removeLiquidityParams",
  "rebalanceConfig",
  "rewardConfig",
  "exitConfig",
  "increase",
  "harvest",
  "withdraw",
  "depositPosition",
  "depositFarm",
  "claimFarm",
  "positions",
  "farms",
  "settings",
  "tokenIds",
  "payloads",
  "inPlace",
  "amounts",
  "tokenIds",
]);

function expandField(field) {
  const { path: p, format, visible } = field;
  if (format !== "raw" && p !== "farm" && p !== "position") return [field];

  if (p === "farm") {
    return [
      addrField("farm.stakingContract", "Staking contract"),
      rawField("farm.poolIndex", "Pool index"),
    ];
  }

  if (p === "position") {
    return [
      addrField("position.farm.stakingContract", "Staking contract"),
      rawField("position.farm.poolIndex", "Pool index"),
      addrField("position.nft", "NFT", "optional"),
      rawField("position.tokenId", "Token ID", "optional"),
    ];
  }

  if (p === "strategies" || p === "sickles" || p === "targets") {
    return [addrField(`${p}.[]`, p === "targets" ? "Target" : p.slice(0, -1))];
  }

  if (p === "tokens") {
    return [addrField("tokens.[]", "Token")];
  }

  if (NEVER_RAW_PATHS.has(p) && format === "raw") {
    return [{ ...field, visible: "never" }];
  }

  if (p === "steps" || p === "routes") {
    return [{ ...field, visible: "never" }];
  }

  return [field];
}

function fixFields(fields) {
  const out = [];
  for (const f of fields) {
    out.push(...expandField(f));
  }
  return out;
}

function fixFile(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const formats = doc.display?.formats ?? {};
  let changed = 0;
  for (const fmt of Object.values(formats)) {
    if (!fmt.fields) continue;
    const next = fixFields(fmt.fields);
    if (JSON.stringify(next) !== JSON.stringify(fmt.fields)) {
      fmt.fields = next;
      changed += 1;
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n");
    console.log(`${path.basename(filePath)}: updated ${changed} format(s)`);
  }
}

for (const name of fs.readdirSync(VFAT)) {
  if (name.startsWith("calldata-") && name.endsWith(".json")) {
    fixFile(path.join(VFAT, name));
  }
}
