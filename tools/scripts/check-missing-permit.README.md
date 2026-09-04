# Check missing permit descriptors

Detects ERC-7730 entities whose contracts expose a permit-style function (EIP-2612, Permit2) but have no matching descriptor in the registry.

Useful both as a contributor finding-tool ("which entities would benefit from a `eip712-*-permit.json` next?") and as a sanity check on new entities ("did the submitter forget to add a permit descriptor?").

## Phases

The script runs in two phases:

1. **Phase 1 (offline, default)** — walks `registry/*/` and reports entities where:
   - the entity has one or more `calldata-*.json` descriptors, **and**
   - no descriptor in the entity is permit-shaped, either by filename (`*permit*`) or by `display.formats` key (`permit(...)`, `permitSingle(...)`, etc.).
   - This is a pure filesystem scan — no network, no API key.

2. **Phase 2 (`--check-onchain`)** — for each candidate, fetches the on-chain ABI for its deployment addresses via `tools/scripts/lib/abi-fetcher.js` and confirms the contract actually exposes a permit function. Requires `ETHERSCAN_API_KEY`.

## Usage

```bash
# Offline scan — list all candidate entities
node tools/scripts/check-missing-permit.js

# Scope to a single entity
node tools/scripts/check-missing-permit.js --entity aave

# Confirm on-chain (chain 1 by default)
ETHERSCAN_API_KEY=... node tools/scripts/check-missing-permit.js --check-onchain
ETHERSCAN_API_KEY=... node tools/scripts/check-missing-permit.js --check-onchain --chain 42161

# JSON output for downstream tooling
node tools/scripts/check-missing-permit.js --json
```

## Permit function names matched

The script treats the following ABI function names (case-insensitive) as permit-shaped:

- `permit`
- `permitSingle`, `permitBatch` (Permit2)
- `permitTransferFrom`, `permitWitnessTransferFrom` (Permit2 SignatureTransfer)

## Notes

- A candidate from phase 1 does not necessarily mean a permit descriptor is missing — many entities ship non-token contracts (routers, vaults, bridges) that legitimately have no permit. Phase 2 separates real opportunities from false positives.
- Phase 2 only checks the chain you ask for (`--chain`, default 1). If an entity has deployments only on chains not yet in `PROVIDERS`, the entry is reported as `checked: false`.
- The script reuses `tools/scripts/lib/abi-fetcher.js` (same rate limit and proxy resolution as `check-contract-functions.js`).
