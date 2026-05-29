import { createPublicClient, http as viemHttp, namehash } from "viem";
import { mainnet } from "viem/chains";
import { RESOLVER_ABI } from "./abi.mjs";
import { loadEnv } from "./env.mjs";
import { contenthashToCid } from "./lib.mjs";

const ENS_NAME = "erc7730.eth";

async function main() {
  const env = loadEnv();
  if (!env.MAINNET_RPC_URL) {
    console.error("MAINNET_RPC_URL not set in release/.env");
    process.exit(1);
  }

  const client = createPublicClient({
    chain: mainnet,
    transport: viemHttp(env.MAINNET_RPC_URL),
  });

  const node = namehash(ENS_NAME);
  const resolver = await client.getEnsResolver({ name: ENS_NAME });
  const contenthashHex = await client.readContract({
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: "contenthash",
    args: [node],
  });

  const cid = contenthashToCid(contenthashHex);
  if (!cid) {
    console.error("On-chain contenthash is not an IPFS CID:", contenthashHex);
    process.exit(1);
  }

  console.log(cid);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
