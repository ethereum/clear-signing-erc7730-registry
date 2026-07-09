# Ledger Clear Signing (ERC-7730) Submission Guide

## Prerequisites

### 1. Python Environment
```bash
# Check Python version (requires 3.12+)
python3 --version

# If needed, install Python 3.12
# macOS with Homebrew:
brew install python@3.12

# Ubuntu/Debian:
sudo apt install python3.12
```

### 2. Install ERC-7730 Tools
```bash
pip install erc7730
```

### 3. Verify Installation
```bash
erc7730 --version
```

## Validation Steps

### Step 1: Lint the JSON File
```bash
cd /Users/felix/Documents/ethglobal/arjantin/erc7730
erc7730 lint calldata-HoudiniIdentityNFT.json
```

**Expected Output:**
```
✓ Schema validation passed
✓ ABI validation passed
✓ Display format validation passed
✓ No errors found
```

### Step 2: Format the File
```bash
erc7730 format calldata-HoudiniIdentityNFT.json
```

This will standardize indentation and ordering.

### Step 3: Generate Test Vectors (Optional)
If you need to generate actual hex data for test vectors:

```bash
cd ../hardhat
npx hardhat run scripts/generate-test-vectors.js
```

This will output encoded transaction data that can be added to the test JSON files.

## GitHub Submission Process

### Step 1: Fork the Registry
1. Go to: https://github.com/LedgerHQ/clear-signing-erc7730-registry
2. Click "Fork" in the top right
3. Clone your fork:
```bash
git clone https://github.com/YOUR_USERNAME/clear-signing-erc7730-registry.git
cd clear-signing-erc7730-registry
```

### Step 2: Create Project Directory
```bash
mkdir -p registry/Houdini
cd registry/Houdini
```

### Step 3: Copy Files
```bash
# Copy from your project
cp /Users/felix/Documents/ethglobal/arjantin/erc7730/calldata-HoudiniIdentityNFT.json .
cp -r /Users/felix/Documents/ethglobal/arjantin/erc7730/tests .
cp /Users/felix/Documents/ethglobal/arjantin/erc7730/README.md .
```

### Step 4: Commit and Push
```bash
git add .
git commit -m "Add ERC-7730 metadata for Houdini Identity NFT on 0G Testnet"
git push origin main
```

### Step 5: Create Pull Request
1. Go to your fork on GitHub
2. Click "Contribute" → "Open pull request"
3. Title: "Add Houdini Identity NFT (0G Testnet)"
4. Description template:
```markdown
## Project Information
- **Contract Name**: HoudiniIdentityNFT
- **Network**: 0G Testnet (Chain ID: 16602)
- **Contract Address**: 0x116938bFd313667f9beFCB762CeD66445b62dC65
- **Explorer**: https://explorer-testnet.0g.ai/address/0x116938bFd313667f9beFCB762CeD66445b62dC65

## Description
Soulbound identity NFTs that link on-chain identities to AI-readable profiles stored on 0G Storage.

## Functions Covered
- `mintIdentity(string, uint8)`: Mint new identity NFT
- `updateIdentity(uint256, string)`: Update NFT metadata

## Verification
- [x] JSON passes `erc7730 lint`
- [x] Test vectors included
- [x] Email matches metadata.owner
- [x] Contract deployed and verified

## Contact
- **Owner**: houdini-protocol
- **Email**: your-email@example.com
```

### Step 6: Monitor CI Checks
GitHub Actions will automatically run:
- Schema validation
- ABI compatibility check
- Test vector verification
- Ownership verification (email match)

**Common CI Failures:**
- ❌ **Schema validation failed**: Check JSON syntax
- ❌ **ABI mismatch**: Ensure ABI in JSON matches deployed contract
- ❌ **Ownership mismatch**: Commit email must match `metadata.owner`

### Step 7: Address Review Comments
Ledger team will review within 2-7 days. They may request:
- Clarification on enum labels
- Additional test vectors
- Documentation improvements

### Step 8: Merge and Deployment
Once approved:
1. Ledger team merges your PR
2. Files automatically deploy to Ledger's CDN
3. Available in Ledger Live within 24 hours
4. Compatible wallets (MetaMask, Rabby) receive updates

## Post-Submission Testing

### Test with Ledger Device
```bash
# Connect your Ledger Nano S Plus/X/Stax
# Open Ethereum app
# Use your dApp to trigger a mint transaction
# Verify Ledger screen shows:
# - "Mint Identity NFT"
# - "0G Storage Hash: abc123..."
# - "Profile Type: Personal Identity"
```

### Test with Multiple Wallets
- **Ledger Live**: Direct support
- **MetaMask + Ledger**: Clear signing via hardware wallet
- **Rabby + Ledger**: Enhanced security mode
- **Rainbow**: Hardware wallet integration

## Troubleshooting

### Python Version Issues
```bash
# Use pyenv to manage multiple Python versions
brew install pyenv
pyenv install 3.12.0
pyenv local 3.12.0
pip install erc7730
```

### Validation Errors
**Error**: `enum reference 'ProfileType' not found`
- **Fix**: Ensure `metadata.constants.ProfileType` is defined

**Error**: `Function signature mismatch`
- **Fix**: Update ABI from latest compiled contract

**Error**: `Invalid chainId format`
- **Fix**: Use string format: `"16602"` not `16602`

### CI Failures
**Email mismatch**:
```bash
# Configure git email to match metadata.owner
git config user.email "your-verified-email@example.com"
git commit --amend --reset-author
git push --force
```

## Support

- **ERC-7730 Spec**: https://eips.ethereum.org/EIPS/eip-7730
- **Ledger Registry**: https://github.com/LedgerHQ/clear-signing-erc7730-registry
- **Ledger Discord**: https://discord.gg/Ledger
- **Documentation**: https://developers.ledger.com/docs/clear-signing

## Timeline

- **JSON Creation**: 2-4 hours
- **Validation**: 30 minutes
- **PR Submission**: 30 minutes
- **Ledger Review**: 2-7 days
- **Deployment**: 24 hours after merge
- **Total**: 1-2 weeks from start to production
