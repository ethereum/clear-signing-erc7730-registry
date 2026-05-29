#!/usr/bin/env node
/**
 * Apply corrected EIP-712 domain name/version values to permit descriptor files.
 *
 * Usage:
 *   node tools/scripts/fix-eip712-domains.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const glob = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const PERMIT_DIR = path.resolve(__dirname, "../../registry/permit");

// (chainId, address, name, version) — null means "don't touch"
const DATA = [
  [1, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", null, null],
  [1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", null, null],
  [1, "0xdAC17F958D2ee523a2206206994597C13D831ec7", null, null],
  [1, "0xdC035D45d973E3EC169d2276DDab16f1e407384F", "USDe", "1"],
  [1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USD Coin", "2"],
  [1, "0x6982508145454Ce325dDbE47a25d4ec3d2311933", null, null],
  [1, "0x514910771AF9Ca656af840dff83E8264EcF986CA", "ChainLink Token", "1"],
  [1, "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "Wrapped stETH", "1"],
  [1, "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", null, null],
  [1, "0x6b175474e89094c44da98b954eedeac495271d0f", "Dai Stablecoin", "1"],
  [1, "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", "Aave Token", "1"],
  [10, "0x9cfB13E6c11054ac9fcB92BA89644F30775436e4", "Wrapped stETH", "1"],
  [10, "0x4200000000000000000000000000000000000006", null, null],
  [10, "0x68f180fcCe6836688e9084f035309E29Bf0A2095", "Wrapped BTC", "1"],
  [10, "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", "Aave Token", "1"],
  [10, "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "Tether USD", "1"],
  [10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USD Coin", "2"],
  [10, "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", "Synthetix Network Token", "1"],
  [10, "0x4200000000000000000000000000000000000042", "Optimism", "1"],
  [10, "0xc40F949F8a4e094D1b49a23ea9241D289B7b2819", "LUSD Stablecoin", "1"],
  [10, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "Dai Stablecoin", "1"],
  [10, "0xb0b195aefa3650a6908f15cdac7d92f8a5791b0b", "Sonne", "1"],
  [56, "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", "PancakeSwap Token", "1"],
  [56, "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", null, null],
  [56, "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USD Coin", "2"],
  [56, "0x7e624fa0e1c4abfd309cc15719b7e2580887f570", "Radio Caca", "1"],
  [56, "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "Ethereum Token", "1"],
  [56, "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", "PancakeSwap Token", "1"],
  [56, "0x111111111117dc0aa78b770fa6a738034120c302", "1INCH Token", "1"],
  [137, "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "Wrapped Matic", null],
  [137, "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "Wrapped Ether", "1"],
  [137, "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", "Wrapped BTC", "1"],
  [137, "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "Tether USD", "1"],
  [137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USD Coin", "2"],
  [137, "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4", "stMATIC", "1"],
  [137, "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683", "Aave Token", "1"],
  [137, "0xB5C064F955D8e7F38fE0460C556a72987494eE17", "Quickswap", "1"],
  [137, "0x0000000000000000000000000000000000001010", null, null],
  [137, "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", "ChainLink Token", "1"],
  [137, "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", "Dai Stablecoin", "1"],
  [137, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "USD Coin", "2"],
  [137, "0x28424507fefb6f7f8e9d3860f56504e4e5f5f390", "Quickswap", "1"],
  [137, "0x27f8d03b3a2196956ed754badc28d73be8830a6e", "Dai Stablecoin", "1"],
  [250, "0x6626c47c00f1d87902fc13eecfac3ed06d5e8d8a", "Geist Finance", "1"],
  [250, "0xfb98b335551a418cd0737375a2ea0ded62ea213b", "Beefy", "1"],
  [8453, "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", "USD Base", "1"],
  [8453, "0x4200000000000000000000000000000000000006", null, null],
  [8453, "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "USDbC", "1"],
  [8453, "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", "Aerodrome", "1"],
  [8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2"],
  [8453, "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", "Token", "1"],
  [8453, "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "Degen", "1"],
  [8453, "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "Alien Base", "1"],
  [8453, "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "Degen Base", "1"],
  [8453, "0x532f27101965dd16442E59d40670FaF5eBB142E4", "Eth", "1"],
  [8453, "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "Aero", "1"],
  [42161, "0x912ce59144191c1204e64559fe8253a0e49e6548", "Arbitrum", "1"],
  [42161, "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "USD Coin", "2"],
  [42161, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", "Dai Stablecoin", "1"],
  [42161, "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", "GMX", "1"],
  [42161, "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", "ChainLink Token", "1"],
  [42161, "0x3082CC23568eA640225c2467653dB90e9250AaA0", "Radiant", "1"],
  [42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USD Coin", "2"],
  [42161, "0x6491c05A82219b8D1479057361ff1654749b876b", "Gains Network", "1"],
  [42161, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "Tether USD", "1"],
  [42161, "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "Wrapped BTC", "1"],
  [42161, "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "Wrapped Ether", "1"],
  [42161, "0x9cfB13E6c11054ac9fcB92BA89644F30775436e4", "Wrapped stETH", "1"],
  [43114, "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", "USD Coin", "2"],
  [43114, "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd", "Aave Token", "1"],
  [43114, "0x5947BB275c521040051D82396192181b413227A3", "ChainLink Token", "1"],
  [43114, "0x60781c2586d68229fde47564546784ab3faca982", "Pangolin", "1"],
  [43114, "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE", "StargateToken", "1"],
  [43114, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USD Coin", "2"],
  [43114, "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "Tether USD", "1"],
  [43114, "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "Wrapped AVAX", null],
  [43114, "0x152b9d0FdC40C096757F570A51E494bd4b943E50", "ChainLink Token", "1"],
  [43114, "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", "Wrapped Ether", "1"],
  [43114, "0x488f73cddda1de3664775ffd91623637383d6404", "Yearn", "1"],
  [59144, "0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F", "Wrapped liquid staked Ether 2.0", "1"],
  [59144, "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", "Wrapped Ether", "1"],
  [59144, "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4", "StargateToken", "1"],
  [59144, "0xA219439258ca9da29E9Cc4cE5596924745e12B93", "USD Coin", "2"],
  [59144, "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "Tether USD", "1"],
  [59144, "0xEB466342C4d449BC9f53A865D5Cb90586f405215", "StargateToken", "1"],
  [59144, "0xc7346783f5e645aa998b106ef9e7f499528673d8", "Aave Token", "1"],
  [59144, "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5", "StargateToken", "1"],
];

// Build lookup: "chainId:lowercaseAddress" -> { name, version }
const lookup = new Map();
for (const entry of DATA) {
  const [chainId, address, name, version] = entry;
  if (name === null && version === null) continue;
  lookup.set(`${chainId}:${address.toLowerCase()}`, { name, version });
}

function main() {
  console.log(`\n=== fix-eip712-domains (apply data) ===`);
  if (DRY_RUN) console.log("  (dry-run mode)\n");

  const files = fs.readdirSync(PERMIT_DIR)
    .filter((f) => f.startsWith("eip712-permit-") && f.endsWith(".json"))
    .sort();

  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const filename of files) {
    const filePath = path.join(PERMIT_DIR, filename);
    const raw = fs.readFileSync(filePath, "utf-8");
    let data;
    try { data = JSON.parse(raw); } catch { console.log(`  SKIP ${filename}: invalid JSON`); continue; }

    const deployments = data.context?.eip712?.deployments;
    if (!Array.isArray(deployments) || deployments.length === 0) {
      skipped++;
      continue;
    }

    const { chainId, address } = deployments[0];
    const key = `${chainId}:${address.toLowerCase()}`;
    const entry = lookup.get(key);

    if (!entry) {
      noMatch++;
      continue;
    }

    const domain = data.context.eip712.domain || {};
    let changed = false;
    const changes = [];

    if (entry.name !== null && domain.name !== entry.name) {
      changes.push(`name: "${domain.name}" -> "${entry.name}"`);
      domain.name = entry.name;
      changed = true;
    }

    if (entry.version !== null && domain.version !== entry.version) {
      if (domain.version) {
        changes.push(`version: "${domain.version}" -> "${entry.version}"`);
      } else {
        changes.push(`version: (none) -> "${entry.version}"`);
      }
      domain.version = entry.version;
      changed = true;
    }

    if (!changed) {
      skipped++;
      continue;
    }

    data.context.eip712.domain = domain;

    if (!DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    }

    console.log(`  ${filename}`);
    for (const c of changes) console.log(`    - ${c}`);
    updated++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped} (no change needed or all-null)`);
  console.log(`  No match: ${noMatch} (not in data array)`);
  console.log("");
}

main();
