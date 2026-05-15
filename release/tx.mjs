import fs from "node:fs";
import path from "node:path";
import { CID } from "multiformats/cid";
import {
  concat,
  createPublicClient,
  encodeFunctionData,
  hashTypedData,
  http as viemHttp,
  isAddressEqual,
  keccak256,
  namehash,
  numberToHex,
  toBytes,
  toHex,
} from "viem";
import { mainnet } from "viem/chains";
import {
  ENS_REGISTRY_ABI,
  RESOLVER_ABI,
  SAFE_ABI,
  SAFE_TX_TYPES,
} from "./abi.mjs";

const HERE = import.meta.dirname;
const TX_DATA = path.join(HERE, "tx-data");

const ENS_NAME = "erc7730.eth";
const SAFE_ADDRESS = "0x08f6323fA771067239c1fFD740C59e5679322496";
const CHAIN_ID = 1;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

function loadEnv() {
  const env = {};
  const envPath = path.join(HERE, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
  }
  return { ...env, ...process.env };
}

// IPFS CIDv1 → EIP-1577 contenthash (0xe301 prefix is the IPFS codec).
function cidToContenthash(cidString) {
  const v1 = CID.parse(cidString).toV1();
  return toHex(new Uint8Array([0xe3, 0x01, ...v1.bytes]));
}

// ERC-8213: keccak256( uint256(len(calldata)) ‖ calldata )
function calldataDigest(calldataHex) {
  const bytes = toBytes(calldataHex);
  const lenWord = numberToHex(bytes.length, { size: 32 });
  return keccak256(concat([toBytes(lenWord), bytes]));
}

// Safe TX Builder batch checksum (matches safe-react-apps tx-builder).
const stringifyReplacer = (_, value) => (value === undefined ? null : value);

function serializeJsonObject(json) {
  if (Array.isArray(json)) {
    return `[${json.map(serializeJsonObject).join(",")}]`;
  }
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, stringifyReplacer)}`;
    for (const k of keys) {
      acc += `${serializeJsonObject(json[k])},`;
    }
    return `${acc}}`;
  }
  return JSON.stringify(json, stringifyReplacer);
}

function safeBatchChecksum(batchFile) {
  const stripped = { ...batchFile, meta: { ...batchFile.meta, name: null } };
  return keccak256(toBytes(serializeJsonObject(stripped)));
}

async function readEnsState(client, name) {
  const node = namehash(name);
  const [owner, resolver] = await Promise.all([
    client.readContract({
      address: ENS_REGISTRY,
      abi: ENS_REGISTRY_ABI,
      functionName: "owner",
      args: [node],
    }),
    client.getEnsResolver({ name }),
  ]);
  return { node, owner, resolver };
}

async function readSafeState(client, address) {
  const [nonce, threshold, owners] = await Promise.all([
    client.readContract({ address, abi: SAFE_ABI, functionName: "nonce" }),
    client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }),
    client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }),
  ]);
  return { nonce, threshold: Number(threshold), owners };
}

function buildSafeBatch({ resolver, node, contenthash, cid }) {
  const transactions = [
    {
      to: resolver,
      value: "0",
      data: null,
      contractMethod: {
        inputs: [
          { internalType: "bytes32", name: "node", type: "bytes32" },
          { internalType: "bytes", name: "hash", type: "bytes" },
        ],
        name: "setContenthash",
        payable: false,
      },
      contractInputsValues: { node, hash: contenthash },
    },
  ];

  const batchFile = {
    version: "1.0",
    chainId: String(CHAIN_ID),
    createdAt: Date.now(),
    meta: {
      name: `erc7730.eth contenthash → ${cid}`,
      description: `Set the contenthash for erc7730.eth to IPFS CID ${cid}.`,
      txBuilderVersion: "1.18.0",
      createdFromSafeAddress: SAFE_ADDRESS,
      createdFromOwnerAddress: "",
      checksum: "",
    },
    transactions,
  };

  batchFile.meta.checksum = safeBatchChecksum(batchFile);
  return batchFile;
}

function buildLocalsafeTx({ resolver, calldata, nonce }) {
  return {
    tx: {
      data: {
        to: resolver,
        value: "0",
        data: calldata,
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: ZERO_ADDR,
        refundReceiver: ZERO_ADDR,
        nonce: Number(nonce),
      },
      signatures: [],
    },
  };
}

function localsafeUrl(localsafeTx) {
  const json = JSON.stringify(localsafeTx);
  const b64 = Buffer.from(json, "utf-8").toString("base64");
  const encoded = encodeURIComponent(b64);
  return `https://localsafe.eth.limo/#/safe/${SAFE_ADDRESS}?importTx=${encoded}&chainId=${CHAIN_ID}`;
}

function safeBuilderUrl() {
  return `https://app.safe.global/apps/open?safe=eth:${SAFE_ADDRESS}&appUrl=${encodeURIComponent(
    "https://apps-portal.safe.global/tx-builder",
  )}`;
}

function renderSummary(ctx) {
  const lines = [
    "ERC-7730 registry — release transaction summary",
    "=================================================",
    "",
    `CID:           ${ctx.cid}`,
    `Contenthash:   ${ctx.contenthash}`,
    "",
    `ENS name:      ${ENS_NAME}`,
    `ENS namehash:  ${ctx.node}`,
    `ENS owner:     ${ctx.ensOwner}${ctx.ensOwnerMatches ? " (matches Safe)" : " — does NOT match Safe"}`,
    `Resolver:      ${ctx.resolver}`,
    "",
    "Transaction:",
    `  to:          ${ctx.resolver}`,
    "  value:       0",
    "  operation:   0 (CALL)",
    `  data:        ${ctx.calldata}`,
    "",
    "  Function: setContenthash(bytes32 node, bytes hash)",
    `    param 0 (node):  ${ctx.node}`,
    `                     (namehash of ${ENS_NAME})`,
    `    param 1 (hash):  ${ctx.contenthash}`,
    `                     (IPFS contenthash for CID ${ctx.cid})`,
    "",
    `Safe:          ${SAFE_ADDRESS}`,
    `  chain:       ${CHAIN_ID} (mainnet)`,
    `  nonce:       ${ctx.safeState.nonce}`,
    `  threshold:   ${ctx.safeState.threshold} of ${ctx.safeState.owners.length}`,
    "  owners:",
    ...ctx.safeState.owners.map((o) => `    - ${o}`),
    "",
    "Verification digests (https://erc8213.eth.limo/):",
    `  ERC-8213 calldata digest:  ${ctx.cdDigest}`,
    `  EIP-712 safeTxHash:        ${ctx.safeTxHash}`,
    "",
  ];
  return lines.join("\n");
}

async function tx() {
  const env = loadEnv();

  if (!env.MAINNET_RPC_URL) {
    console.error("MAINNET_RPC_URL not set in release/.env");
    console.error(
      "Add a mainnet RPC URL (Alchemy, Infura, llamarpc, etc.) and try again.",
    );
    process.exit(1);
  }

  const cidPath = path.join(HERE, ".cid");
  if (!fs.existsSync(cidPath)) {
    console.error(".cid not found. Run `pnpm pin` first.");
    process.exit(1);
  }
  const cid = fs.readFileSync(cidPath, "utf-8").trim();

  const client = createPublicClient({
    chain: mainnet,
    transport: viemHttp(env.MAINNET_RPC_URL),
  });

  console.log(`CID:           ${cid}`);
  const contenthash = cidToContenthash(cid);
  console.log(`Contenthash:   ${contenthash}`);

  console.log(`\nReading ENS state for ${ENS_NAME}...`);
  const ens = await readEnsState(client, ENS_NAME);
  const ensOwnerMatches = isAddressEqual(ens.owner, SAFE_ADDRESS);
  console.log(`  namehash:    ${ens.node}`);
  console.log(`  owner:       ${ens.owner}${ensOwnerMatches ? " ✓" : ""}`);
  console.log(`  resolver:    ${ens.resolver}`);

  if (!ensOwnerMatches) {
    console.log(
      `\n  ⚠ ${ENS_NAME} is not yet owned by the Safe ${SAFE_ADDRESS}.`,
    );
    console.log(
      "    The Safe cannot execute setContenthash until ownership is transferred.",
    );
    console.log(
      `    Transfer via the ENS app: https://app.ens.domains/${ENS_NAME}`,
    );
  }

  console.log(`\nReading Safe state for ${SAFE_ADDRESS}...`);
  const safeState = await readSafeState(client, SAFE_ADDRESS);
  console.log(`  nonce:       ${safeState.nonce}`);
  console.log(
    `  threshold:   ${safeState.threshold} of ${safeState.owners.length}`,
  );

  const calldata = encodeFunctionData({
    abi: RESOLVER_ABI,
    functionName: "setContenthash",
    args: [ens.node, contenthash],
  });

  const cdDigest = calldataDigest(calldata);

  const safeTxHash = hashTypedData({
    domain: { chainId: CHAIN_ID, verifyingContract: SAFE_ADDRESS },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: {
      to: ens.resolver,
      value: 0n,
      data: calldata,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDR,
      refundReceiver: ZERO_ADDR,
      nonce: BigInt(safeState.nonce),
    },
  });

  const batchFile = buildSafeBatch({
    resolver: ens.resolver,
    node: ens.node,
    contenthash,
    cid,
  });
  const localsafeTx = buildLocalsafeTx({
    resolver: ens.resolver,
    calldata,
    nonce: safeState.nonce,
  });

  fs.mkdirSync(TX_DATA, { recursive: true });
  const batchPath = path.join(TX_DATA, "safe-batch.json");
  const localsafePath = path.join(TX_DATA, "localsafe-tx.json");
  const summaryPath = path.join(TX_DATA, "tx-summary.txt");

  fs.writeFileSync(batchPath, `${JSON.stringify(batchFile, null, 2)}\n`);
  fs.writeFileSync(localsafePath, `${JSON.stringify(localsafeTx, null, 2)}\n`);

  const ctx = {
    cid,
    contenthash,
    ensOwner: ens.owner,
    ensOwnerMatches,
    resolver: ens.resolver,
    node: ens.node,
    calldata,
    cdDigest,
    safeTxHash,
    safeState,
  };
  fs.writeFileSync(summaryPath, renderSummary(ctx));

  console.log("\nWrote:");
  console.log(`  ${path.relative(HERE, batchPath)}      (Safe TX Builder)`);
  console.log(`  ${path.relative(HERE, localsafePath)}   (localsafe.eth)`);
  console.log(`  ${path.relative(HERE, summaryPath)}     (human-readable verification)`);

  console.log("\nFunction call (verify each on your hardware wallet):");
  console.log(`  setContenthash(bytes32 node, bytes hash)`);
  console.log(`  param 0 (node):  ${ens.node}`);
  console.log(`                   (namehash of ${ENS_NAME})`);
  console.log(`  param 1 (hash):  ${contenthash}`);
  console.log(`                   (IPFS contenthash for CID ${cid})`);

  console.log("\nVerification digests (https://erc8213.eth.limo/):");
  console.log(`  ERC-8213 calldata digest:  ${cdDigest}`);
  console.log(`  EIP-712 safeTxHash:        ${safeTxHash}`);

  console.log("\nDecode the calldata:");
  console.log(`  https://tools.cyfrin.io/abi-encoding?data=${calldata}`);

  console.log("\nSubmit via Safe TX Builder (load release/tx-data/safe-batch.json):");
  console.log(`  ${safeBuilderUrl()}`);

  console.log("\n…or via localsafe.eth (click to open with the tx pre-filled):");
  console.log(`  ${localsafeUrl(localsafeTx)}`);

  console.log(
    "\nAfter the Safe transaction executes on-chain, run `pnpm release:publish` to cut a GitHub release.",
  );

  return ctx;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  tx().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { tx };
