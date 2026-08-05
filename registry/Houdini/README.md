# Houdini Identity NFT - ERC-7730 Clear Signing Integration

## Overview

This directory contains the ERC-7730 metadata files for enabling Ledger Clear Signing support for the HoudiniIdentityNFT contract.

## Contract Information

- **Contract Name**: HoudiniIdentityNFT
- **Deployed Address**: `0x116938bFd313667f9beFCB762CeD66445b62dC65`
- **Network**: 0G Testnet (Chain ID: 16602)
- **Purpose**: Soulbound identity NFTs linked to 0G Storage profiles

## Features

### Supported Functions

**mintIdentity(string og0RootHash, uint8 profileType)**
- Mints a new soulbound identity NFT
- Parameters:
  - `og0RootHash`: 64-character 0G Storage root hash
  - `profileType`: 0=Personal, 1=Project, 2=DAO

**updateIdentity(uint256 tokenId, string newOg0RootHash)**
- Updates existing NFT metadata
- Parameters:
  - `tokenId`: NFT ID to update
  - `newOg0RootHash`: New 64-character 0G Storage hash

## Clear Signing Display

### Mint Transaction
```
Intent: Mint Identity NFT
0G Storage Hash: abc123...def456
Profile Type: Personal Identity
```

### Update Transaction
```
Intent: Update Profile
NFT Token ID: 1
New 0G Storage Hash: fed456...cba123
```

## Files

- **calldata-HoudiniIdentityNFT.json**: Main ERC-7730 metadata file
- **tests/**: Test transaction vectors for validation

## Ledger Registry Submission

### Prerequisites
1. Python 3.12+ (for validation tools)
2. Install erc7730: `pip install erc7730`

### Validation
```bash
# Lint the JSON file
erc7730 lint calldata-HoudiniIdentityNFT.json

# Format the file
erc7730 format calldata-HoudiniIdentityNFT.json

# Run tests
erc7730 test .
```

### Submission Process
1. Fork: https://github.com/LedgerHQ/clear-signing-erc7730-registry
2. Create directory: `/registry/Houdini/`
3. Copy files:
   - `calldata-HoudiniIdentityNFT.json`
   - `tests/` directory
   - This `README.md`
4. Submit Pull Request
5. Ensure email matches `metadata.owner` field
6. Wait for CI checks and Ledger review

## Project Links

- **GitHub**: https://github.com/yourusername/houdini
- **Contract Explorer**: https://explorer-testnet.0g.ai/address/0x116938bFd313667f9beFCB762CeD66445b62dC65
- **Documentation**: https://yourdomain.com/docs

## Contact

- **Owner**: houdini-protocol
- **Legal Name**: Houdini Identity NFT
- **Support**: your-email@example.com
