# Symbiotic descriptor verification

These descriptors were checked against Ethereum mainnet at block **25,977,595**, hash
`0x9a8250316232f35d6ab00a08b8edb0240e99e71f1459890fd17f5bf0e7a09c9c`.
This is a reproducible check of descriptor accuracy at that block, not a protocol security audit or an auditor attestation.

## Registered scope

| Contracts | Transaction targets | Registered actions |
| --- | ---: | --- |
| Vault V1, contract versions 1 and 2 | 137 | Deposit, request withdrawal by assets or accounting shares, claim one or several epochs |
| Vault V2, contract version 3 | 7 | ERC-4626 deposit, mint, withdraw, redeem; share approval; submit ERC-2612 permit |
| Withdrawal queues | 7 | Request redemption, claim assets for a withdrawal NFT |
| DefaultStakerRewards, contract versions 1 and 2 | 98 | Claim staker rewards, claim admin fees |
| Rewards V2 | 1 | Explicit snapshot and cumulative Merkle claims; operator, curator and protocol fee claims |
| RFQ Reactor | 1 | Invalidate the caller's request nonce |

Typed-data descriptors cover the seven exact vault permit domains and Reactor `Request` and `Order` signatures. There are **65 descriptors**, **3 common files** and **65 fixture files**.

The address list is a snapshot, not automatic factory discovery. The 144 vaults came from the approved-vault inventory; the 98 legacy reward instances were enumerated from the two staker factories. The operator-rewards factory had no instances at the snapshot. Rewards funding, distribution, configuration, role management, testnets and pre-deposit contracts are outside this contribution.

The legacy rewards descriptor also binds its **two immutable ERC-1167 implementations** for wallets that resolve clone implementations, following the registry's [multi-instantiation guidance](../../../../specs/erc-7730.md#proxy-support). Its 98 explicit clone addresses support direct target lookup. The implementation bindings are templates, not initialized instances to which users should send claim transactions. Thus there are **253 calldata address bindings and 251 transaction targets**.

Generic Rewards V2 `claimRewards(address,address,bytes)` and `multicall(bytes[])` are omitted. The former carries different value-bearing structures in its opaque payload, including indices that can permanently skip rewards. The pinned formatters cannot fully display both payload types through one descriptor. The Rust runner also fails to expand nested multicall actions. The explicit claim methods display their meaningful arguments individually.

## Contract and display checks

[`verify-deployments.cjs`](./verify-deployments.cjs) checks all 251 targets against the bytecode hashes and implementation bindings in [`deployments.csv`](./deployments.csv), including exact ERC-1167 clone bytecode and EIP-1967 implementation slots. It compares the eight implementation runtimes with Sourcify's verified on-chain bytecode, checks factory membership, vault collateral, queue/vault links, all eight EIP-712 domains, and the 54 token records in [`tokens.tsv`](./tokens.tsv).

All **153 non-clone transaction targets and eight implementations** have Sourcify source-verification records. Missing records were verified during this review. The 98 assembly-generated minimal clones are checked as exact ERC-1167 bytecode pointing to the two verified legacy rewards implementations.

Every registered calldata signature is compared with the verified implementation ABI, including parameter names, types, order and tuple components: **947 comparisons**, comprising 943 transaction-target comparisons and four implementation-template comparisons.

| Implementation | Verified source record |
| --- | --- |
| Vault, version 1 | [0xDd649AdaB2e67cAdC2EC29d75ABe73f3Df08065c](https://sourcify.dev/server/v2/contract/1/0xDd649AdaB2e67cAdC2EC29d75ABe73f3Df08065c) |
| VaultTokenized, version 2 | [0x5a0dC8e73d6846f12630b8f7D5197FA8Cf669cfe](https://sourcify.dev/server/v2/contract/1/0x5a0dC8e73d6846f12630b8f7D5197FA8Cf669cfe) |
| Vault V2, version 3 | [0x41069A712FaCc421fE194cAa59667456863a780e](https://sourcify.dev/server/v2/contract/1/0x41069A712FaCc421fE194cAa59667456863a780e) |
| Withdrawal queue | [0x85FE1589DCf6D4Ff207c5fe21fd2e93A94d15F95](https://sourcify.dev/server/v2/contract/1/0x85FE1589DCf6D4Ff207c5fe21fd2e93A94d15F95) |
| DefaultStakerRewards, version 1 | [0x41f640B4F6a12170364589bCb3835DbE0C21C20B](https://sourcify.dev/server/v2/contract/1/0x41f640B4F6a12170364589bCb3835DbE0C21C20B) |
| DefaultStakerRewards, version 2 | [0xE7B6daFe6e5E3D6F7fA3eD7624633E4518B1bc54](https://sourcify.dev/server/v2/contract/1/0xE7B6daFe6e5E3D6F7fA3eD7624633E4518B1bc54) |
| Rewards V2 | [0xa73501536B35DeF71C3B68273f6FAff83c01630f](https://sourcify.dev/server/v2/contract/1/0xa73501536B35DeF71C3B68273f6FAff83c01630f) |
| Reactor | [0xC323B898d7E4105E3980082B74CC5D4602996B10](https://sourcify.dev/server/v2/contract/1/0xC323B898d7E4105E3980082B74CC5D4602996B10) |

The source review and execution assertions establish these display semantics:

- V1 withdrawal and redemption create claims for a `claimer`; they do not immediately send assets. Accounting shares are shown as raw shares, without assuming collateral decimals.
- V2 share amounts use the vault share token's 18 decimals; USDC asset amounts use six. Delegated withdrawal/redeem show both share owner and asset recipient. Permit signatures bind owner, spender, allowance, nonce and deadline.
- Queue requests give the NFT to `receiver`. Queue claims send underlying assets to `receiver` and retain the NFT; the intent is therefore “Claim withdrawal”.
- Legacy claim bytes encode the network and maximum distribution count. Both are displayed; checkpoint hints are excluded from the display.
- Snapshot/operator `firstRewardToClaim` can permanently skip earlier distributions. The expected index, skip index and maximum count remain visible.
- Merkle `leaf.amount` is the cumulative entitlement, not the current payout. A second entitlement of 150 USDC after claiming 100 USDC pays 50 USDC.
- Fee claims transfer the accrued balance to the supplied recipient, subject to the actual admin/operator/curator/owner authorization. No fixed accrued amount is invented.
- Reactor displays each token, amount and associated recipient, exact input, minimum and authorized outputs, deadline, nonce, protocol signer, swapper and filler. Native outputs use its actual zero-address sentinel.

## Mainnet-fork execution

The **17 passing Foundry scenarios** in [`test/`](./test/) execute every registered action family against deployed bytecode: both V1 vault implementations, all seven V2 vaults and queues, both legacy rewards implementations, Rewards V2 staker and fee claims across delegator types 0/2/3, cumulative Merkle claims, nonce cancellation and consumption of actual Request/Order/Permit signatures. Assertions check balances, share changes, claim indices, NFT ownership, allowances and nonce changes. Negative checks include stale reward indices, unauthorized curator claims, repeated Merkle claims, changed signatures, wrong fillers, expiry and replay.

The fork setup funds synthetic accounts, changes deposit eligibility flags, seeds legacy fee/claim-role state and one delegator role, impersonates required authorization holders, and creates distributions through real contract methods. It never replaces deployed bytecode or mocks calls. Reactor uses a minimal local filler funded with outputs, so this checks Reactor signature enforcement and transfers, not a complete adapter route or off-chain RFQ settlement. Nothing is broadcast to mainnet.

[`add-fork-fixtures.cjs`](./add-fork-fixtures.cjs) adds **90 unsigned calldata examples and nine typed-data examples** from the successful fork executions. It independently recovers all nine typed-data signers. These supplement synthetic rendering cases; the complete **585-case corpus is not a claim that every example is executable against unmodified mainnet state**.

## CI and guide compliance

The schema, selector coverage, index and recommended-field checks pass. All **585 cases pass in both pinned CI engines**: Sourcify runner `dae3cdabd0eab26173d7f7a31a2ca7e75bf07daf` and Rust runner `10605ba78f3d6f3f13102e0f3a3ecbc44ac500dc`.

Normal `erc7730==1.0.10` lint has no missing-ABI warnings or errors. It still reports unknown selectors for proxy targets because it reads the wrapper ABI without resolving the implementation. This is **not** evidence that normal CI checked those field paths. The deployment verifier generates temporary implementation-bound copies under `out/abi-lint`; the same unmodified linter validates all 57 calldata descriptors against the verified implementation ABIs with no field-path/unknown-selector errors. Remaining warnings in that diagnostic run are functions intentionally outside the registered scope. The fork suite and this supplemental ABI check are manual checks; the registry CI does not run them.

The [registry README](../../../../README.md) and [review checklist](../../../../docs/REVIEWING.md) were checked alongside the [ethereum.org tutorial](https://ethereum.org/developers/tutorials/clear-signing). Two tutorial recommendations differ from the checked-in specification:

- Upgradeable descriptors bind the actual proxy targets, as the registry's [proxy section](../../../../specs/erc-7730.md#proxy-support) requires, despite the tutorial's general implementation-address advice.
- The registry [token metadata section](../../../../specs/erc-7730.md) says `metadata.token` should be absent when `name()`, `symbol()` and `decimals()` exist. These vaults provide those methods, so token metadata is resolved from the chain rather than duplicated in a shared descriptor.

Future upgrades or new deployments need another inventory and source check. Inclusion in this registry does not itself certify contract safety or confer an auditor attestation.

## Reproduce

Use Foundry 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`), Solidity 0.8.28 and the pinned forge-std below. Install the registry's Node dependencies with `npm ci` from its root, then:

```sh
cd registry/symbiotic/tests/mainnet-fork
git clone https://github.com/foundry-rs/forge-std.git lib/forge-std
git -C lib/forge-std checkout --detach 7117c90c8cf6c68e5acce4f09a6b24715cea4de6
# Set MAINNET_RPC_URL to an Ethereum archive RPC if the public default is unavailable.
forge test --threads 1 -vv
node verify-deployments.cjs
# With the registry's Python requirements installed:
erc7730 lint out/abi-lint/calldata-*.json
```

To regenerate the executed formatter examples, start with empty `fork-actions.jsonl` and `fork-signed-orders.jsonl` output files, rerun the successful suite, then run `node add-fork-fixtures.cjs`. Repeated exports are deduplicated and sorted. Generated logs, fork exports, compilation output and dependencies are ignored by Git.
