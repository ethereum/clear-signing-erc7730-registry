#!/bin/bash
# Clear Signing Tester - Local Setup Script
# This script clones and builds the necessary repositories for local testing
#
# Usage: ./setup.sh
#
# Requirements:
#   - Git access to LedgerHQ/coin-apps (private repository)
#   - Docker installed and running
#   - Node.js v18+ and pnpm

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "============================================"
echo -e "${BLUE}Clear Signing Tester - Local Setup${NC}"
echo "============================================"
echo ""

# Check for required tools
echo "Checking prerequisites..."
command -v git >/dev/null 2>&1 || { echo -e "${RED}❌ git is required${NC}"; exit 1; }
command -v node >/dev/null 2>&1 || { echo -e "${RED}❌ node is required${NC}"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo -e "${RED}❌ pnpm is required. Install with: npm install -g pnpm${NC}"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo -e "${RED}❌ docker is required${NC}"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo -e "${RED}❌ jq is required${NC}"; exit 1; }
echo -e "${GREEN}✅ All prerequisites found${NC}"
echo ""

# Clone device-sdk-ts if not exists
if [ ! -d "dmk" ]; then
    echo -e "${BLUE}📦 Cloning device-sdk-ts...${NC}"
    git clone --depth 1 --branch develop https://github.com/LedgerHQ/device-sdk-ts.git dmk
else
    echo -e "${BLUE}📦 device-sdk-ts already cloned, pulling latest...${NC}"
    cd dmk && git pull && cd ..
fi
echo ""

# Clone coin-apps if not exists (requires access)
if [ ! -d "coin-apps" ]; then
    echo -e "${BLUE}📦 Cloning coin-apps (private repo - requires access)...${NC}"
    echo "   This may prompt for authentication..."
    git clone --depth 1 --branch master https://github.com/LedgerHQ/coin-apps.git coin-apps \
        --sparse --filter=blob:none
    cd coin-apps
    # Use non-cone mode for wildcard patterns
    git sparse-checkout set --no-cone 'flex/*/Ethereum/*.elf' 'stax/*/Ethereum/*.elf' 'nanosp/*/Ethereum/*.elf' 'nanox/*/Ethereum/*.elf'
    cd ..
else
    echo -e "${BLUE}📦 coin-apps already cloned${NC}"
fi
echo ""

# Install and build DMK
echo -e "${BLUE}🔨 Installing dependencies and building DMK...${NC}"
cd dmk
pnpm install

# Build libraries - some devtools (rozenite) may fail on Node.js < 20, but are not needed
echo -e "${YELLOW}Building libraries (some devtools warnings can be ignored)...${NC}"
pnpm build:libs || {
    echo -e "${YELLOW}⚠️  Some packages failed to build (likely rozenite devtools requiring Node.js 20+)${NC}"
    echo -e "${YELLOW}   This is OK - the clear-signing-tester will still work.${NC}"
}
cd ..
echo ""

# Pull Speculos Docker image
echo -e "${BLUE}🐳 Pulling Speculos Docker image...${NC}"
docker pull ghcr.io/ledgerhq/speculos
echo ""

echo "============================================"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "1. Set your GATING_TOKEN environment variable:"
echo -e "   ${YELLOW}export GATING_TOKEN='your-token-here'${NC}"
echo ""
echo "2. Run tests using the run-test.sh script:"
echo -e "   ${YELLOW}./run-test.sh <descriptor-file> <test-file> [device] [log-level]${NC}"
echo ""
echo "Example:"
echo "   ./run-test.sh \\"
echo "       ../../registry/circle/eip712-TransferWithAuthorization.json \\"
echo "       ../../registry/circle/tests/eip712-TransferWithAuthorization.tests.json \\"
echo "       flex"
echo ""
