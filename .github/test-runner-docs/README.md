# Test runner guide

A test runner is a small program that consumes one `.tests.json` fixture from the registry, drives a clear-signing implementation against each case, and writes a `results.json` describing what the implementation rendered. The CI workflow ([`clear-signing-tests.yml`](../workflows/clear-signing-tests.yml)) wraps the runner in a composite action, uploads the `results.json` as an artifact, and the `post-results` job aggregates per-implementation columns onto the PR.

## Input

The runner is invoked with a path to a `.tests.json` fixture and the descriptor it points to. The fixture conforms to [`specs/erc7730-tests-v2.schema.json`](../../specs/erc7730-tests-v2.schema.json).

The runner is responsible for:

- Resolving ERC-7730 `includes` itself — the CI does not pre-flatten descriptors.
- Honoring the fixture's optional `dataProvider` block (mock token metadata, address-name lookups, etc.) instead of hitting the network.
- Producing rendered output for every case, regardless of whether it matches `expected`.

## Output

Write a single `results.json` per descriptor to the working directory.

```json
{
  "runner": "@ethereum-sourcify/clear-signing-test-runner",
  "implementation": "@ethereum-sourcify/clear-signing@0.1.1",
  "cases": [
    {
      "description": "Smart account execute: approve 100 USDC",
      "status": "pass",
      "rendered": {
        "intent": "Execute call",
        "interpolatedIntent": "Execute call on USDC",
        "owner": "Example Smart Account",
        "fields": {
          "Target": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          "Spending Limit": "0 ETH",
          "Call data": {
            "intent": "Approve",
            "owner": "USDC",
            "fields": {
              "Spender": "0x1234567890123456789012345678901234567890",
              "Amount": "100 USDC",
              "Deadline": "2026-12-31 23:59 UTC"
            }
          }
        }
      }
    }
  ]
}
```

`rendered` mirrors the shape of `expected` in the fixture — the same `{intent, owner, fields}` form applies to both calldata and EIP-712 cases.

### Fields

| Field                 | Required    | Type   | Notes                                                                                                                                                                                                                                                       |
| --------------------- | ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner`              | yes         | string | Identifier of the test runner harness emitting this file. Always `@ethereum-sourcify/clear-signing-test-runner`                                                                                                                                             |
| `implementation`      | yes         | string | Identifier of the clear-signing implementation under test, in `package@version` form                                                                                                                                                                        |
| `cases`               | yes         | array  | One entry per test case from the `.tests.json` input                                                                                                                                                                                                        |
| `cases[].description` | yes         | string | Copied verbatim from the `description` field of the source test case — used to join back to the fixture. Fixtures must keep descriptions unique within a file; runners can rely on that to key results without collision                                    |
| `cases[].status`      | yes         | enum   | One of `pass`, `fail`, `error`, `skipped` (see below)                                                                                                                                                                                                       |
| `cases[].rendered`    | conditional | object | What the runner produced. Same shape as `expected` in the test data file — see [The `expected` block](../../README.md#the-expected-block) in the main README for the field-level breakdown. Required on `pass` and `fail`; omitted on `error` and `skipped` |
| `cases[].message`     | optional    | string | Human-readable note. Required on `error` and `skipped`; optional on `fail`                                                                                                                                                                                  |

**Calldata formatters.** Fields that use a calldata formatter (the field's value is itself an encoded inner call) appear as a nested `rendered`-shaped object in `fields`; nesting is recursive.

`runner` vs `implementation`: the runner is the harness that drives the test (one identifier across all jobs); the implementation is the codebase being exercised by that harness (varies per job). The PR comment groups results by `implementation`.

### Status values

- **`pass`** — runner produced `rendered` output and it matched the fixture's `expected` block.
- **`fail`** — runner ran cleanly but `rendered` did not match `expected`. The `post-results` job computes the diff. Optionally include a `message`.
- **`error`** — runner crashed, timed out, or could not process the input for reasons unrelated to clear-signing semantics. Always include a `message`.
- **`skipped`** — runner intentionally chose not to run this case. Always include a `message` explaining why.

### Examples

- [`pass.example.json`](./pass.example.json)
- [`fail.example.json`](./fail.example.json)
- [`error.example.json`](./error.example.json)
- [`skipped.example.json`](./skipped.example.json)

## Wiring into CI

Wrap the runner in a composite action under `.github/actions/run-<name>-tests/` and add a sibling job in [`clear-signing-tests.yml`](../workflows/clear-signing-tests.yml). The action should call [`upload-test-results`](../actions/upload-test-results/action.yml) to publish the artifact.

See [`run-sourcify-tests`](../actions/run-sourcify-tests/action.yml) for a complete reference implementation.
