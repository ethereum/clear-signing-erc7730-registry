#!/bin/bash
# ERC-7730 Analyzer - Local Setup Script
# This script clones the erc7730-analyzer repo and installs its dependencies
#
# Usage: ./setup.sh
#
# Requirements:
#   - Python 3.12+
#   - uv (recommended) or pip

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
echo -e "${BLUE}ERC-7730 Analyzer - Local Setup${NC}"
echo "============================================"
echo ""

# Check for required tools
echo "Checking prerequisites..."
command -v git >/dev/null 2>&1 || { echo -e "${RED}❌ git is required${NC}"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo -e "${RED}❌ python3 is required${NC}"; exit 1; }

# Check Python version (needs 3.12+)
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PYTHON_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
if [[ "$PYTHON_MAJOR" -lt 3 ]] || { [[ "$PYTHON_MAJOR" -eq 3 ]] && [[ "$PYTHON_MINOR" -lt 12 ]]; }; then
    echo -e "${RED}❌ Python 3.12+ is required (found $PYTHON_VERSION)${NC}"
    exit 1
fi

# Check for uv
USE_UV=false
if command -v uv >/dev/null 2>&1; then
    USE_UV=true
    echo -e "${GREEN}✅ All prerequisites found (Python $PYTHON_VERSION, uv)${NC}"
else
    echo -e "${YELLOW}⚠️  uv not found, falling back to pip${NC}"
    echo -e "${GREEN}✅ Prerequisites found (Python $PYTHON_VERSION)${NC}"
fi
echo ""

# Clone erc7730-analyzer if not exists
if [ ! -d "erc7730-analyzer" ]; then
    echo -e "${BLUE}📦 Cloning erc7730-analyzer...${NC}"
    git clone --depth 1 https://github.com/LedgerHQ/erc7730-analyzer.git erc7730-analyzer
else
    echo -e "${BLUE}📦 erc7730-analyzer already cloned, pulling latest...${NC}"
    cd erc7730-analyzer && git pull && cd ..
fi
echo ""

# Install dependencies
cd erc7730-analyzer

if [ "$USE_UV" = true ]; then
    echo -e "${BLUE}📥 Installing dependencies with uv...${NC}"
    uv sync
else
    echo -e "${BLUE}🐍 Creating virtual environment...${NC}"
    if [ ! -d ".venv" ]; then
        python3 -m venv .venv
    fi
    source .venv/bin/activate
    echo -e "${BLUE}📥 Installing dependencies with pip...${NC}"
    pip install -e .
fi

cd ..
echo ""

# Check for required environment variables
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

echo -e "${BLUE}🔑 Checking environment variables...${NC}"
MISSING_VARS=false

if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE" 2>/dev/null || true
fi

if [ -z "$ETHERSCAN_API_KEY" ]; then
    echo -e "${YELLOW}⚠️  ETHERSCAN_API_KEY is not set (required for fetching ABI and transactions)${NC}"
    MISSING_VARS=true
fi

if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${YELLOW}⚠️  No LLM API key found (set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use --backend cursor)${NC}"
    MISSING_VARS=true
else
    if [ -n "$OPENAI_API_KEY" ]; then
        echo -e "${GREEN}✅ OPENAI_API_KEY is set${NC}"
    fi
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        echo -e "${GREEN}✅ ANTHROPIC_API_KEY is set${NC}"
    fi
fi

if [ "$MISSING_VARS" = true ]; then
    echo -e "${YELLOW}   Add missing keys to the .env file at the repository root${NC}"
else
    echo -e "${GREEN}✅ Required environment variables are set${NC}"
fi
echo ""

echo "============================================"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo "============================================"
echo ""
echo "Usage:"
echo ""
echo "1. Source the .env file (for API keys):"
echo -e "   ${YELLOW}source .env${NC}"
echo ""
if [ "$USE_UV" = true ]; then
    echo "2. Run the analyzer:"
    echo -e "   ${YELLOW}cd tools/analyzer/erc7730-analyzer${NC}"
    echo -e "   ${YELLOW}uv run analyze_7730 --erc7730_file <path-to-descriptor>${NC}"
    echo ""
    echo "Example:"
    echo -e "   ${YELLOW}uv run analyze_7730 --erc7730_file ../../../registry/uniswap/calldata-UniswapV3Router.json${NC}"
else
    echo "2. Activate the virtual environment and run the analyzer:"
    echo -e "   ${YELLOW}source tools/analyzer/erc7730-analyzer/.venv/bin/activate${NC}"
    echo -e "   ${YELLOW}analyze_7730 --erc7730_file <path-to-descriptor>${NC}"
    echo ""
    echo "Example:"
    echo -e "   ${YELLOW}analyze_7730 --erc7730_file registry/uniswap/calldata-UniswapV3Router.json${NC}"
fi
echo ""
echo "Options:"
echo -e "   ${YELLOW}--backend <name>${NC}     LLM backend: openai, anthropic, cursor (default: openai)"
echo -e "   ${YELLOW}--model <model>${NC}      Model name (default depends on backend)"
echo -e "   ${YELLOW}--debug${NC}              Enable debug output"
echo -e "   ${YELLOW}--lookback-days 30${NC}   Custom transaction lookback period"
echo ""
echo "Backend examples:"
echo -e "   ${YELLOW}--backend anthropic --model claude-sonnet-4-20250514${NC}"
echo -e "   ${YELLOW}--backend cursor${NC}     (no API key needed)"
echo ""
echo "Reports are saved to tools/analyzer/erc7730-analyzer/output/"
echo ""
