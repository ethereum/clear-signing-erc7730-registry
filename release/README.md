# Release

Pins the [ERC-7730 registry](https://github.com/ethereum/clear-signing-erc7730-registry) to IPFS and updates the `erc7730.eth` ENS contenthash via the Safe at [`0x08f6...2496`](https://etherscan.io/address/0x08f6323fA771067239c1fFD740C59e5679322496).

## Setup

```bash
cd release
pnpm install
cp .env.example .env
# fill in MAINNET_RPC_URL (required) and PINATA_JWT (optional)
```

`pnpm` is required because `.npmrc` enforces a 7-day minimum release age on every dependency. npm doesn't honour this setting.

## How to cut a release

> Pre-requisite: you are a signer on the `erc7730.eth` Safe (or coordinating with signers), and your working tree is on the commit you intend to release from. Releases must come from a **clean** checkout — `build.mjs` refuses to run with uncommitted changes.

### 1. Build and propose the transaction

```bash
pnpm release
```

This runs three steps:

1. **Build** — assembles `dist/` from `registry/`, `ercs/`, the v2 schema, and the calldata/eip712 indexes. Embeds the commit hash and commit timestamp into `manifest.json` and `index.html`. **Same commit always produces the same CID**, so anyone can rebuild and verify.
2. **Pin** — computes the IPFS CID locally (via `ipfs-unixfs-importer`) and mirrors to Pinata if `PINATA_JWT` is set. Fails if Pinata's returned CID doesn't match the local one.
3. **Transaction** — reads ENS owner + Safe state from mainnet, encodes `setContenthash(...)` calldata, computes the EIP-712 `safeTxHash` and cross-checks it against `Safe.getTransactionHash()` on-chain. Writes three files to `tx-data/`.

### 2. Submit the transaction to the Safe

The script prints two options at the end:

- **Safe TX Builder** — open the printed URL, click "Load batch", upload `tx-data/safe-batch.json`.
- **localsafe.eth** — click the printed URL directly; the transaction is pre-filled via the URL fragment.

### 3. Each signer verifies on their hardware wallet

The script prints these values for cross-check against what the wallet displays:

| Value | What to check |
|---|---|
| `to` | the ENS PublicResolver address |
| `param 0 (node)` | the namehash of `erc7730.eth` |
| `param 1 (hash)` | the contenthash: starts with `0xe301` (IPFS), the rest is the CID bytes |
| `EIP-712 safeTxHash` | the digest the wallet asks you to sign |
| `ERC-8213 calldata digest` | independent fingerprint of the calldata, verifiable at [erc8213.eth.limo](https://erc8213.eth.limo/) |

The Safe contract itself computed the same `safeTxHash` via `Safe.getTransactionHash()` — the script already verified this at generate time.

### 4. Execute on-chain

Once `threshold` signers have signed, any signer can execute. Wait for the transaction to confirm.

### 5. Cut the GitHub release

```bash
pnpm release:publish
```

This:

1. Reads the on-chain contenthash from the resolver and decodes it
2. Verifies it matches the CID in `manifest.json` (refuses if not)
3. Creates a **draft** GitHub release at `v<date>-<short-commit>` with notes containing the CID, contenthash, Safe + resolver Etherscan links, and IPFS gateway URLs

Review the draft on github.com and click "Publish release" when satisfied.

## Files

### `dist/` (gitignored — this is what gets pinned to IPFS)

| | |
|---|---|
| `index.html` | minimal browsing page for `erc7730.eth.limo` |
| `index.calldata.json`, `index.eip712.json` | wallet entry points |
| `manifest.json` | commit + counts + schema version |
| `registry/` | all descriptors |
| `ercs/` | standard token files |
| `specs/erc7730-v2.schema.json` | JSON schema |

### `tx-data/` (gitignored — release metadata, **not** on IPFS)

| | |
|---|---|
| `safe-batch.json` | Safe TX Builder format |
| `localsafe-tx.json` | localsafe.eth format |
| `tx-summary.txt` | human-readable summary for hardware-wallet verification |

## Individual commands

```bash
pnpm build           # just build dist/
pnpm pin             # just pin (requires dist/)
pnpm tx              # just compute the Safe transaction (requires dist/ + .cid)
pnpm release         # build + pin + tx
pnpm release:publish # post-on-chain: create GitHub release
pnpm test            # unit tests for crypto/encoding helpers

pnpm build --force   # bypass the dirty-checkout guard (testing only)
```

## Verifying the CID independently

Anyone can rebuild from a tagged commit and confirm the CID:

```bash
git checkout <tag>
cd release
pnpm install
pnpm build
ipfs add -rn dist/      # requires Kubo
# CID should match the one in the GitHub release notes
```

## Troubleshooting

**`Working tree has uncommitted changes`** — commit (or stash) first. Releases must be reproducible from a single commit. Use `--force` only when iterating locally.

**`Pinata upload failed (401)`** — `PINATA_JWT` is invalid or expired. Generate a new JWT in the Pinata dashboard.

**`CID MISMATCH` between local and Pinata** — investigate before publishing. The contenthash set on-chain would not match what Pinata is hosting. This shouldn't happen with the pinned `ipfs-unixfs-importer` version.

**`ENS owner does not match Safe`** — `erc7730.eth` is owned by something other than the expected Safe (e.g. wrapped via NameWrapper, or transferred). Investigate before continuing.

**`safeTxHash mismatch`** — the Safe contract disagrees with our local EIP-712 computation. Likely a Safe-version mismatch — check `Safe.VERSION()` against `SAFE_TX_TYPES` in `abi.mjs`.

**`On-chain CID does not match the local build`** — the Safe transaction hasn't executed yet, or someone updated the contenthash to a different value. Rebuild if the registry has changed.
