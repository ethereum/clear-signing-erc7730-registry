#!/bin/bash
# Clear Signing Tester - Run Tests Script
#
# Usage: ./run-test.sh <descriptor-file> <test-file> [device] [log-level]
#
# Arguments:
#   descriptor-file  Path to the ERC-7730 descriptor JSON file
#   test-file        Path to the test JSON file (*.tests.json)
#   device           Device to emulate: flex, stax, nanosp, nanox (default: flex)
#   log-level        Log level: none, error, warn, info, debug (default: info)
#
# Environment variables:
#   GATING_TOKEN     Required. Ledger authentication token
#   ERC7730_API_URL  Optional. Override the ERC7730 API URL (default: remote service)
#                    Set to http://localhost:5000 to use local patched erc7730.
#                    Start local server with: ./run-local-api.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SCRIPT_DIR"

# Parse arguments
DESCRIPTOR_FILE="$1"
TEST_FILE="$2"
DEVICE="${3:-flex}"
LOG_LEVEL="${4:-info}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_usage() {
    echo "Usage: $0 <descriptor-file> <test-file> [device] [log-level]"
    echo ""
    echo "Arguments:"
    echo "  descriptor-file  Path to the ERC-7730 descriptor JSON file"
    echo "  test-file        Path to the test JSON file (*.tests.json)"
    echo "  device           Device to emulate: flex, stax, nanosp, nanox (default: flex)"
    echo "  log-level        Log level: none, error, warn, info, debug (default: info)"
    echo ""
    echo "Environment variables:"
    echo "  GATING_TOKEN     Required. Ledger authentication token"
    echo ""
    echo "Example:"
    echo "  export GATING_TOKEN='your-token'"
    echo "  $0 ../../registry/circle/eip712-TransferWithAuthorization.json \\"
    echo "     ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json \\"
    echo "     flex"
    echo ""
    echo "Or use relative paths from registry root:"
    echo "  $0 \$REGISTRY_DIR/registry/circle/eip712-TransferWithAuthorization.json \\"
    echo "     \$REGISTRY_DIR/registry/circle/tests/eip712-TransferWithAuthorization.tests.json \\"
    echo "     flex"
}

if [ -z "$DESCRIPTOR_FILE" ] || [ -z "$TEST_FILE" ]; then
    echo -e "${RED}Error: Missing required arguments${NC}"
    echo ""
    print_usage
    exit 1
fi

if [ -z "$GATING_TOKEN" ]; then
    echo -e "${RED}Error: GATING_TOKEN environment variable not set${NC}"
    echo ""
    echo "Set it with: export GATING_TOKEN='your-token-here'"
    exit 1
fi

# Resolve paths (support both absolute and relative)
if [[ "$DESCRIPTOR_FILE" != /* ]]; then
    DESCRIPTOR_FILE="$SCRIPT_DIR/$DESCRIPTOR_FILE"
fi
if [[ "$TEST_FILE" != /* ]]; then
    TEST_FILE="$SCRIPT_DIR/$TEST_FILE"
fi

# Validate files exist
if [ ! -f "$DESCRIPTOR_FILE" ]; then
    echo -e "${RED}Error: Descriptor file not found: $DESCRIPTOR_FILE${NC}"
    exit 1
fi

if [ ! -f "$TEST_FILE" ]; then
    echo -e "${RED}Error: Test file not found: $TEST_FILE${NC}"
    exit 1
fi

# Check if DMK is set up
if [ ! -d "dmk" ]; then
    echo -e "${RED}Error: DMK not found. Run ./setup.sh first${NC}"
    exit 1
fi

# Determine test type from descriptor filename
DESCRIPTOR_NAME=$(basename "$DESCRIPTOR_FILE" .json)
if [[ "$DESCRIPTOR_NAME" == calldata-* ]]; then
    TEST_TYPE="calldata"
    CMD="raw-file"
elif [[ "$DESCRIPTOR_NAME" == eip712-* ]]; then
    TEST_TYPE="eip712"
    CMD="typed-data-file"
else
    echo -e "${YELLOW}Warning: Could not determine test type from filename, defaulting to eip712${NC}"
    TEST_TYPE="eip712"
    CMD="typed-data-file"
fi

echo "============================================"
echo -e "${BLUE}Clear Signing Tester${NC}"
echo "============================================"
echo ""
echo -e "Descriptor:  ${GREEN}$DESCRIPTOR_FILE${NC}"
echo -e "Test file:   ${GREEN}$TEST_FILE${NC}"
echo -e "Test type:   ${GREEN}$TEST_TYPE${NC}"
echo -e "Device:      ${GREEN}$DEVICE${NC}"
echo -e "Log level:   ${GREEN}$LOG_LEVEL${NC}"
if [ -n "$ERC7730_API_URL" ]; then
    echo -e "ERC7730 API: ${YELLOW}$ERC7730_API_URL${NC} (local)"
fi
echo ""

# Prepare output directories
OUTPUT_DIR="$SCRIPT_DIR/output"
mkdir -p "$OUTPUT_DIR/test-inputs" "$OUTPUT_DIR/screenshots" "$OUTPUT_DIR/logs"

# Prepare test input
echo -e "${BLUE}📋 Preparing test input...${NC}"
TESTS_JSON="$OUTPUT_DIR/test-inputs/tests-$(date +%s).json"
jq '.tests' "$TEST_FILE" > "$TESTS_JSON"
echo "   Created: $TESTS_JSON"
echo ""

# Get absolute paths
DESCRIPTOR_ABS=$(realpath "$DESCRIPTOR_FILE")
SCREENSHOT_DIR="$OUTPUT_DIR/screenshots/$(basename "$DESCRIPTOR_NAME")-$DEVICE-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SCREENSHOT_DIR"

echo -e "${BLUE}🧪 Running clear signing tests...${NC}"
echo "   Command: pnpm cs-tester cli $CMD"
echo "   Screenshots will be saved to: $SCREENSHOT_DIR"
echo ""
echo "--------------------------------------------"

# Run the tests
cd dmk
export COIN_APPS_PATH="$SCRIPT_DIR/coin-apps"

set +e
APDU_LOG="$OUTPUT_DIR/logs/apdu-log-$(date +%Y%m%d-%H%M%S).txt"
TEST_OUTPUT_LOG="$OUTPUT_DIR/logs/test-output-$(date +%Y%m%d-%H%M%S).log"

pnpm cs-tester cli "$CMD" "$TESTS_JSON" \
    --device "$DEVICE" \
    --erc7730-files "$DESCRIPTOR_ABS" \
    --screenshot-folder-path "$SCREENSHOT_DIR" \
    --log-level "$LOG_LEVEL" \
    --log-file "$APDU_LOG" \
    --file-log-level debug 2>&1 | tee "$TEST_OUTPUT_LOG"
EXIT_CODE=${PIPESTATUS[0]}
set -e

cd "$SCRIPT_DIR"

echo ""
echo "--------------------------------------------"
if [ "$EXIT_CODE" -eq 0 ]; then
    echo -e "${GREEN}✅ Tests passed!${NC}"
else
    echo -e "${RED}❌ Tests failed with exit code: $EXIT_CODE${NC}"
fi
echo ""
echo "Output files:"
echo "  Screenshots:  $SCREENSHOT_DIR"
echo "  Test log:     $TEST_OUTPUT_LOG"
echo "  APDU log:     $APDU_LOG"
echo ""

# Parse APDU log
PARSED_APDU_LOG="${APDU_LOG%.txt}.parsed.txt"
if [ -f "$APDU_LOG" ] && [ -f "$SCRIPT_DIR/parse-apdu.sh" ]; then
    echo -e "${BLUE}📊 Parsing APDU exchanges...${NC}"
    "$SCRIPT_DIR/parse-apdu.sh" "$APDU_LOG" "$PARSED_APDU_LOG"
    echo "  Parsed APDU:  $PARSED_APDU_LOG"
    echo ""
    
    # Show summary of APDU exchanges
    echo -e "${BLUE}📋 APDU Exchange Summary (last 20 lines):${NC}"
    echo "--------------------------------------------"
    tail -20 "$PARSED_APDU_LOG"
    echo ""
fi

# List screenshots if any
if [ -d "$SCREENSHOT_DIR" ] && [ "$(ls -A "$SCREENSHOT_DIR" 2>/dev/null)" ]; then
    echo -e "${BLUE}📸 Generated screenshots:${NC}"
    ls -la "$SCREENSHOT_DIR"/*.png 2>/dev/null || true
    echo ""
fi

exit $EXIT_CODE
