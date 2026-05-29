# ERC-7730 Linter Local Setup

This document describes how to set up and use the [python-erc7730](https://github.com/LedgerHQ/python-erc7730) linter locally.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

## Setup

### Option 1: Install from PyPI (recommended)

The simplest way to get started is to install the released package directly from [PyPI](https://pypi.org/project/erc7730/):

```bash
pip install erc7730
```

Or with uv:

```bash
uv tool install erc7730
```

### Option 2: Local clone (for development)

The setup script clones the [python-erc7730](https://github.com/LedgerHQ/python-erc7730) repository and installs it locally. This is useful if you need the latest unreleased changes or want to contribute:

```bash
cd tools/linter
./setup.sh
```

This will:
1. Clone the [python-erc7730](https://github.com/LedgerHQ/python-erc7730) repository
2. Install dependencies (using `uv` if available, otherwise `pip` with editable install)

## Usage

### Activate the environment

Before running any commands, source the `.env` file (for API keys) and activate the virtual environment:

```bash
source .env && source tools/linter/.venv/bin/activate
```

Or as a one-liner from the repository root:

```bash
source .env && source tools/linter/.venv/bin/activate && erc7730 lint registry/
```

### Lint descriptor files

Validate all descriptor files in the registry:

```bash
erc7730 lint registry/
```

Validate a specific file:

```bash
erc7730 lint registry/uniswap/calldata-permit2.json
```

### Other commands

The `erc7730` CLI provides several useful commands:

```bash
# Show all available commands
erc7730 --help

# Format descriptor files
erc7730 format <path>

# Generate a new descriptor from ABI
erc7730 generate <abi-path>

# Convert descriptor to resolved form
erc7730 resolve <path>

# Print JSON schema
erc7730 schema
```

## Configuration

### Etherscan API Key

To validate ABIs fetched from Etherscan, the `ETHERSCAN_API_KEY` environment variable must be set.

The repository root contains a `.env` file with this key. Source it before running the linter:

```bash
source .env
```

**Note:** The Python tool does not automatically load `.env` files - you must source it manually or export the variable directly:

```bash
export ETHERSCAN_API_KEY=your_api_key_here
```

## Documentation

For more information, see the [python-erc7730 documentation](https://ledgerhq.github.io/python-erc7730).
