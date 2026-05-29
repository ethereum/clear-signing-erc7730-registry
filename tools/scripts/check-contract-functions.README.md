# Check Contract Functions Against On-Chain ABIs

Validate ERC-7730 **contract** descriptors (`calldata-*`) against on-chain contract ABIs.

Script path: `tools/scripts/check-contract-functions.js`

## What it checks

For each function key in `display.formats`:

1. Compute the selector from the key signature.
2. Resolve each deployment address to its implementation when it is a proxy (via Etherscan `getsourcecode`).
3. Fetch the ABI for that implementation address.
4. Verify that every descriptor selector exists in that ABI.

This means both v1-style and v2-style keys are accepted as input:

- v1 style: `transfer(address,uint256)`
- v2 human-readable style: `transfer(address to, uint256 amount)`

Both normalize to the same selector if they describe the same function.

## Proxy behavior

For each deployment address, the script queries Etherscan `getsourcecode`:

- If `Proxy=1` and `Implementation` is set, checks the implementation ABI.
- If not a proxy, checks the deployment address ABI directly.

Output includes both proxy and implementation addresses so mismatches are traceable.

## Report behavior

Per chain, output is grouped into:

- **Fully matching implementation addresses** (compact list)
- **Mismatching implementation details** (full details only for problematic ones)

For each mismatch:

- descriptor key
- computed selector from descriptor key
- closest on-chain human-readable ABI suggestion + its selector

## Usage

```bash
node tools/scripts/check-contract-functions.js --file <descriptor.json> [options]
```

or:

```bash
node tools/scripts/check-contract-functions.js <descriptor.json> [options]
```

### Options

| Option | Description |
|---|---|
| `--file <path>` | Descriptor path (alternative to positional argument) |
| `--chain <id>` | Validate one chain (default: `1`) |
| `--all-chains` | Validate all deployment chains supported by configured explorers and API key |
| `--verbose` | Show debug output |

## Environment variables

Required for supported chains:

- `ETHERSCAN_API_KEY`

The script uses Etherscan V2-compatible endpoints and includes built-in request throttling/retry to reduce rate-limit failures.

## Supported chains

Current provider map:

- `1` (Ethereum)
- `10` (Optimism)
- `56` (BSC)
- `137` (Polygon)
- `8453` (Base)
- `42161` (Arbitrum)
- `43114` (Avalanche)

## Examples

Single file, default chain preference (`1`):

```bash
source .env && node tools/scripts/check-contract-functions.js \
  --file registry/midas/calldata-MinterVault.json
```

Explicit chain:

```bash
source .env && node tools/scripts/check-contract-functions.js \
  --file registry/midas/calldata-MinterVault.json \
  --chain 1
```

All supported deployment chains:

```bash
source .env && node tools/scripts/check-contract-functions.js \
  --file registry/midas/calldata-MinterVault.json \
  --all-chains
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All implementation addresses include all descriptor selectors |
| `1` | Runtime/config/API error (e.g. missing key, request failure) |
| `2` | Validation completed but one or more selector mismatches were found |

## Notes

- The script is only for **contract** descriptors. EIP-712 descriptors are rejected.
- Matching is selector-based, not strict text-format-based.
- “Closest on-chain ABI” suggestions are heuristic and intended as guidance.
