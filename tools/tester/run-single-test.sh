#!/bin/bash
# Run a single test from a test file by index
#
# Usage: ./run-single-test.sh <descriptor-file> <test-file> <test-index> [device] [log-level]
#
# Arguments:
#   descriptor-file  Path to the ERC-7730 descriptor JSON file
#   test-file        Path to the test JSON file (*.tests.json)
#   test-index       0-based index of the test to run (or "list" to show all tests)
#   device           Device to emulate: flex, stax, nanosp, nanox (default: flex)
#   log-level        Log level: none, error, warn, info, debug (default: info)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse arguments
DESCRIPTOR_FILE="$1"
TEST_FILE="$2"
TEST_INDEX="$3"
DEVICE="${4:-flex}"
LOG_LEVEL="${5:-info}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_usage() {
    echo "Usage: $0 <descriptor-file> <test-file> <test-index> [device] [log-level]"
    echo ""
    echo "Arguments:"
    echo "  descriptor-file  Path to the ERC-7730 descriptor JSON file"
    echo "  test-file        Path to the test JSON file (*.tests.json)"
    echo "  test-index       0-based index of the test to run (or 'list' to show all tests)"
    echo "  device           Device to emulate: flex, stax, nanosp, nanox (default: flex)"
    echo "  log-level        Log level: none, error, warn, info, debug (default: info)"
    echo ""
    echo "Examples:"
    echo "  # List all tests in a file"
    echo "  $0 ../../registry/circle/eip712-TransferWithAuthorization.json \\"
    echo "     ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json list"
    echo ""
    echo "  # Run the first test (index 0)"
    echo "  $0 ../../registry/circle/eip712-TransferWithAuthorization.json \\"
    echo "     ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json 0 flex"
}

if [ -z "$DESCRIPTOR_FILE" ] || [ -z "$TEST_FILE" ] || [ -z "$TEST_INDEX" ]; then
    echo -e "${RED}Error: Missing required arguments${NC}"
    echo ""
    print_usage
    exit 1
fi

# Resolve paths
if [[ "$TEST_FILE" != /* ]]; then
    TEST_FILE="$SCRIPT_DIR/$TEST_FILE"
fi

if [ ! -f "$TEST_FILE" ]; then
    echo -e "${RED}Error: Test file not found: $TEST_FILE${NC}"
    exit 1
fi

# List mode - show all tests with their indices
if [ "$TEST_INDEX" = "list" ]; then
    echo -e "${BLUE}Tests in $TEST_FILE:${NC}"
    echo "--------------------------------------------"
    jq -r '.tests | to_entries | .[] | "[\(.key)] \(.value.description // "No description")"' "$TEST_FILE"
    echo "--------------------------------------------"
    TOTAL=$(jq '.tests | length' "$TEST_FILE")
    echo -e "Total: ${GREEN}$TOTAL${NC} tests"
    exit 0
fi

# Validate test index is a number
if ! [[ "$TEST_INDEX" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Test index must be a number or 'list'${NC}"
    exit 1
fi

# Check if test index exists
TOTAL=$(jq '.tests | length' "$TEST_FILE")
if [ "$TEST_INDEX" -ge "$TOTAL" ]; then
    echo -e "${RED}Error: Test index $TEST_INDEX out of range (0-$((TOTAL-1)))${NC}"
    exit 1
fi

# Get test description
TEST_DESC=$(jq -r ".tests[$TEST_INDEX].description // \"Test $TEST_INDEX\"" "$TEST_FILE")
echo -e "${BLUE}Running single test:${NC}"
echo -e "  Index:       ${GREEN}$TEST_INDEX${NC}"
echo -e "  Description: ${GREEN}$TEST_DESC${NC}"
echo ""

# Create temporary test file with just the single test
TEMP_TEST_FILE=$(mktemp)
jq "{tests: [.tests[$TEST_INDEX]]}" "$TEST_FILE" > "$TEMP_TEST_FILE"

# Run the test
"$SCRIPT_DIR/run-test.sh" "$DESCRIPTOR_FILE" "$TEMP_TEST_FILE" "$DEVICE" "$LOG_LEVEL"
EXIT_CODE=$?

# Cleanup
rm -f "$TEMP_TEST_FILE"

exit $EXIT_CODE
