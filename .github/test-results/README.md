# Test runner results format

This folder defines the output contract between clear-signing test runners and the `post-results` job in [`clear-signing-tests.yml`](../workflows/clear-signing-tests.yml).

Each runner writes a single `results.json` per descriptor it tests. The workflow uploads it as an artifact, and `post-results` reads all of them to build the per-case × per-implementation table on the PR.

Runners are expected to resolve ERC-7730 `includes` themselves — the CI workflow does not pre-flatten descriptors before invoking a runner.

## Shape

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

`rendered` mirrors the shape of `expected` in the source `.tests.json`. The same shape applies whether the test case is calldata or EIP-712 — both produce `{intent, owner, fields}`. Field values are strings, or — for calldata-formatted fields — a nested object with the same shape as `rendered` itself (`intent`, `owner`, `fields`). See note below the table.

## Fields

| Field                     | Required            | Type   | Notes                                                                                                                                      |
| ------------------------- | ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `runner`                  | yes                 | string | Identifier of the test runner harness emitting this file. Always `@ethereum-sourcify/clear-signing-test-runner`                            |
| `implementation`          | yes                 | string | Identifier of the clear-signing implementation under test, in `package@version` form                                                       |
| `cases`                   | yes                 | array  | One entry per test case from the `.tests.json` input                                                                                       |
| `cases[].description`     | yes                 | string | Copied verbatim from the `description` field of the source test case — used to join back to the test file                                  |
| `cases[].status`          | yes                 | enum   | One of `pass`, `fail`, `error`, `skipped` (see below)                                                                                      |
| `cases[].rendered`        | conditional         | object | What the runner produced. Same shape as `expected` in the test file. Required on `pass` and `fail`; omitted on `error` and `skipped`       |
| `cases[].rendered.intent` | yes (if `rendered`) | string | The transaction intent shown to the user                                                                                                   |
| `cases[].rendered.owner`  | yes (if `rendered`) | string | The descriptor owner shown to the user                                                                                                     |
| `cases[].rendered.fields` | yes (if `rendered`) | object | Field labels mapped to values. Values are strings, or — for calldata-formatted fields — a nested `rendered`-shaped object (see note below) |
| `cases[].message`         | optional            | string | Human-readable note. Required on `error` and `skipped`; optional on `fail`                                                                 |

**Calldata formatters and groups.** When a field uses a calldata formatter (i.e. the field's value is itself an encoded inner call), its value in `fields` is a nested object with the same shape as `cases[].rendered` — `{intent, owner, fields}` — and nesting is recursive (an inner call's fields can themselves contain another calldata-formatted field). **Group** fields (logical groupings declared in the descriptor) are **flattened** to top-level entries in `fields`; they are never represented as nested objects. Nested objects in `rendered.fields` therefore always indicate a calldata formatter, never a group.

`runner` vs `implementation`: the runner is the harness that drives the test (one identifier across all jobs); the implementation is the codebase being exercised by that harness (varies per job). The PR comment groups results by `implementation`.

## Status values

- **`pass`** — runner produced `rendered` output and it matched the test's `expected` block.
- **`fail`** — runner ran cleanly but `rendered` did not match `expected`. The `post-results` job computes the diff by reading the test file. Optionally include a `message` describing the mismatch.
- **`error`** — runner crashed, timed out, or could not process the input for reasons unrelated to clear-signing semantics (RPC failure, panic, emulator hang). Always include a `message`.
- **`skipped`** — runner intentionally chose not to run this case. Always include a `message` explaining why.

## Where to write the file

The runner writes `results.json` to its working directory. The composite action uploads it as an artifact whose name uniquely identifies the `(implementation, descriptor)` pair (each composite picks its own short slug — `implementation` strings contain `@` and `/`, which are not valid in GitHub Actions artifact names).

## Examples

- [`pass.example.json`](./pass.example.json)
- [`fail.example.json`](./fail.example.json)
- [`error.example.json`](./error.example.json)
- [`skipped.example.json`](./skipped.example.json)
