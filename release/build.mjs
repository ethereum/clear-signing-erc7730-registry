import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(HERE, "dist");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countFiles(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      n++;
    }
  }
  return n;
}

function dirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += dirSize(full);
    } else if (entry.isFile()) {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

function gitInfo() {
  const run = (cmd) =>
    execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();

  const commit = run("git rev-parse HEAD");
  const shortCommit = commit.slice(0, 7);
  // Commit timestamp (ISO 8601). Using this instead of build wall-clock time
  // means the same commit always produces the same dist/, and therefore the
  // same CID — anyone can rebuild and verify.
  const committedAt = run("git log -1 --format=%cI HEAD");

  let tag = null;
  try {
    tag = run("git describe --tags --exact-match");
  } catch {
    // no tag at HEAD
  }

  let branch = null;
  try {
    branch = run("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") branch = null;
  } catch {
    // detached
  }

  let dirty = false;
  try {
    dirty = run("git status --porcelain").length > 0;
  } catch {
    // not a git repo
  }

  return { commit, shortCommit, committedAt, tag, branch, dirty };
}

function countDescriptors(registryDir) {
  const counts = {
    entities: 0,
    calldata: 0,
    eip712: 0,
    common: 0,
    tests: 0,
  };
  for (const entity of fs.readdirSync(registryDir, { withFileTypes: true })) {
    if (!entity.isDirectory()) continue;
    counts.entities++;
    const entityDir = path.join(registryDir, entity.name);
    for (const f of fs.readdirSync(entityDir, { withFileTypes: true })) {
      if (f.isDirectory() && f.name === "tests") {
        const testFiles = fs
          .readdirSync(path.join(entityDir, "tests"))
          .filter((name) => name.endsWith(".json"));
        counts.tests += testFiles.length;
        continue;
      }
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      if (f.name.startsWith("calldata-")) counts.calldata++;
      else if (f.name.startsWith("eip712-")) counts.eip712++;
      else counts.common++;
    }
  }
  return counts;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIndexHtml(manifest) {
  const shortCommit = escapeHtml(manifest.git.shortCommit);
  const fullCommit = escapeHtml(manifest.git.commit);
  const tag = manifest.git.tag
    ? `, tag <code>${escapeHtml(manifest.git.tag)}</code>`
    : "";
  const dirty = manifest.git.dirty
    ? ' <span style="color:#c94444">(uncommitted changes)</span>'
    : "";
  const committedAt = escapeHtml(manifest.git.committedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ERC-7730 Clear Signing Registry</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #222; }
    h1 { font-size: 1.5rem; margin-bottom: 0.3rem; }
    h2 { font-size: 1.05rem; margin-top: 2rem; margin-bottom: 0.5rem; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    code { background: #f4f4f4; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.88em; }
    table { border-collapse: collapse; margin: 0.5rem 0; }
    td { padding: 0.25rem 1rem 0.25rem 0; vertical-align: top; }
    td:first-child { color: #666; }
    ul { padding-left: 1.2rem; }
    li { margin: 0.25rem 0; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>ERC-7730 Clear Signing Registry</h1>
  <p class="meta">
    A pinned snapshot of <a href="https://github.com/ethereum/clear-signing-erc7730-registry">github.com/ethereum/clear-signing-erc7730-registry</a>
    at commit <a href="https://github.com/ethereum/clear-signing-erc7730-registry/commit/${fullCommit}"><code>${shortCommit}</code></a>${tag}${dirty},
    committed ${committedAt}.
  </p>

  <h2>Stats</h2>
  <table>
    <tr><td>Entities</td><td>${manifest.counts.entities}</td></tr>
    <tr><td>Calldata descriptors</td><td>${manifest.counts.calldata}</td></tr>
    <tr><td>EIP-712 descriptors</td><td>${manifest.counts.eip712}</td></tr>
    <tr><td>Common definitions</td><td>${manifest.counts.common}</td></tr>
    <tr><td>Test files</td><td>${manifest.counts.tests}</td></tr>
  </table>

  <h2>Wallet entry points</h2>
  <ul>
    <li><a href="index.calldata.json"><code>index.calldata.json</code></a> — lookup by <code>eip155:&lt;chain&gt;:&lt;address&gt;</code></li>
    <li><a href="index.eip712.json"><code>index.eip712.json</code></a> — lookup by EIP-712 domain + primary type</li>
  </ul>

  <h2>Files</h2>
  <ul>
    <li><a href="registry/"><code>registry/</code></a> — descriptor files by entity</li>
    <li><a href="ercs/"><code>ercs/</code></a> — standard ERC token files</li>
    <li><a href="specs/erc7730-v2.schema.json"><code>specs/erc7730-v2.schema.json</code></a> — JSON schema (v2)</li>
    <li><a href="manifest.json"><code>manifest.json</code></a> — build metadata</li>
  </ul>

  <h2>Learn more</h2>
  <ul>
    <li><a href="https://clearsigning.org">clearsigning.org</a> — standard overview</li>
    <li><a href="https://github.com/ethereum/clear-signing-erc7730-registry">GitHub</a> — source repository</li>
  </ul>
</body>
</html>
`;
}

function bytesToHuman(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function build({ force = false } = {}) {
  const git = gitInfo();

  if (git.dirty && !force) {
    console.error("✗ Working tree has uncommitted changes.");
    console.error(
      "  Release builds must come from a clean checkout — the manifest",
    );
    console.error(
      "  embeds the commit, so uncommitted changes break verifiability.",
    );
    console.error("  Commit (or stash) your changes, or pass --force to override.");
    process.exit(1);
  }

  console.log("Building dist/...");

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  console.log("  registry/");
  copyDir(path.join(ROOT, "registry"), path.join(DIST, "registry"));

  console.log("  ercs/");
  copyDir(path.join(ROOT, "ercs"), path.join(DIST, "ercs"));

  console.log("  specs/erc7730-v2.schema.json");
  fs.mkdirSync(path.join(DIST, "specs"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "specs/erc7730-v2.schema.json"),
    path.join(DIST, "specs/erc7730-v2.schema.json"),
  );

  console.log("  index.calldata.json + index.eip712.json");
  fs.copyFileSync(
    path.join(ROOT, "index.calldata.json"),
    path.join(DIST, "index.calldata.json"),
  );
  fs.copyFileSync(
    path.join(ROOT, "index.eip712.json"),
    path.join(DIST, "index.eip712.json"),
  );

  const counts = countDescriptors(path.join(DIST, "registry"));
  const manifest = {
    name: "ERC-7730 Clear Signing Registry",
    schemaVersion: "v2",
    builtAt: git.committedAt,
    git,
    counts: {
      ...counts,
      total: counts.calldata + counts.eip712 + counts.common,
    },
  };

  console.log("  manifest.json");
  fs.writeFileSync(
    path.join(DIST, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log("  index.html");
  fs.writeFileSync(path.join(DIST, "index.html"), renderIndexHtml(manifest));

  const totalFiles = countFiles(DIST);
  const totalSize = dirSize(DIST);
  console.log(
    `  done: ${totalFiles} files, ${bytesToHuman(totalSize)} at commit ${git.shortCommit}${git.dirty ? " (dirty)" : ""}`,
  );

  return { manifest, totalFiles, totalSize };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  build({ force });
}

export { build };
