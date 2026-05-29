# ERC-7730 Analyzer Local Setup

This document describes how to set up and use the [erc7730-analyzer](https://github.com/LedgerHQ/erc7730-analyzer) locally. The analyzer is an AI-powered security auditor for ERC-7730 clear signing metadata files that validates transaction descriptors against what smart contracts actually do.

## What It Does

1. Fetches real transactions from the blockchain
2. Analyzes smart contract source code
3. Compares what the descriptor shows vs. what actually happens
4. Generates audit reports with critical issues and recommendations

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- API keys (depends on chosen backend):
  - **ETHERSCAN_API_KEY** — for fetching ABI and transactions (always required)
  - **OPENAI_API_KEY** — for the `openai` backend
  - **ANTHROPIC_API_KEY** — for the `anthropic` backend
  - No API key needed for the `cursor` backend (uses your Cursor subscription)

## Setup

### Option 1: Install from PyPI (recommended)

The simplest way to get started is to install the released package directly from [PyPI](https://pypi.org/project/erc7730-analyzer/):

```bash
pip install erc7730-analyzer
```

Or with uv:

```bash
uv tool install erc7730-analyzer
```

### Option 2: Local clone (for development)

The setup script clones the [erc7730-analyzer](https://github.com/LedgerHQ/erc7730-analyzer) repository and installs it locally. This is useful if you need the latest unreleased changes or want to contribute:

```bash
cd tools/analyzer
./setup.sh
```

This will:
1. Clone the [erc7730-analyzer](https://github.com/LedgerHQ/erc7730-analyzer) repository
2. Install dependencies (using `uv` if available, otherwise `pip`)
3. Verify that required environment variables are set

## Configuration

The analyzer requires API keys set as environment variables. Add them to the `.env` file at the repository root:

```bash
ETHERSCAN_API_KEY=your_etherscan_key

# LLM backend keys (only the one matching your --backend choice is needed)
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key

# Optional
COREDAO_API_KEY=your_coredao_key   # For Core DAO chain (1116)
LOOKBACK_DAYS=20                    # Transaction lookback period (default: 20)
```

Source the `.env` file before running the analyzer:

```bash
source .env
```

## Usage

### With uv (recommended)

```bash
cd tools/analyzer/erc7730-analyzer
uv run analyze_7730 --erc7730_file <path-to-descriptor>
```

### With pip

```bash
source tools/analyzer/erc7730-analyzer/.venv/bin/activate
analyze_7730 --erc7730_file <path-to-descriptor>
```

### Examples

Analyze a registry descriptor:

```bash
source .env
cd tools/analyzer/erc7730-analyzer
uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json
```

With debug output and custom lookback:

```bash
uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json --debug --lookback-days 30
```

### LLM Backends

The analyzer supports multiple LLM backends, matching the pattern used by the scripts in `tools/scripts/`:

| Backend | Default model | API key env var | Description |
|---------|---------------|-----------------|-------------|
| `openai` | `gpt-4o` | `OPENAI_API_KEY` | OpenAI-compatible API (also works with OpenRouter, Ollama, etc.) |
| `anthropic` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` | Anthropic API |
| `cursor` | `opus-4.6` | — | Cursor agent CLI in ask mode (no API key needed) |

#### OpenAI backend (default)

```bash
uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json \
  --backend openai --model gpt-4o
```

#### Anthropic backend

```bash
uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json \
  --backend anthropic --model claude-sonnet-4-20250514
```

#### Cursor backend

Uses the `cursor agent` CLI in ask mode. No API key needed — uses your Cursor subscription:

```bash
uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json \
  --backend cursor
```

### Options

| Option              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `--erc7730_file`    | Path to the ERC-7730 descriptor file to audit  |
| `--backend`         | LLM backend: `openai`, `anthropic`, `cursor` (default: `openai`) |
| `--model`           | Model name (default depends on backend)        |
| `--llm-api-key`     | API key for the LLM backend (overrides env var) |
| `--llm-api-url`     | Custom API base URL (openai/anthropic only)    |
| `--debug`           | Enable debug output                            |
| `--lookback-days N` | Transaction lookback period in days (default: 20) |

## Output

Reports are saved to `tools/analyzer/erc7730-analyzer/output/`:

| File               | Description                                  |
| ------------------ | -------------------------------------------- |
| `CRITICALS_*.md`   | Critical issues requiring immediate attention |
| `SUMMARY_*.md`     | Full analysis with all findings              |

## Documentation

For more information, see the [erc7730-analyzer repository](https://github.com/LedgerHQ/erc7730-analyzer).
