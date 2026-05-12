# Clear Signing Auditor Quick Start

**Your role:** Review ERC-7730 descriptors — the JSON files that tell Ethereum wallets what to display when users sign transactions — and publish a cryptographic attestation confirming your review.

---

## What you're committing to

- Review descriptors regularly, e.g. by adding this repo to your [Watch list](https://github.com/watching) and setting up [Notifications](https://github.com/settings/notifications)
- Publish a signed attestation (or open an issue) for each descriptor reviewed
- Maintain your attestation as descriptors evolve — new version = new attestation required

---

## Tooling

Most steps below use [`clearsig`](https://github.com/Cyfrin/clearsig), a CLI that implements ERC-7730 translation, ERC-8176 descriptor hashing, and ERC-8213 byte-level digests.

```bash
uv tool install clearsig    # or: pipx install clearsig / pip install clearsig
```

Subcommands referenced in this guide:
- `clearsig translate` — decode raw calldata using a descriptor (steps 3 and 5)
- `clearsig generate` — bootstrap a fresh descriptor from Sourcify, useful for cross-checking submissions (step 3)
- `clearsig descriptor-hash` (alias `dh`) — compute the ERC-8176 hash for attestation

By default `clearsig` uses the upstream registry at `~/.clearsig/registry`. When reviewing a PR, check out the PR branch locally and point `clearsig` at that checkout so translation uses the descriptor *under review* rather than the merged version:

```bash
git fetch origin pull/<PR-number>/head:pr-<PR-number>
git checkout pr-<PR-number>
export ERC7730_REGISTRY_PATH=$(pwd)
```

---

## The 5-step review

**1. Project check**
Find the project URL in the descriptor JSON. Confirm the protocol's purpose and that the PR submitter is plausibly affiliated.

**2. Contract verification**
Confirm the contract is verified at [repo.sourcify.dev](https://repo.sourcify.dev). Cross-check the contract address and ABI against the descriptor. If unverified — **do not sign**. For chains not supported by Sourcify, the PR description must include a link to the verified source on the chain's block explorer.

**3. Descriptor accuracy**
- Parameter names, types, and ordering match the ABI
- Function selectors are correct
- Intent fields reflect real user impact — no misleading simplifications
- Approvals, transfers, and privileged actions are correctly flagged
- Payable vs non-payable is accurate
- Cross-chain deployments are consistent

`clearsig generate --chain-id <N> --to <address> --owner <name>` produces a baseline descriptor from the verified Sourcify ABI (auto-traversing proxies to the implementation). Diffing the submitter's descriptor against this baseline surfaces missing functions, mis-typed parameters, and selector mismatches.

**4. Intent mutability**

A function's displayed intent can diverge from its executed behavior over time — through proxy upgrades, admin-controlled state changes, or branches on mutable storage.

**If the descriptor includes an `intentMutability` section** (per the proposed extension in [ethereum/ERCs#1738](https://github.com/ethereum/ERCs/pull/1738)):
- Verify each `(slot, expectedValue)` in `stateRefs` matches the current on-chain value (e.g., via `cast storage <address> <slot>` or an `eth_getStorageAt` RPC call).
- Verify the list is **exhaustive**: enumerate every storage slot that is both (a) read by any function in the descriptor and (b) writeable by a non-user actor (owner, admin, governance, proxy upgrade authority, delegatecall target). Slither's `read-state-variables` and permission detectors are useful starting points. Any writeable-read slot not declared in the descriptor is a missed vector — open a PR adding it, or **do not sign**.
- For `notes`-only declarations, confirm the prose accurately reflects the off-chain or compositional vectors.

**If the descriptor does NOT include an `intentMutability` section** (the ERC-7730 update has not landed yet):
- Enumerate the mutability vectors yourself using the same procedure as above.
- Publish your findings at a durable URL (your own GitHub, IPFS, etc.) describing each function, the slots that affect its intent, and the impact when those slots change.
- Include the audit URI in your attestation submission (in the PR description and, where the schema supports it, in the attestation envelope itself) so wallets and reviewers can discover it.
- If any vector meaningfully affects the displayed intent, flag it in the PR and decide whether to sign.

**5. Tester validation** *(dedicated Tester tool still in development)*

The dedicated Tester tool is not yet live. Until it ships, use `clearsig translate` (with `ERC7730_REGISTRY_PATH` pointing at the PR checkout, per the [Tooling](#tooling) section) to run sample transactions through the descriptor and confirm the rendered output is unambiguous:

```bash
clearsig translate <calldata> --to <contract_address> --chain-id <N>
```

Use a mix of normal-path transactions (the most common user actions) and edge cases (maximum values, zero values, special addresses). Confirm:
- The `intent` text matches what the function actually does.
- Each field's value is rendered correctly (amounts have correct decimals, tokens have correct tickers, addresses resolve to expected names).
- No fields are silently omitted.

---

## Submitting your attestation

After a full review passes, create an **EAS offchain attestation** (ERC-8176 schema):

- Calculate the descriptor hash:

`descriptorHash = keccak256(RFC 8785 JCS-canonicalized descriptor JSON)` — do not hash raw file bytes.

With `clearsig` installed:

```bash
clearsig descriptor-hash registry/<project>/<descriptorname>.json
# 0x...
```

- Go to [Ethereum Attestation Service](https://easscan.org/schema/view/0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2), select 'Attest with schema' and use 'Offchain'
- Sign the attestation
- Copy and save the raw attestation data on EAS as json file and submit it via PR to the registry at:

```
registry/<project>/sigs/<descriptorname>.eip155-1-0xYourAddress.json
```
If a sig folder does not exist, create one.

---

## Key rules

- Sign only after completing the full review
- Sign the **exact file version** you reviewed
- Never modify an existing attestation — issue a new one
- If issues are found: **do not sign** — open a GitHub issue instead
- If your key is compromised or you retract an attestation: submit a revocation on-chain via EAS
- If you have explicitly shared your key with wallets, notify them of the compromise

---

## Getting listed

Create `auditors/eip155-1-0xYourAddress/profile.json` and submit a PR:

```json
{
  "id": "eip155:1:0xYourAddress",
  "name": "Your Name",
  "ens": "yourname.eth",
  "organization": "Your Org"
}
```

`ens` and `organization` are optional. The folder name is your identifier. Wallets resolve your identity via ENS; revocation is handled via EAS — not this index.

---

*Registry: [github.com/ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry)*
