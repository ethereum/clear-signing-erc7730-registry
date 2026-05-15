import fs from "node:fs";
import path from "node:path";
import { MemoryBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";

const HERE = import.meta.dirname;
const DIST = path.join(HERE, "dist");

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

function collectFiles(dir, prefix = "") {
  const files = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else if (entry.isFile()) {
      files.push({ path: rel, content: fs.readFileSync(full) });
    }
  }
  return files;
}

async function computeLocalCid(files) {
  const blockstore = new MemoryBlockstore();
  let rootCid;
  for await (const entry of importer(files, blockstore, {
    cidVersion: 1,
    wrapWithDirectory: true,
  })) {
    rootCid = entry.cid;
  }
  return rootCid.toString();
}

async function pinToPinata(files, jwt) {
  const formData = new FormData();
  for (const f of files) {
    formData.append("file", new Blob([f.content]), f.path);
  }
  formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  formData.append(
    "pinataMetadata",
    JSON.stringify({
      name: `erc7730-registry-${new Date().toISOString().slice(0, 10)}`,
    }),
  );

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(
      `Pinata upload failed (${res.status}): ${await res.text()}`,
    );
  }

  const data = await res.json();
  return data.IpfsHash;
}

function bytesToHuman(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function pin() {
  if (!fs.existsSync(DIST)) {
    console.error("dist/ not found. Run `npm run build` first.");
    process.exit(1);
  }

  const env = loadEnv();

  console.log("Collecting files from dist/...");
  const files = collectFiles(DIST);
  const totalBytes = files.reduce((n, f) => n + f.content.length, 0);
  console.log(`  ${files.length} files, ${bytesToHuman(totalBytes)}`);

  console.log("\nComputing local CID...");
  const localCid = await computeLocalCid(files);
  console.log(`  ${localCid}`);

  let pinataCid = null;
  if (env.PINATA_JWT) {
    console.log("\nPinning to Pinata...");
    pinataCid = await pinToPinata(files, env.PINATA_JWT);
    console.log(`  ${pinataCid}`);
    if (pinataCid !== localCid) {
      console.error("\n  ✗ CID MISMATCH");
      console.error(`    Local:  ${localCid}`);
      console.error(`    Pinata: ${pinataCid}`);
      console.error(
        "\n  The CID set in ENS would not match what Pinata is hosting. Investigate before publishing.",
      );
      process.exit(1);
    }
    console.log("  ✓ CIDs match");
  } else {
    console.log("\nPINATA_JWT not set in .env. Skipping Pinata mirror.");
    console.log("  (Set PINATA_JWT to also pin to Pinata's public service.)");
  }

  console.log("\nTo pin on your own Kubo node:");
  console.log("  ipfs add -r release/dist/");
  console.log(`  expected CID: ${localCid}`);

  fs.writeFileSync(path.join(HERE, ".cid"), `${localCid}\n`);

  return { cid: localCid, pinataCid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pin().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { pin };
