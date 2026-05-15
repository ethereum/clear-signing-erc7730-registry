import { build } from "./build.mjs";
import { pin } from "./pin.mjs";
import { tx } from "./tx.mjs";

async function main() {
  console.log("=== ERC-7730 registry release ===\n");

  console.log("1. Build\n");
  build();

  console.log("\n2. Pin\n");
  await pin();

  console.log("\n3. Transaction\n");
  await tx();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
