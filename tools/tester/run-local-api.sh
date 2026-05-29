#!/bin/bash
# Clear Signing Tester - Local ERC7730 API Server
#
# Runs the Flask API server locally using the patched erc7730 Python tool
# from tools/linter/python-erc7730/ instead of the remote service.
#
# Usage:
#   ./run-local-api.sh [port]
#
# Arguments:
#   port    Port to run the server on (default: 5000)
#
# Then in another terminal, run tests with:
#   ERC7730_API_URL=http://localhost:5000 ./run-test.sh <descriptor> <test-file> [device]
#
# Prerequisites:
#   - Python 3.12+ with linter venv set up: cd tools/linter && ./setup.sh
#   - The patched erc7730 installed in the venv

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LINTER_DIR="$ROOT_DIR/tools/linter"
VENV_DIR="$LINTER_DIR/.venv"
API_SCRIPT="$SCRIPT_DIR/dmk/apps/sample/api/index.py"
PORT="${1:-5000}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "============================================"
echo -e "${BLUE}ERC7730 Local API Server${NC}"
echo "============================================"
echo ""

# Check prerequisites
if [ ! -d "$VENV_DIR" ]; then
    echo -e "${RED}Error: Linter venv not found at $VENV_DIR${NC}"
    echo "Run: cd tools/linter && ./setup.sh"
    exit 1
fi

if [ ! -f "$API_SCRIPT" ]; then
    echo -e "${RED}Error: API script not found at $API_SCRIPT${NC}"
    echo "Run: cd tools/tester && ./setup.sh"
    exit 1
fi

# Activate the venv
source "$VENV_DIR/bin/activate"

# Check that patched erc7730 is installed
ERC7730_VERSION=$(pip show erc7730 2>/dev/null | grep "^Version:" | awk '{print $2}')
ERC7730_LOCATION=$(pip show erc7730 2>/dev/null | grep "^Location:" | awk '{print $2}')
if [ -z "$ERC7730_VERSION" ]; then
    echo -e "${RED}Error: erc7730 not installed in venv${NC}"
    echo "Install the patched version:"
    echo "  source $VENV_DIR/bin/activate"
    echo "  pip install -e $ROOT_DIR/tools/linter/python-erc7730"
    exit 1
fi
echo -e "erc7730 version: ${GREEN}$ERC7730_VERSION${NC}"
echo -e "erc7730 location: ${GREEN}$ERC7730_LOCATION${NC}"

# Install Flask API dependencies if missing
echo ""
echo -e "${BLUE}Checking API dependencies...${NC}"
MISSING_DEPS=()

python3 -c "import flask" 2>/dev/null || MISSING_DEPS+=("flask")
python3 -c "import ecdsa" 2>/dev/null || MISSING_DEPS+=("ecdsa")

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Installing missing dependencies: ${MISSING_DEPS[*]}${NC}"
    pip install "${MISSING_DEPS[@]}"
    echo ""
fi
echo -e "${GREEN}All dependencies ready${NC}"

# Source .env for ETHERSCAN_API_KEY if available
if [ -f "$ROOT_DIR/.env" ]; then
    echo ""
    echo -e "${BLUE}Loading environment from .env${NC}"
    source "$ROOT_DIR/.env"
fi

echo ""
echo "============================================"
echo -e "${GREEN}Starting API server on port $PORT${NC}"
echo "============================================"
echo ""
echo "Use in another terminal:"
echo -e "  ${YELLOW}export ERC7730_API_URL=http://localhost:$PORT${NC}"
echo -e "  ${YELLOW}./run-test.sh <descriptor> <test-file> [device]${NC}"
echo ""
echo "Or with the batch processor / generate-tests:"
echo -e "  ${YELLOW}ERC7730_API_URL=http://localhost:$PORT source .env && node tools/scripts/batch-process.js figment${NC}"
echo ""
echo -e "Press ${RED}Ctrl+C${NC} to stop the server."
echo ""

# Run the Flask server
cd "$(dirname "$API_SCRIPT")"
FLASK_APP="index.py" python3 -m flask run --host 0.0.0.0 --port "$PORT"
