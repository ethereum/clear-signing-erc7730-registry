import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  http as viemHttp,
  isAddressEqual,
  namehash,
} from "viem";
import { mainnet } from "viem/chains";
import { ENS_REGISTRY_ABI, RESOLVER_ABI } from "./abi.mjs";
import { loadEnv } from "./env.mjs";
import { contenthashToCid } from "./lib.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(HERE, "dist");

const ENS_NAME = "erc7730.eth";
const SAFE_ADDRESS = "0x08f6323fA771067239c1fFD740C59e5679322496";
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const GH_REPO = "ethereum/clear-signing-erc7730-registry";

function ensureGhCli() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.error(
      "gh CLI not authenticated. Run `gh auth login` (or install gh from https://cli.github.com/) and retry.",
    );
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = { tag: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag" && argv[i + 1]) {
      args.tag = argv[i + 1];
      i++;
    }
  }
  return args;
}

function defaultTag(manifest) {
  return `v${manifest.builtAt.slice(0, 10)}-${manifest.git.shortCommit}`;
}

function renderReleaseNotes({ cid, contenthashHex, resolver, manifest }) {
  return [
    "## ERC-7730 Registry Snapshot",
    "",
    `**IPFS CID:** \`${cid}\``,
    "",
    `Pinned to IPFS and resolved via ENS at [erc7730.eth.limo](https://erc7730.eth.limo/).`,
    "",
    "### Build",
    "",
    `- Commit: [\`${manifest.git.shortCommit}\`](https://github.com/${GH_REPO}/commit/${manifest.git.commit})`,
    `- Built: \`${manifest.builtAt}\``,
    `- Schema: \`${manifest.schemaVersion}\``,
    "",
    "### Contents",
    "",
    `- ${manifest.counts.entities} entities`,
    `- ${manifest.counts.calldata} calldata descriptors`,
    `- ${manifest.counts.eip712} EIP-712 descriptors`,
    `- ${manifest.counts.common} common definitions`,
    `- ${manifest.counts.tests} test files`,
    "",
    "### On-chain",
    "",
    `- Contenthash: \`${contenthashHex}\``,
    `- Safe: [\`${SAFE_ADDRESS}\`](https://etherscan.io/address/${SAFE_ADDRESS})`,
    `- Resolver: [\`${resolver}\`](https://etherscan.io/address/${resolver}#events)`,
    "",
    "### Browse",
    "",
    `- [\`erc7730.eth.limo\`](https://erc7730.eth.limo/)`,
    `- [\`ipfs.io/ipfs/${cid}\`](https://ipfs.io/ipfs/${cid}/)`,
    `- [\`cf-ipfs.com/ipfs/${cid}\`](https://cf-ipfs.com/ipfs/${cid}/)`,
    "",
    "### Verify",
    "",
    "```",
    "ipfs add -rn release/dist/",
    `# expected CID: ${cid}`,
    "```",
    "",
  ].join("\n");
}

async function publish() {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!env.MAINNET_RPC_URL) {
    console.error("MAINNET_RPC_URL not set in release/.env");
    process.exit(1);
  }

  const cidPath = path.join(HERE, ".cid");
  if (!fs.existsSync(cidPath)) {
    console.error(".cid not found. Run `pnpm release` (build + pin) first.");
    process.exit(1);
  }
  const expectedCid = fs.readFileSync(cidPath, "utf-8").trim();

  const manifestPath = path.join(DIST, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("dist/manifest.json not found. Run `pnpm build` first.");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  ensureGhCli();

  const client = createPublicClient({
    chain: mainnet,
    transport: viemHttp(env.MAINNET_RPC_URL),
  });

  console.log(`Expected CID: ${expectedCid}`);

  const node = namehash(ENS_NAME);
  console.log(`\nReading on-chain state for ${ENS_NAME}...`);

  const [owner, resolver] = await Promise.all([
    client.readContract({
      address: ENS_REGISTRY,
      abi: ENS_REGISTRY_ABI,
      functionName: "owner",
      args: [node],
    }),
    client.getEnsResolver({ name: ENS_NAME }),
  ]);
  console.log(`  Owner:       ${owner}`);
  console.log(`  Resolver:    ${resolver}`);

  if (!isAddressEqual(owner, SAFE_ADDRESS)) {
    console.error(
      `\n  ⚠ ENS owner (${owner}) is not the expected Safe (${SAFE_ADDRESS}).`,
    );
    console.error(
      "    Refusing to publish a release for an unexpected configuration.",
    );
    process.exit(1);
  }

  const contenthashHex = await client.readContract({
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: "contenthash",
    args: [node],
  });
  console.log(`  Contenthash: ${contenthashHex}`);

  const onChainCid = contenthashToCid(contenthashHex);
  console.log(`  Decoded CID: ${onChainCid ?? "(not an IPFS contenthash)"}`);

  if (onChainCid !== expectedCid) {
    console.error("\n  ✗ On-chain CID does not match the local build.");
    console.error(`    Expected: ${expectedCid}`);
    console.error(`    On-chain: ${onChainCid ?? contenthashHex}`);
    console.error(
      "\n    Run after the Safe transaction executes, or rebuild if the registry has changed.",
    );
    process.exit(1);
  }
  console.log("  ✓ On-chain CID matches the local build.");

  const tag = args.tag || defaultTag(manifest);
  const title = `Registry snapshot ${manifest.builtAt.slice(0, 10)}`;
  const notes = renderReleaseNotes({
    cid: expectedCid,
    contenthashHex,
    resolver,
    manifest,
  });

  console.log("\nRelease preview:");
  console.log(`  Tag:    ${tag}`);
  console.log(`  Title:  ${title}`);
  console.log(`  Target: ${manifest.git.commit}`);
  console.log(`  Repo:   ${GH_REPO}`);
  console.log("\n--- notes ---");
  console.log(notes);
  console.log("--- end notes ---\n");

  const notesPath = path.join(os.tmpdir(), `erc7730-release-notes-${Date.now()}.md`);
  fs.writeFileSync(notesPath, notes);

  console.log("Creating GitHub release (draft)...");
  try {
    const out = execFileSync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--repo",
        GH_REPO,
        "--target",
        manifest.git.commit,
        "--title",
        title,
        "--notes-file",
        notesPath,
        "--draft",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(out.toString().trim());
  } catch (err) {
    console.error("gh release create failed:");
    console.error(err.stderr?.toString() || err.message);
    process.exit(1);
  } finally {
    fs.unlinkSync(notesPath);
  }

  console.log(
    "\nReview the draft on GitHub, then click 'Publish release' to make it public.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publish().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { publish };
