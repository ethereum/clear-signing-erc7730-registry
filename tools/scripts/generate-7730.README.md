# ERC-7730 Descriptor Generator

Generates ERC-7730 v2 clear signing descriptor files using an LLM. Given a contract address, ABI, and/or Solidity source code, it produces:

- **Calldata descriptors** (`calldata-*.json`) for contract write functions
- **EIP-712 descriptors** (`eip712-*.json`) for any EIP-712 typed messages the contract verifies

## Prerequisites

- Node.js v18+
- An LLM backend: OpenAI API, Anthropic API, or Cursor agent CLI

### Dependencies

From the repository root:

```bash
npm install
```

This installs `@langchain/langgraph`, `@langchain/openai`, `@langchain/anthropic`, `@langchain/core`, and `zod`.

## Usage

```bash
node tools/scripts/generate-7730.js [options]
```

At least one of `--address`, `--abi`, or `--source` is required.

### From an on-chain address (recommended)

The simplest way to use the generator. Provide just the contract address and the script downloads the ABI and source code automatically:

```bash
# Minimal: address + output directory (tries Sourcify, then Etherscan)
node tools/scripts/generate-7730.js \
  --address 0xdAC17F958D2ee523a2206206994597C13D831ec7 \
  --output registry/tether \
  --name "Tether"

# With chain ID (default is 1 / Ethereum mainnet)
node tools/scripts/generate-7730.js \
  --address 0x794a61358D6845594F94dc1DB02A252b5b4814aD \
  --chain 137 \
  --output registry/aave \
  --name "Aave"
```

The script fetches from:
1. **Sourcify** first (no API key needed) -- gets ABI, source code, and contract name in one call
2. **Etherscan** as fallback (requires `ETHERSCAN_API_KEY`) -- gets ABI, source code, and contract name

Proxy contracts are detected automatically (via Etherscan and ERC-1967 storage slot reading) and resolved to their implementation address before fetching ABI and source code.

### From a local ABI file

```bash
# ABI only (no source code, no address)
node tools/scripts/generate-7730.js \
  --abi path/to/abi.json \
  --output registry/myprotocol

# ABI + address (fetches source code automatically for better results)
node tools/scripts/generate-7730.js \
  --abi path/to/abi.json \
  --address 0x1234567890abcdef1234567890abcdef12345678 \
  --output registry/myprotocol \
  --name "My Protocol" \
  --url "https://myprotocol.xyz"
```

### From local source code

```bash
node tools/scripts/generate-7730.js \
  --source ./contracts/src \
  --output registry/myprotocol \
  --name "My Protocol"
```

### Include admin functions

By default, admin/governance functions (e.g., `transferOwnership`, `pause`, `setFeeRate`) are excluded. To include them:

```bash
node tools/scripts/generate-7730.js \
  --address 0x1234... \
  --output registry/myprotocol \
  --include-admin
```

### Dry run

Preview generated output without writing files:

```bash
node tools/scripts/generate-7730.js \
  --address 0x1234... \
  --output registry/myprotocol \
  --dry-run --verbose
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--address <addr>` | - | On-chain contract address (auto-downloads ABI + source) |
| `--abi <path>` | - | Path to local ABI JSON file (mutually exclusive with `--source`) |
| `--source <path>` | - | Path to folder with Solidity source files |
| `--output <path>` | - | Destination folder for generated files (created if missing) |
| `--chain <id>` | `1` | Chain ID (used with `--address` for on-chain lookups) |
| `--name <name>` | - | Protocol / owner name for `metadata.owner` |
| `--contract-name <name>` | inferred | Contract name for `metadata.contractName` and filenames |
| `--url <url>` | - | Protocol website URL for `metadata.info.url` |
| `--include-admin` | `false` | Include admin/governance functions in output |
| `--dry-run` | `false` | Preview without writing files |
| `--verbose` | `false` | Show detailed output |
| `--log <path>` | - | Enable verbose logging to file |
| `-l` | - | Enable verbose logging to `tools/scripts/logs/` |
| `--backend <name>` | `openai` | LLM backend: `openai`, `anthropic`, `cursor` |
| `--model <model>` | backend-specific | Model name (see Backends below) |
| `--api-key <key>` | env var | API key (overrides env var for the selected backend) |
| `--api-url <url>` | backend-specific | Custom API base URL (openai/anthropic backends only) |
| `--rpc-url <url>` | public RPC | JSON-RPC endpoint for proxy detection |
| `--schema-path <path>` | `../../specs/erc7730-v2.schema.json` | Relative schema path in output |

## Backends

| Backend | Default model | API key env var | Description |
|---------|---------------|-----------------|-------------|
| `openai` | `gpt-4o` | `OPENAI_API_KEY` | OpenAI-compatible API (also works with OpenRouter, Ollama, etc.) |
| `anthropic` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` | Anthropic API |
| `cursor` | `opus-4.6` | - | Cursor agent CLI in ask mode (no API key needed) |

### OpenAI backend

```bash
node tools/scripts/generate-7730.js \
  --address 0x1234... \
  --output registry/myprotocol \
  --backend openai \
  --model gpt-4o
```

### Anthropic backend

```bash
node tools/scripts/generate-7730.js \
  --address 0x1234... \
  --output registry/myprotocol \
  --backend anthropic \
  --model claude-sonnet-4-20250514
```

### Cursor backend

Uses the `cursor agent` CLI in ask mode. No API key needed — uses your Cursor subscription:

```bash
node tools/scripts/generate-7730.js \
  --address 0x1234... \
  --output registry/myprotocol \
  --backend cursor
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key for the openai backend |
| `ANTHROPIC_API_KEY` | API key for the anthropic backend |
| `ETHERSCAN_API_KEY` | For downloading contract source code from Etherscan |
| `RPC_URL` | JSON-RPC endpoint for proxy detection (default: public RPC per chain) |

### Setting up environment variables

```bash
# Option 1: Source from the env template
cp tools/scripts/env.example .env
# Edit .env with your keys
source .env

# Option 2: Export directly
export ETHERSCAN_API_KEY="your-key"

# Option 3: Inline
ETHERSCAN_API_KEY="your-key" node tools/scripts/generate-7730.js --abi abi.json --output out/
```

## Output

The script generates files in the specified output directory:

```
registry/myprotocol/
├── calldata-MyContract.json          # Calldata descriptor
├── eip712-Permit.json                # EIP-712 descriptor (if applicable)
└── eip712-TransferWithAuth.json      # Additional EIP-712 descriptors
```

### Naming convention

- Calldata files: `calldata-{ContractName}.json`
- EIP-712 files: `eip712-{MessageTypeName}.json`

These follow the registry convention used throughout the repository.

## How It Works

1. **Resolve inputs**: Depending on what's provided:
   - `--address` only: Downloads ABI + source from Sourcify/Etherscan (also infers contract name)
   - `--abi`: Reads local ABI file; if `--address` also given, fetches source code
   - `--source`: Reads local Solidity files; LLM infers ABI from source if not provided
2. **Detect proxies**: If the address is a proxy contract, resolves to the implementation address
3. **Build context**: Assembles the ERC-7730 spec, v2 schema, contract ABI, source code, and examples
4. **Generate calldata descriptor**: Sends context + calldata prompt to the LLM
5. **Generate EIP-712 descriptors**: If source code is available, sends context + EIP-712 prompt to scan for typed messages
6. **Write output**: Saves generated JSON files to the output directory

### What the LLM generates

**Calldata descriptors:**
- Identifies all write functions (non-view, non-pure)
- Filters out admin functions by default
- Generates human-readable labels and intent strings
- Applies appropriate format types (`tokenAmount`, `addressName`, `date`, etc.)
- Sets visibility: security-critical fields always shown, internal fields hidden

**EIP-712 descriptors:**
- Scans source code for EIP-712 patterns (type hashes, domain separators, signature verification)
- Generates separate files for each message type found
- Includes proper encodeType format keys
- Configures domain bindings based on source code analysis

## Prompts

The LLM prompts are stored as markdown files in `tools/scripts/prompts/` for easy editing:

| File | Purpose |
|------|---------|
| `prompts/system-calldata.md` | Instructions for generating calldata descriptors |
| `prompts/system-eip712.md` | Instructions for generating EIP-712 descriptors |

Edit these files to customize the generation behavior, adjust field formatting rules, or add new examples.

## Post-generation Workflow

After generating descriptors:

1. **Review** the generated files for accuracy
2. **Fill in TODOs** (deployment addresses if not provided)
3. **Lint** the files:
   ```bash
   source .env && source tools/linter/.venv/bin/activate && erc7730 lint registry/myprotocol/
   ```
4. **Generate tests**:
   ```bash
   source .env && node tools/scripts/generate-tests.js registry/myprotocol/calldata-MyContract.json
   ```
5. **Run tester** (automatic with test generation if `GATING_TOKEN` is set)

## Troubleshooting

### "OpenAI/Anthropic backend requires an API key"

- Make sure the appropriate env var is set (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`)
- Or pass the key directly with `--api-key`
- For the `cursor` backend, no API key is needed

### "Could not retrieve ABI for address"

- The contract is likely not verified on Sourcify or Etherscan
- Ensure `ETHERSCAN_API_KEY` is set for Etherscan lookups
- Try providing the ABI locally with `--abi` or source code with `--source`

### "ABI looks like a proxy contract"

- The address is a proxy but the implementation could not be resolved automatically
- Set `ETHERSCAN_API_KEY` for Etherscan-based proxy detection
- Provide `--rpc-url` or set `RPC_URL` for ERC-1967 storage slot reading
- Or find the implementation address manually and use that with `--address`

### "No source code found"

- The ABI was retrieved but source code wasn't available
- Generation will still work (from ABI only) but EIP-712 detection will be skipped
- Use `--source` to provide source files directly for better results

### "Could not extract valid JSON from LLM response"

- The LLM produced output that couldn't be parsed as JSON
- Try running with `--verbose` to see the raw response
- Try a different model with `--model`

### Large contracts

For contracts with many functions, the source code may be truncated to fit the LLM context window (80,000 chars). The ABI is always sent in full.
