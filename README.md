# ERC-7730 (Clear Signing Metadata) Registry

The objective of ERC-7730 is to establish a standardized method for clear signing contracts and messages on EVM chains, by offering metadata formatting that complements ABIs and message types. To learn more about the ERC-7730 standard, visit [Ledger Developer Portal](https://developers.ledger.com/docs/clear-signing/erc7730).

This repository maintains records of past and current metadata files in the `registry` directory.

## Registry structure

```
README.md                                    # top-level README file with submission process
specs/
  erc-7730.md                                # most advanced version of the spec but reference should be the ERC
  erc7730-v1.schema.json                     # the json schema of the latest version of the extension
  erc7730-tests.schema.json                  # legacy json schema for test files (tests/)
  erc7730-tests-v2.schema.json               # json schema for test files (testsv2/)
registry/
  $entity_name/                              # official entity name submitting metadata information
    calldata-$contractName1.json             # metadata for contract $contractName1, including the contract version in name
    calldata-$contractName2.json
    eip712-$messageName.json                 # metadata for EIP712 message $messageName
    common-$sharedDefinition.json            # common definitions shared between descriptors (without prefix)
    testsv2/
       calldata-$contractName1.tests.json    # test cases for calldata-$contractName1.json
       calldata-$contractName2.tests.json
       eip712-$messageName.tests.json        # test cases for eip712-$messageName.json
ercs/
  erc20.json                                 # standard ERC token metadata files
  erc721.json
  erc4626.json
  ...
```

## Submission Process

- Submit the files through a pull request to this registry repository, following the requirements below.
- After your PR is accepted, the submitted files are automatically imported in the Ledger Cryptoassets list, which allows users to clear sign.

## Pull Request content requirements

- The PR is submitted by a user whose email matches the entity's name.
- Each PR modifies **only one entity**, meaning it affects only one sub-folder within the top-level `registry` directory.
- Each entity folder includes **at least one file that is compatible with ERC-7730**, located at the root of the entity's folder.
- All ERC-7730 compatible files are prefixed with either `calldata` for smart contracts or `eip712` for EIP-712 messages.
- All ERC-7730 compatible files are correctly validated against the schema file located at `specs/erc7730-v1.schema.json`.
- Do not use the `calldata` or `eip712` prefixes for common files which are included by the ERC-7730 files and placed at the top level of the entity folder.

## How to validate

The `erc7730` Python package is available for validating and formatting ERC-7730 descriptors:

```bash
# Install the erc7730 package (requires Python 3.12+)
pip install erc7730

# Validate all descriptors
erc7730 lint registry/**/eip712-*.json registry/**/calldata-*.json

# Validate a specific file
erc7730 lint registry/entity/calldata-Contract.json

# Format all descriptors
erc7730 format

# Generate a new descriptor from Etherscan
erc7730 generate --address 0xContractAddress --chain-id 1 --owner "Entity Name" --url "https://entity.url"
```

For more information about the ERC-7730 tools, visit the [erc7730 package on PyPI](https://pypi.org/project/erc7730/).

## Reference test cases

You can add reference test cases for your ERC-7730 descriptors. These test cases provide sample transactions and messages that wallet vendors can use to verify their implementations against the descriptor.

### Test file format

Test files should be placed in a `testsv2/` folder within your entity directory and named `<descriptor-name>.tests.json`. The file declares the descriptor under test, an optional `dataProvider` block with mock token metadata and address-name lookups (so tests don't need network access), and an array of test cases.

**Calldata test file example** (`calldata-MyContract.tests.json`):

```json
{
  "$schema": "../../../specs/erc7730-tests-v2.schema.json",
  "descriptor": "../calldata-MyContract.json",
  "dataProvider": {
    "tokens": {
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { "symbol": "USDC", "decimals": 6, "name": "USD Coin" }
    },
    "addressNames": {
      "0x1234567890123456789012345678901234567890": "Treasury"
    }
  },
  "tests": [
    {
      "description": "Approve 100 USDC for Treasury",
      "rawTx": "0x02f8b0...",
      "txHash": "0x1234...abcd",
      "expected": {
        "intent": "Approve",
        "owner": "MyProtocol",
        "fields": {
          "Spender": "Treasury",
          "Amount": "100 USDC"
        }
      }
    }
  ]
}
```

**EIP-712 test file example** (`eip712-MyMessage.tests.json`):

```json
{
  "$schema": "../../../specs/erc7730-tests-v2.schema.json",
  "descriptor": "../eip712-MyMessage.json",
  "tests": [
    {
      "description": "Permit 100 USDC",
      "data": {
        "types": { ... },
        "primaryType": "Permit",
        "domain": { ... },
        "message": { ... }
      },
      "expected": {
        "intent": "Permit",
        "owner": "MyProtocol",
        "fields": {
          "Spender": "0x1234...",
          "Amount": "100 USDC"
        }
      }
    }
  ]
}
```

### Test fields

#### For calldata tests (`calldata-*.tests.json`)

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Human-readable test identifier — used to match runner results back to this case |
| `rawTx` | Yes | The raw signed transaction (hex string, 0x-prefixed) |
| `txHash` | No | Transaction hash for reference (e.g., link to Etherscan) |
| `expected` | Yes | Expected rendered output: `{ intent, interpolatedIntent?, owner, fields }`. Field values are strings, or nested `{ intent, owner, fields }` objects for calldata formatters |

#### For EIP-712 tests (`eip712-*.tests.json`)

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Human-readable test identifier |
| `data` | Yes | Complete EIP-712 typed data object (with `types`, `primaryType`, `domain`, `message`) |
| `expected` | Yes | Expected rendered output: `{ intent, interpolatedIntent?, owner, fields }` |

#### The `expected` block

| Field | Required | Description |
|-------|----------|-------------|
| `intent` | Yes | The action label shown to the user (e.g. `"Approve"`, `"Swap"`). For descriptors with a templated intent, this is the un-interpolated literal form |
| `interpolatedIntent` | No | The fully-rendered interpolatedIntent string after substituting template placeholders against the formatted fields (e.g. `"Swap 100 USDC for DAI"`). Omit when the descriptor has no interpolatedIntent |
| `owner` | Yes | The descriptor owner shown to the user (e.g. `"Aave DAO"`) |
| `fields` | Yes | Object mapping field labels to displayed values. Values are strings, or nested `{ intent, owner, fields }` objects for calldata-formatted fields |

### Best practices

1. **Include at least one test per function/message type** defined in your descriptor
2. **Use real transactions** when possible - they provide the most realistic test cases
3. **Add descriptive labels** to help reviewers understand what each test validates
4. **Test edge cases** like maximum values, zero values, and special addresses
