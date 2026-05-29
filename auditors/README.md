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

A function's displayed intent can diverge from its executed behavior over time — through proxy upgrades, admin-controlled state changes, or branches on mutable storage. ERC-7730 v2 provides two on-chain precondition mechanisms for declaring the state that bounds a descriptor's intent claim:

- `context.contract.proxy` — for standardised upgradeable proxies (EIP-1967, EIP-1822, EIP-2535). Declares the audited implementation addresses; for diamonds, the selector-to-facet routing.
- `context.contract.stateRefs` — array of storage slot preconditions. Declares slot, expectedValue, optional mask. Covers admin-controlled parameters, state-dependent branches, custom proxy implementation slots, and similar mutable on-chain state.

**The auditor's test: does the *displayed* intent depend on the vector?**

The question to ask of each function in `display.formats` is *not* "does this contract use an oracle / timestamp / external call" but *does the rendered `intent` string or any formatted `fields` depend on a value influenced by that vector?* A function whose displayed intent is wholly parameterized by user inputs (amount, recipient, minOut, deadline) is not intent-mutable in a way the descriptor needs to express, even if the contract internally consults an oracle. A function that renders an oracle-sourced value as part of its intent is.

**Verifying declared preconditions are accurate**

For every `proxy` declaration:
- Read the live implementation address from the standardised slot (EIP-1967/EIP-1822) or enumerate facets via the diamond loupe `facets()` call (EIP-2535).
- Confirm every live implementation is listed in `expectedImplementations`.
- For diamonds, confirm the live `selector → facet` mapping matches the declared `(address, selectors)` pairs — both that each facet is listed and that each selector routes to the declared facet.

For every `stateRef`:
- Read the live slot value (`cast storage <address> <slot>` or `eth_getStorageAt`).
- Confirm it matches `expectedValue` under the comparison rule (masked if `mask` is present, exact otherwise).

**Verifying preconditions are exhaustive**

For each function in `display.formats`, enumerate the storage slots that the function reads (transitively) and that are writable by a non-user actor — owner, admin, governance, proxy upgrade authority, delegatecall target. Slither's `read-state-variables` and permission detectors are useful starting points. Any writeable-read slot whose value bounds the displayed intent and is not declared in `proxy` or `stateRefs` is a missed vector — open a PR adding it, or **do not sign**.

**Vectors v2 cannot express — these require function omission**

If a function's displayed intent depends on any of the following, the descriptor MUST omit that function from `display.formats`. A descriptor that formats such a function is malformed and you **MUST NOT** issue an attestation:

- **Time-based branches.** `block.timestamp` or `block.number` thresholds that the descriptor would need to render or witness.
- **Block-environment dependencies.** `block.basefee`, `block.coinbase`, `tx.origin`.
- **Parameter-based hidden branches.** Magic input values or sentinel addresses that trigger non-displayed logic.
- **Dynamic external call resolution.** Target contracts resolved at runtime — registry lookups, factory deployments, CREATE2 prediction, off-chain oracle endpoints.
- **Off-chain dependencies.** Oracle endpoints, signing services, library linkage decided off-chain.
- **Composition.** Function behavior modified by multicall, account-abstraction batch, hook, or similar wrapper.

If you find such a vector for a function the descriptor formats, do not sign. Ask the submitter to omit the function from `display.formats` (wallets fall back to opaque signing for omitted selectors) and re-submit.

**EIP-7702 delegated accounts**

If the descriptor binds to a contract that an EIP-7702-delegated EOA might call, the EOA's delegation is off the execution path; review proceeds as normal. If the descriptor binds to a contract that is itself a 7702 delegate (smart-wallet-style use case), review it like any other contract — the descriptor describes the delegate's behavior; wallets resolve the descriptor at signing time by reading the EOA's delegation indicator.

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
