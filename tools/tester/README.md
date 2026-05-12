# Clear Signing Tester - Local Setup

This directory contains scripts to run Ledger's [clear-signing-tester](https://github.com/LedgerHQ/device-sdk-ts/tree/develop/apps/clear-signing-tester) locally against ERC-7730 descriptor files.

The clear-signing-tester validates that ERC-7730 descriptors properly display transaction information on Ledger hardware devices using the Speculos emulator.

## Quick Start

```bash
# 1. Run setup (only needed once)
./setup.sh

# 2. Set your gating token
export GATING_TOKEN='your-token-here'

# 3. Run tests on a descriptor
./run-test.sh \
    ../../registry/circle/eip712-TransferWithAuthorization.json \
    ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json \
    flex
```

## Scripts

| Script | Description |
|--------|-------------|
| `setup.sh` | Clones repos, installs dependencies, pulls Docker images |
| `run-test.sh` | Runs tests for any descriptor/test file pair |
| `parse-apdu.sh` | Parses APDU logs into human-readable format |
| `filter-apdu.sh` | Filters raw APDU logs to extract exchanges only |

## Prerequisites

Before running the setup, ensure you have:

- **Node.js v18+** - JavaScript runtime
- **pnpm** - Package manager (`npm install -g pnpm`)
- **Docker** - Container runtime (must be running)
- **jq** - JSON processor
- **Git** - Version control
- **Access to LedgerHQ/coin-apps** - Private repository containing Ledger firmware

### Installing Prerequisites

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y jq docker.io
sudo usermod -aG docker $USER  # Log out and back in after this

# Install pnpm
npm install -g pnpm
```

## Directory Structure

After running `setup.sh`:

```
tools/tester/
├── dmk/                    # device-sdk-ts repository (cloned)
├── coin-apps/              # Ledger firmware apps (cloned, private)
├── output/                 # Test output directory
│   ├── screenshots/        # Device screenshots
│   ├── logs/               # Test and APDU logs
│   └── test-inputs/        # Prepared test JSON files
├── setup.sh                # Setup script
├── run-test.sh             # Test runner script
├── parse-apdu.sh           # APDU log parser
├── filter-apdu.sh          # APDU log filter
└── README.md               # This file
```

## Usage

### Running Tests

```bash
./run-test.sh <descriptor-file> <test-file> [device] [log-level]
```

**Arguments:**

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `descriptor-file` | Yes | - | Path to the ERC-7730 descriptor JSON file |
| `test-file` | Yes | - | Path to the test JSON file (*.tests.json) |
| `device` | No | `flex` | Device to emulate: `flex`, `stax`, `nanosp`, `nanox` |
| `log-level` | No | `info` | Log level: `none`, `error`, `warn`, `info`, `debug` |

**Examples:**

```bash
# Test Circle EIP-712 descriptor on Flex
./run-test.sh \
    ../../registry/circle/eip712-TransferWithAuthorization.json \
    ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json \
    flex

# Test 1inch calldata descriptor on Stax with debug logging
./run-test.sh \
    ../../registry/1inch/calldata-AggregationRouterV6.json \
    ../../registry/1inch/tests/calldata-AggregationRouterV6.tests.json \
    stax \
    debug

# Test on Nano S Plus
./run-test.sh \
    ../../registry/uniswap/eip712-permit2.json \
    ../../registry/uniswap/tests/eip712-permit2.tests.json \
    nanosp
```

### Test Types

The script automatically detects the test type from the descriptor filename:

| Filename Pattern | Test Type | Description |
|------------------|-----------|-------------|
| `calldata-*.json` | Calldata | Raw transaction calldata signing |
| `eip712-*.json` | EIP-712 | Typed structured data signing |

### Parsing APDU Logs

After running tests, you can analyze the APDU exchanges:

```bash
# Parse an APDU log file
./parse-apdu.sh output/logs/apdu-log-20260206-131651.txt

# Save parsed output to file
./parse-apdu.sh output/logs/apdu-log-20260206-131651.txt parsed.txt

# Filter raw APDU exchanges only
./filter-apdu.sh output/logs/apdu-log-20260206-131651.txt
```

The parser decodes Ethereum app APDU commands including:
- `EIP712_STRUCT_DEF` - Structure definitions
- `EIP712_STRUCT_IMPL` - Structure implementations/values
- `EIP712_FILTERING` - Display filtering instructions
- And all other Ethereum app commands

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GATING_TOKEN` | Yes | Ledger authentication token for API access |

Get your gating token from Ledger's internal developer resources.

## Supported Devices

| Device | Flag | Description |
|--------|------|-------------|
| Ledger Flex | `flex` | Large touchscreen device |
| Ledger Stax | `stax` | E-ink touchscreen device |
| Ledger Nano S Plus | `nanosp` | Compact USB device |
| Ledger Nano X | `nanox` | Bluetooth-enabled device |

## Output Files

After running tests, you'll find:

| File | Location | Description |
|------|----------|-------------|
| Screenshots | `output/screenshots/<descriptor>-<device>-<timestamp>/` | Device screen captures |
| Test log | `output/logs/test-output-<timestamp>.log` | Full test execution log |
| APDU log | `output/logs/apdu-log-<timestamp>.txt` | Raw APDU exchanges |
| Parsed APDU | `output/logs/apdu-log-<timestamp>.parsed.txt` | Human-readable APDU log |

## Troubleshooting

### "GATING_TOKEN not set"

Set the environment variable before running tests:

```bash
export GATING_TOKEN='your-token-here'
```

### "coin-apps clone failed"

You need access to the private `LedgerHQ/coin-apps` repository. Contact your Ledger administrator for access.

### Docker permission errors

Ensure your user is in the docker group:

```bash
sudo usermod -aG docker $USER
# Log out and back in for changes to take effect
```

### pnpm not found

Install pnpm globally:

```bash
npm install -g pnpm
```

### Connection refused errors

The Speculos emulator may not have started correctly. Try:

1. Ensure Docker is running: `docker ps`
2. Pull the latest Speculos image: `docker pull ghcr.io/ledgerhq/speculos`
3. Check for port conflicts on ports 5000-5001

### Build errors during setup

If `pnpm build:libs` fails, try:

```bash
cd dmk
pnpm install --force
pnpm build:libs
```

Some warnings about `rozenite` or other devtools packages can be safely ignored.

## Understanding Test Results

### Success

```
✅ Tests passed!
```

All test cases in the test file were validated successfully.

### Failure

```
❌ Tests failed with exit code: 1
```

Check the test output log and APDU log for details. Common failure reasons:

1. **INVALID_DATA (6a80)** - The descriptor format doesn't match what the device expects
2. **Schema hash mismatch** - The EIP-712 types in the test don't match the descriptor
3. **Missing filters** - Required fields are not properly filtered for display

### Analyzing APDU Errors

Use the parsed APDU log to identify where failures occur:

```bash
# Find error responses
grep "INVALID_DATA" output/logs/apdu-log-*.parsed.txt

# See the command that caused the error
grep -B3 "INVALID_DATA" output/logs/apdu-log-*.parsed.txt
```

## References

- [ERC-7730 Specification](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7730.md)
- [clear-signing-tester](https://github.com/LedgerHQ/device-sdk-ts/tree/develop/apps/clear-signing-tester)
- [Ethereum App Documentation](https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/ethapp.adoc)
- [Speculos Emulator](https://github.com/LedgerHQ/speculos)
