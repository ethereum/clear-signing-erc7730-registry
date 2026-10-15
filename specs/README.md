# Specs

This directory contains the ERC-7730 specification and JSON schemas used to validate clear signing descriptors in the registry.

## Files synced from upstream

The following files are automatically synced from the [ethereum/ERCs](https://github.com/ethereum/ERCs) repository by the `sync-specs` CI workflow (weekly, or on-demand):

| Local file | Upstream source |
|---|---|
| `erc-7730.md` | [ERCS/erc-7730.md](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7730.md) |
| `erc7730-v*.schema.json` | every schema file under [assets/erc-7730/](https://github.com/ethereum/ERCs/tree/master/assets/erc-7730): released versions such as `erc7730-v2.schema.json`, release candidates (`-rc.N`) and the in-development draft (`-next`) |

The workflow lists the upstream folder at run time, so a new schema file arrives here without a change to the workflow. Descriptors point at a released schema by a relative path, for example `"$schema": "../../specs/erc7730-v2.schema.json"`. The `-next` draft changes without notice and no descriptor should point at it.

Do not edit these files directly — changes should be made upstream and will be picked up automatically.

## Other files

These are maintained in this repository and are not synced from upstream.

| File | Description |
|---|---|
| `erc7730-tests-v2.schema.json` | JSON schema for test files in `registry/$entity/testsv2/` |
| `erc7730-tests.schema.json` | Legacy JSON schema for test files in `registry/$entity/tests/` |
| `templates/` | Descriptor templates for new contributions |

