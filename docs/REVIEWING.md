# Reviewing registry pull requests

Every descriptor in the registry goes through a pull request review before merge. The review keeps the registry consistent and catches obvious mistakes; it is not the trust layer — that comes from the [attestations](../auditors/README.md) auditors publish after the merge.

This page is the working checklist for reviewers and maintainers. It complements — not replaces — the automated CI checks.

A PR review is deliberately **short and basic**: the mechanical rules are enforced by CI, so what remains is a plausibility check of the things only a human can judge. It is _not_ a security audit — source-level verification of descriptor accuracy is the job of the auditors. If you notice something deeper during review, leave a note for the auditors in the PR rather than blocking the merge on a full investigation.

## Review checklist

### 1. Are all CI checks green?

Nothing gets merged with failing checks. CI covers the mechanical review completely — linting and schema validation, test presence and results, index collisions (no hijacking of another project's deployments), file naming, and immutability of attested descriptors. None of these needs a manual pass anymore.

The optional improvements (adding `interpolatedIntent`, dropping deprecated fields) are also suggested automatically by the advisory **recommendations comment** — nothing to do there either; whether the author applies them is their call.

### 2. Did the linter fetch the ABI?

Check the lint warnings for a **"Could not fetch ABI"** message. When the linter cannot fetch a reference ABI for a deployment, the whole display field validation is silently skipped — the check is green, but the descriptor's field paths were never verified against the contract. In that case, ask the author to [verify the contract's source code on Sourcify](https://sourcify.dev) and re-run the checks.

### 3. Do intents and hidden fields pass a sanity read?

One quick human pass over `display.formats` — minutes of work that catches the most dangerous descriptor mistakes:

- The `intent` says what the function actually does, in user terms. An approval must read as an approval; vague or technical intents ("Execute", the bare function name) defeat the purpose of clear signing.
- Fields marked `visible: "never"` are plausibly irrelevant to the signer (a nonce, the signer's own address). Value-bearing parameters — amounts, spenders, recipients, deadlines — must never be hidden.

This is a plausibility read, not verification against the contract source — that remains the auditors' job.

### 4. One entity per PR

A PR should only touch files inside a single `registry/<entity_name>/` folder. Be suspicious of PRs that modify or delete files of a _different_ entity than the one they claim to change — CI validates naming and index consistency, but not whose folder a PR touches.

## Deeper review and attestations

For attestation-grade review — verifying the descriptor against verified source code, checking intent mutability through proxies and mutable state, and publishing a signed EAS attestation — see the [auditor guide](../auditors/README.md). Regular PR review keeps the registry consistent; attestations add the cryptographic trust layer wallets can build policy on.
