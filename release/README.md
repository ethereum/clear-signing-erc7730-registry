# Release

Pins the registry to IPFS and produces the Safe transaction that updates the `erc7730.eth` contenthash.

## Setup

```bash
cd release
pnpm install
cp .env.example .env
# fill in PINATA_JWT (optional) and MAINNET_RPC_URL
```

`pnpm` is required because `.npmrc` enforces a 7-day minimum release age on every dependency (supply-chain mitigation). npm doesn't honour this setting.

## Usage

```bash
# Build dist/, compute CID, optionally mirror to Pinata
pnpm release

# Just build
pnpm build

# Just pin (requires dist/ to exist)
pnpm pin
```

## What `dist/` contains (this is what goes on IPFS)

- `index.html` — minimal browsing page for `erc7730.eth.limo`
- `index.calldata.json`, `index.eip712.json` — wallet entry points
- `manifest.json` — git commit + counts at build time
- `registry/` — all descriptors
- `ercs/` — standard token files
- `specs/erc7730-v2.schema.json` — JSON schema

## What `tx-data/` contains (release metadata, **not** on IPFS)

- `safe-batch.json` — load into [Safe TX Builder](https://app.safe.global/) to propose the contenthash update
- `localsafe-tx.json` — same transaction in [localsafe.eth](https://localsafe.eth.limo/) format
- `tx-summary.txt` — human-readable summary for hardware-wallet verification

## Verifying the CID locally

If you have [Kubo](https://docs.ipfs.tech/install/command-line/) installed:

```bash
ipfs add -rn dist/
```

Should output the same CID as `npm run pin`.
