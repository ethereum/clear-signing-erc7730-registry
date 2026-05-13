# Registry coverage report

Generates a per-entity coverage matrix for the ERC-7730 registry: descriptor counts (calldata / eip712), whether a permit-shaped descriptor exists, test coverage, chain IDs referenced, and schema versions in use.

Pure Node stdlib — no extra dependencies.

## Usage

```bash
# Markdown to stdout
node tools/scripts/coverage-report.js

# Markdown to a file (e.g. for committing to docs/coverage.md)
node tools/scripts/coverage-report.js --out docs/coverage.md

# JSON output (useful for downstream tooling)
node tools/scripts/coverage-report.js --json

# JSON to a file
node tools/scripts/coverage-report.js --json --out coverage.json
```

When `$GITHUB_STEP_SUMMARY` is set (running inside GitHub Actions), the markdown report is also appended there so reviewers can read it directly in the workflow run.

## What it reports

For each entity under `registry/*/`:

| Column | Meaning |
| --- | --- |
| `calldata` | Number of `calldata-*.json` descriptors at the entity root |
| `eip712` | Number of `eip712-*.json` descriptors |
| `permit` | Whether any descriptor in the entity is permit-shaped (filename hint or `display.formats` key starts with `Permit`) |
| `tests` | Count of `*.tests.json` files under `tests/` |
| `test cov` | `tests / (calldata + eip712)`, capped at 100% |
| `chains` | Union of `chainId`s referenced by `context.contract.deployments` and `context.eip712.deployments` |
| `schemas` | Schema versions in use (`v1`, `v2`, or `other`) detected from each descriptor's `$schema` field |

A trailing **Gaps** section lists:

- entities with descriptors but no `tests/` folder
- entities with `calldata-*` but no permit descriptor (typical EIP-2612 / Permit2 gap)
- entities still referencing the v1 schema

The aggregate counts of common ERC descriptors under `ercs/` (e.g. `eip712-erc2612-permit.json`) are also reported.

## Automation

The `coverage.yml` GitHub workflow runs this script weekly and commits the refreshed `docs/coverage.md` back to `master`, providing a stable URL for maintainers and contributors to scan registry health at a glance.
