# ERC-7730 Batch Processor

Automated batch processing tool for ERC-7730 registry folders. This script streamlines the workflow of migrating schema versions, generating tests, and creating pull requests.

## Features

- **Schema Migration**: Automatically migrates files from ERC-7730 v1 to v2 schema (linting/validation is handled by `migrate-v1-to-v2.js`)
- **Test Generation**: Creates missing test files using transaction data from block explorers
- **PR Automation**: Creates a GitHub PR with all changes and a detailed summary

## Prerequisites

### Required

- **Node.js** (v16 or later)

### Optional (for full functionality)

- **erc7730 Python library** - For linting validation
  ```bash
  pip install erc7730
  ```

- **GitHub CLI** - For PR creation
  ```bash
  # macOS
  brew install gh
  
  # Linux
  sudo apt install gh
  
  # Authenticate
  gh auth login
  ```

- **API Keys** - For test generation (see Environment Variables)

## Installation

```bash
# Install Node.js dependencies
npm install

# Install erc7730 CLI (optional but recommended)
pip install erc7730
```

## Usage

```bash
# Basic usage - process a registry subfolder
node tools/scripts/batch-process.js <folder-name>

# Dry run - preview changes without modifying files
node tools/scripts/batch-process.js 1inch --dry-run

# Verbose output
node tools/scripts/batch-process.js ethena --verbose

# Full path syntax
node tools/scripts/batch-process.js registry/morpho

# Skip certain steps
node tools/scripts/batch-process.js aave --skip-tests
node tools/scripts/batch-process.js uniswap --skip-migration --skip-pr

# Custom PR settings
node tools/scripts/batch-process.js kiln --pr-title "Update Kiln descriptors" --pr-branch "feat/kiln-v2"

# Force-run tester even when tests already exist
node tools/scripts/batch-process.js circle --local-api --skip-pr --force-test
```

## Options

### Batch Processor Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview changes without modifying files |
| `--verbose` | Show detailed output for each operation |
| `--skip-tests` | Skip test generation |
| `--skip-migration` | Skip v1 to v2 schema migration |
| `--skip-pr` | Skip PR creation (just process files) |
| `--pr-title <title>` | Custom PR title |
| `--pr-branch <name>` | Custom branch name |
| `--local-api` | Auto-start local Flask API server for tester calls |
| `--local-api-port <port>` | Port for local API server (default: `5000`) |

### Cascaded Test Generation Options

These options are passed through to `generate-tests.js`:

| Option | Description |
|--------|-------------|
| `--depth <n>` | Max transactions to search (default: `100`) |
| `--max-tests <n>` | Max tests to generate per function (default: `3`) |
| `--chain <id>` | Only process a specific chain ID |
| `--openai-url <url>` | Custom OpenAI API URL (e.g., Azure endpoint) |
| `--openai-key <key>` | OpenAI API key (overrides `OPENAI_API_KEY`) |
| `--openai-model <model>` | Model to use (default: `gpt-5`) |
| `--azure` | Use Azure OpenAI request format |
| `--no-test` | Skip running the clear signing tester |
| `--force-test` | Run tester even when test file already exists |
| `--device <device>` | Tester device: `flex`, `stax`, `nanosp`, `nanox` |
| `--test-log-level <lvl>` | Tester log level: `none`, `error`, `warn`, `info`, `debug` |
| `--no-refine` | Skip refining `expectedTexts` from tester output |

## Environment Variables

### For Test Generation

Test generation fetches real transaction data from block explorers:

```bash
# Etherscan V2 API key (supports multiple chains)
export ETHERSCAN_API_KEY=your-api-key

# OpenAI API key (for EIP-712 test generation)
export OPENAI_API_KEY=your-api-key
```

### For PR Creation

```bash
# GitHub token (if not using gh CLI auth)
export GITHUB_TOKEN=your-token
```

You can use the provided env template:

```bash
cp tools/scripts/env.example .env
# Edit .env with your keys
source .env
```

## Workflow

The script processes each ERC-7730 file in the target folder:

### 1. Schema Migration

For files using `erc7730-v1.schema.json`:

```
┌─────────────────┐     ┌─────────────────┐
│   v1 Schema     │ ──► │   v2 Schema     │
│   (original)    │     │   (migrated)    │
└─────────────────┘     └─────────────────┘
```

Transformations applied:
- Schema reference updated
- `metadata.contractName` added from `context.$id`
- `metadata.info.legalName` removed
- `context.contract.abi` removed (format keys now human-readable)
- `context.eip712.schemas` removed (format keys now encodeType)
- `required`/`excluded` converted to `visible` modifiers
- `screens` removed
- Null values cleaned

### 2. Validation

Validation (linting and calldata checks) is now handled directly by the `migrate-v1-to-v2.js` script during migration.

### 3. Test Generation

For files without test files (or for existing tests when using `--force-test`):

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Descriptor    │ ──► │   Block         │ ──► │   Test File     │
│   (.json)       │     │   Explorer API  │     │   (.tests.json) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### 4. PR Creation

When changes are detected:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Create        │ ──► │   Stage &       │ ──► │   Create PR     │
│   Branch        │     │   Commit        │     │   via gh CLI    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Output

### Console Output

```
ERC-7730 Batch Processor
========================
Target: registry/1inch

Found 10 ERC-7730 files to process

============================================================
📦 Processing Files
============================================================

ℹ️ Processing: registry/1inch/eip712-1inch-limit-order.json
  → v1 schema detected, migrating to v2...
  → No test file found, generating tests...

[...]

============================================================
📊 BATCH PROCESSING SUMMARY
============================================================

📁 Files processed: 10

🔄 Migrations:
   Attempted:  3
   Successful: 3
   Skipped:    7
   (Linting/validation is now handled by migrate-v1-to-v2.js)

🧪 Test Generation:
   Attempted:  5
   Successful: 4
   Skipped:    5
   Failed:     1
     - eip712-example.json: No transactions found

📝 Changes:
   Modified files: 3
     - registry/1inch/eip712-1inch-limit-order.json
     - [...]
   New files:      4
     - registry/1inch/tests/calldata-example.tests.json
     - [...]

🔗 PR Created: https://github.com/LedgerHQ/clear-signing-erc7730-registry/pull/123

============================================================
```

### Generated PR

The script creates a PR with:

- **Title**: `[Batch Update] <folder> - schema migration and test generation`
- **Body**: Detailed summary with:
  - List of changes made
  - Modified and new files
  - Validation status table
  - Test plan checklist

## Example Workflow

### Processing a New Protocol

```bash
# 1. Preview what will happen
node tools/scripts/batch-process.js newprotocol --dry-run --verbose

# 2. Run the actual processing
source .env  # Load API keys
node tools/scripts/batch-process.js newprotocol

# 3. Review the PR
# The script outputs the PR URL
```

### Migrating All v1 Files in a Folder

```bash
# Skip test generation, just migrate
node tools/scripts/batch-process.js oldprotocol --skip-tests
```

### Generating Missing Tests Only

```bash
# Skip migration, just generate tests
node tools/scripts/batch-process.js protocol --skip-migration
```

## Troubleshooting

### "erc7730 CLI not found"

Install the Python library:

```bash
pip install erc7730
```

### "GitHub CLI (gh) not installed"

Install gh:

```bash
# macOS
brew install gh

# Linux
sudo apt install gh

# Then authenticate
gh auth login
```

### "No tests could be generated"

This usually means:
- No matching transactions found on-chain
- Missing API keys (ETHERSCAN_API_KEY)
- The contract is new with low activity

Try:
```bash
# Increase search depth
node tools/scripts/generate-tests.js registry/file.json --depth 500

# Check with verbose output
node tools/scripts/batch-process.js folder --verbose
```

### Migration fails

Check the specific error in the output. Common issues:
- Invalid JSON in the source file
- File is not a valid ERC-7730 descriptor

### PR creation fails

Ensure:
1. You have push access to the repository
2. `gh` CLI is authenticated (`gh auth status`)
3. The branch doesn't already exist

## Related Scripts

- [`migrate-v1-to-v2.js`](./migrate-v1-to-v2.README.md) - Single-file migration
- [`generate-tests.js`](./generate-tests.README.md) - Single-file test generation
