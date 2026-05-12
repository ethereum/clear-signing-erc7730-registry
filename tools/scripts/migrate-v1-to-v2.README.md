# ERC-7730 Migration Script: v1 → v2

This script migrates registry files from `erc7730-v1.schema.json` to `erc7730-v2.schema.json`.

## Usage

```bash
# Dry run (preview changes, no files modified)
node tools/scripts/migrate-v1-to-v2.js --dry-run

# Dry run with verbose output
node tools/scripts/migrate-v1-to-v2.js --dry-run --verbose

# Migrate a single file
node tools/scripts/migrate-v1-to-v2.js --file registry/ethena/calldata-ethena.json

# Migrate a single file and skip linting validation
node tools/scripts/migrate-v1-to-v2.js --file registry/ethena/calldata-ethena.json --skip-lint

# Run full migration on all registry files
node tools/scripts/migrate-v1-to-v2.js
```

## Transformations Applied

### 1. Schema Reference Update

```diff
- "$schema": "../../specs/erc7730-v1.schema.json"
+ "$schema": "../../specs/erc7730-v2.schema.json"
```

### 2. Contract Name Addition

Copies `context.$id` to a new `metadata.contractName` field:

```diff
  "metadata": {
    "owner": "Ethena",
+   "contractName": "Staked USDe"
  }
```

### 3. Removed Fields

The following fields are removed as they are no longer part of v2:

| Field | Reason |
|-------|--------|
| `metadata.info.legalName` | Removed from schema |
| `context.contract.addressMatcher` | Removed from schema |
| `context.contract.abi` | Replaced by human-readable format keys |
| `context.eip712.schemas` | Replaced by encodeType format keys |
| `display.formats.*.screens` | Removed from schema |
| `display.formats.*.required` | Replaced by visibility modifiers |
| `display.formats.*.excluded` | Replaced by visibility modifiers |

### 4. Format Key Transformation

#### For Calldata (Contract Calls)

Format keys are transformed to [Human-Readable ABI](https://docs.ethers.org/v5/api/utils/abi/formats/#abi-formats--human-readable-abi) format with parameter names:

```diff
- "cooldownShares(uint256)": { ... }
+ "cooldownShares(uint256 shares)": { ... }
```

```diff
- "unstake(address)": { ... }
+ "unstake(address receiver)": { ... }
```

The parameter names are extracted from the `context.contract.abi` before it is removed.

#### For EIP-712 Messages

Format keys are transformed to [EIP-712 `encodeType`](https://eips.ethereum.org/EIPS/eip-712) format:

```diff
- "OrderStructure": { ... }
+ "OrderStructure(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)": { ... }
```

For types with dependencies, dependent types are appended alphabetically:

```
PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)
```

### 5. Visibility Modifiers

The `required` and `excluded` arrays are converted to `visible` properties on fields:

#### Required Fields → `visible: "always"`

```diff
  "fields": [
    {
      "path": "#.shares",
      "label": "Amount",
-     "format": "tokenAmount"
+     "format": "tokenAmount",
+     "visible": "always"
    }
- ],
- "required": ["#.shares"]
+ ]
```

#### Excluded Fields → `visible: "never"`

New field entries are created for excluded paths:

```diff
  "fields": [
    { "path": "maker", "label": "From", "format": "raw" },
-   ...
- ],
- "excluded": ["salt", "makerTraits"]
+   ...,
+   { "path": "salt", "visible": "never" },
+   { "path": "makerTraits", "visible": "never" }
+ ]
```

### 6. Null Value Cleanup

All keys with `null` values are removed:

```diff
  "fields": [
    {
-     "$id": null,
      "label": "Amount",
      "format": "tokenAmount",
-     "path": "#.shares",
-     "value": null
+     "path": "#.shares"
    }
  ],
- "screens": null,
- "excluded": null
```

## Example

### Before (v1)

```json
{
  "$schema": "../../specs/erc7730-v1.schema.json",
  "context": {
    "$id": "Staked USDe",
    "contract": {
      "deployments": [{ "chainId": 1, "address": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" }],
      "abi": [
        {
          "type": "function",
          "name": "cooldownShares",
          "inputs": [{ "name": "shares", "type": "uint256" }],
          "outputs": [{ "name": "assets", "type": "uint256" }],
          "stateMutability": "nonpayable"
        }
      ],
      "addressMatcher": null
    }
  },
  "metadata": {
    "owner": "Ethena",
    "info": { "legalName": "Ethena", "url": "https://ethena.fi/" }
  },
  "display": {
    "formats": {
      "cooldownShares(uint256)": {
        "$id": null,
        "intent": "Cooldown Shares",
        "screens": null,
        "fields": [
          {
            "$id": null,
            "label": "Amount",
            "format": "tokenAmount",
            "params": { "token": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" },
            "path": "#.shares",
            "value": null
          }
        ],
        "required": ["#.shares"],
        "excluded": null
      }
    }
  }
}
```

### After (v2)

```json
{
  "$schema": "../../specs/erc7730-v2.schema.json",
  "context": {
    "$id": "Staked USDe",
    "contract": {
      "deployments": [
        { "chainId": 1, "address": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" }
      ]
    }
  },
  "metadata": {
    "owner": "Ethena",
    "info": { "url": "https://ethena.fi/" },
    "contractName": "Staked USDe"
  },
  "display": {
    "formats": {
      "cooldownShares(uint256 shares)": {
        "intent": "Cooldown Shares",
        "fields": [
          {
            "label": "Amount",
            "format": "tokenAmount",
            "params": { "token": "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" },
            "path": "#.shares",
            "visible": "always"
          }
        ]
      }
    }
  }
}
```

## Statistics (Dry Run on Full Registry)

```
Total files scanned:    351
Files migrated:         260
Files skipped:          91

Schema references:      260
Contract names added:   70
legalName removed:      174
addressMatcher removed: 25
ABI removed:            73
Schemas removed:        36
Required → visible:     572
Excluded → visible:     414
Screens removed:        31
Null values cleaned:    289
Format keys transformed:178
```
