# ERC-7730 (Clear Signing Metadata) Registry

The objective of ERC-7730 is to establish a standardized method for clear signing contracts and messages on EVM chains, by offering metadata formatting that complements ABIs and message types. To learn more about the ERC-7730 standard, available tooling and adoption, visit [Clearsigning.org](https://clearsigning.org).

This repository maintains records of past and current metadata files in the `registry` directory.

## Registry structure

```
README.md                                    # top-level README file with submission process
specs/
  erc-7730.md                                # most advanced version of the spec but reference should be the ERC
  erc7730-v1.schema.json                     # the json schema of the latest version of the extension
  erc7730-tests.schema.json                  # json schema for test files
registry/
  $entity_name/                              # official entity name submitting metadata information
    calldata-$contractName1.json             # metadata for contract $contractName1, including the contract version in name
    calldata-$contractName2.json
    eip712-$messageName.json                 # metadata for EIP712 message $messageName
    common-$sharedDefinition.json            # common definitions shared between descriptors (without prefix)
    tests/
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

- Submit the files through a pull request to this registry repository.
- See https://ethereum.org/developers/tutorials/clear-signing.

## Pull Request content requirements

- Each PR modifies **only one entity**, meaning it affects only one sub-folder within the top-level `registry` directory.
- Each entity folder includes **at least one file that is compatible with ERC-7730**, located at the root of the entity's folder.
- All ERC-7730 compatible files are prefixed with either `calldata` for smart contracts or `eip712` for EIP-712 messages.
- All ERC-7730 compatible files are correctly validated against the schema file located at `specs/erc7730-v2.schema.json`.
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

Test files should be placed in a `tests/` folder within your entity directory and named `<descriptor-name>.tests.json`. The test file name determines which descriptor it tests (e.g., `calldata-MyContract.tests.json` tests `calldata-MyContract.json`).

**Calldata test file example** (`calldata-MyContract.tests.json`):

```json
{
  "$schema": "../../../specs/erc7730-tests.schema.json",
  "tests": [
    {
      "description": "Test approve function",
      "rawTx": "0x02f8b0...",
      "txHash": "0x1234...abcd",
      "expectedTexts": ["Spender", "0x1234...", "Amount", "100 USDC"]
    }
  ]
}
```

**EIP-712 test file example** (`eip712-MyMessage.tests.json`):

```json
{
  "$schema": "../../../specs/erc7730-tests.schema.json",
  "tests": [
    {
      "description": "Test permit signature",
      "data": {
        "types": { ... },
        "primaryType": "Permit",
        "domain": { ... },
        "message": { ... }
      },
      "expectedTexts": ["Spender", "0x1234...", "Amount", "100 USDC"]
    }
  ]
}
```

### Test fields

#### For calldata tests (`calldata-*.tests.json`)

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Human-readable test description |
| `rawTx` | Yes | The raw signed transaction (hex string, 0x-prefixed) |
| `txHash` | No | Transaction hash for reference (e.g., link to Etherscan) |
| `expectedTexts` | No | Array of expected text strings (labels and values) displayed during signing |

#### For EIP-712 tests (`eip712-*.tests.json`)

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Human-readable test description |
| `data` | Yes | Complete EIP-712 typed data object (with `types`, `primaryType`, `domain`, `message`) |
| `expectedTexts` | No | Array of expected text strings (labels and values) displayed during signing |

### Best practices

1. **Include at least one test per function/message type** defined in your descriptor
2. **Use real transactions** when possible - they provide the most realistic test cases
3. **Add descriptive labels** to help reviewers understand what each test validates
4. **Test edge cases** like maximum values, zero values, and special addresses
