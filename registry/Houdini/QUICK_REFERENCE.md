# Ledger Clear Signing - Quick Reference Card

## What is Ledger Clear Signing?

Ledger Clear Signing (ERC-7730) transforms transaction data from unreadable hex strings into human-readable text on your Ledger hardware wallet screen.

## Before vs After

### ❌ Without Clear Signing (Blind Signing)
```
Ledger Screen:
⚠️ WARNING: Blind Signing
Data: 0x23b872dd00000000000000...
Value: 0 ETH
[Approve] [Reject]
```
**Problem**: You can't verify what you're signing!

### ✅ With Clear Signing (ERC-7730)
```
Ledger Screen:
Intent: Mint Identity NFT
─────────────────────────
0G Storage Hash:
  abc123...def456
─────────────────────────
Profile Type:
  Personal Identity
─────────────────────────
[✓ Approve] [✗ Reject]
```
**Benefit**: You see exactly what you're signing!

## Supported Functions

### 1. Mint Identity NFT
**Function**: `mintIdentity(string, uint8)`

**What You'll See:**
- **Intent**: "Mint Identity NFT"
- **0G Storage Hash**: Your profile's 64-character hash
- **Profile Type**: "Personal Identity", "Project Identity", or "DAO Identity"

**Example Transaction:**
```
Intent: Mint Identity NFT
0G Storage Hash: 1a2b3c...4d5e6f
Profile Type: Project Identity
```

### 2. Update Profile
**Function**: `updateIdentity(uint256, string)`

**What You'll See:**
- **Intent**: "Update Profile"
- **NFT Token ID**: Your NFT's ID number
- **New 0G Storage Hash**: Updated profile hash

**Example Transaction:**
```
Intent: Update Profile
NFT Token ID: 42
New 0G Storage Hash: 7f8e9d...c6b5a4
```

## Security Benefits

### 🔒 Protection Against Phishing
- **Before**: Malicious dApp shows "Claim Airdrop" but actually drains your wallet
- **After**: Ledger screen shows real function name, preventing deception

### ✅ Transaction Verification
- Verify **exactly** what contract function is being called
- Confirm **all parameters** before signing
- No more blind trust in website UI

### 🛡️ Defense in Depth
- Even if your computer is compromised, Ledger shows truth
- Malware cannot alter what you see on Ledger screen
- Physical device confirmation required

## Compatibility

### Supported Wallets
| Wallet | Status | Notes |
|--------|--------|-------|
| Ledger Live | ✅ Native | Full support after registry approval |
| MetaMask | ✅ Via hardware | Connect Ledger as hardware wallet |
| Rabby | ✅ Via hardware | Enhanced security mode |
| Rainbow | ✅ Via hardware | Hardware wallet integration |

### Supported Devices
- ✅ Ledger Nano S Plus
- ✅ Ledger Nano X
- ✅ Ledger Stax
- ✅ Ledger Flex
- ❌ Ledger Nano S (legacy, limited memory)

## Current Status

**Implementation:** ✅ Complete
**Registry Submission:** ⏳ Pending
**Ledger Review:** ⏳ 2-7 days
**Production:** ⏳ Available after approval

## How to Use (Once Live)

### Step 1: Connect Ledger
1. Plug in your Ledger device
2. Enter PIN
3. Open Ethereum app
4. Connect to Houdini dApp

### Step 2: Initiate Transaction
1. Create or update your identity profile
2. Click "Generate On-chain Identity NFT"
3. Wait for Ledger prompt

### Step 3: Verify on Ledger Screen
1. Read the **Intent** (e.g., "Mint Identity NFT")
2. Verify the **0G Storage Hash** matches your profile
3. Confirm the **Profile Type** is correct
4. Press both buttons to approve

### Step 4: Transaction Complete
- Wait for blockchain confirmation
- NFT will appear in your wallet
- Ledger shows "Transaction Signed" ✓

## Troubleshooting

### "Blind Signing" Warning Appears
**Cause**: ERC-7730 metadata not yet approved by Ledger
**Solution**: Wait for registry submission approval, or proceed with caution

### Wrong Profile Type Shows
**Cause**: Incorrect parameter in frontend
**Solution**: Cancel transaction, report bug to Houdini team

### Hash Doesn't Match
**Cause**: Possible MITM attack or frontend compromise
**Solution**: **DO NOT APPROVE**. Close browser, scan for malware

## FAQ

**Q: Is Clear Signing mandatory?**
A: No, but highly recommended for security. You can still use blind signing (with warnings).

**Q: Does this work on all chains?**
A: Currently only 0G Testnet (Chain ID: 16602). More chains can be added to the same ERC-7730 file.

**Q: What if I don't have a Ledger?**
A: Clear Signing only benefits Ledger users. Other users see normal wallet prompts.

**Q: Can I verify the hash on-chain?**
A: Yes! After minting, check the NFT metadata on 0G Explorer to confirm the hash matches what you approved.

## Technical Details

**Standard**: ERC-7730 (Structured Data Clear Signing Format)
**Contract**: HoudiniIdentityNFT at `0x116938bFd313667f9beFCB762CeD66445b62dC65`
**Network**: 0G Testnet (Chain ID: 16602)
**Metadata Location**: https://github.com/LedgerHQ/clear-signing-erc7730-registry

## Learn More

- **ERC-7730 Spec**: https://eips.ethereum.org/EIPS/eip-7730
- **Ledger Documentation**: https://developers.ledger.com/docs/clear-signing
- **Houdini Docs**: See `/erc7730/SUBMISSION_GUIDE.md`
- **Security Best Practices**: Always verify on Ledger screen before approving

---

**Remember**: Your Ledger device is your last line of defense. Always read carefully before signing! 🔐
