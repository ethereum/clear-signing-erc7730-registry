# Test report bundle

A bundle is one JSON file that describes one run of the [Descriptor Tests](../workflows/descriptor-tests.yml) workflow on a pull request. The results workflow builds it with [`build-bundle.js`](../scripts/build-bundle.js) from the artifacts of the run, commits it to the `test-reports` branch as `pr/<number>/<run id>.json`, and links to the test report viewer, which reads the bundle from `raw.githubusercontent.com`.

The bundle is the contract between this repository and the viewer, which lives in its own repository. `schemaVersion` names the version of this document. The number goes up only for a change that breaks an old reader: a renamed or removed key, or a changed shape. A new optional key does not bump it. A bundle keeps its version forever, so the viewer reads every version it has known.

Every string under `descriptors` and `recommendations` comes from the pull request, that is from a fork. The bundle copies it as data. A reader must escape it and must never build a link from it unless the value matches a strict pattern.

A coding agent that must fix a pull request reads the bundle as [agent-instructions.md](./agent-instructions.md) tells it.

## Top level

| Key | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | number | `1` |
| `generatedAt` | string | ISO 8601 time of the build |
| `run.id` | number | The workflow run, from the `workflow_run` event |
| `run.url` | string | Link to the run |
| `run.startedAt`, `run.completedAt` | string or null | ISO 8601, from the event |
| `pr.number` | number | The pull request |
| `pr.url`, `pr.title` | string or null | From the event |
| `pr.headSha` | string | The commit that was tested, from the event |
| `pr.headRepo` | string | `owner/name` of the head repository, from the event |
| `pr.baseSha` | string or null | The base commit the descriptors were compared to |
| `implementations` | array | One entry per runner artifact slug, sorted by `id` |
| `implementations[].id` | string | The artifact slug, e.g. `sourcify-ts-clear-signing`. Keys the `results` map of every case |
| `implementations[].runner` | string or null | The `runner` field of the runner's `results.json` |
| `implementations[].implementation` | string or null | The `implementation` field, `package@version` |
| `missingTests` | array of string | Affected descriptors with no `testsv2` file |
| `recommendations` | array | Optional. Every suggestion for the files of the pull request, see below |
| `descriptors` | array | One entry per matrix entry, in matrix order |

### `recommendations[]`

An optional addition to schema version 1. An older bundle does not have the key; read it as an empty list.

The list comes from [`check-recommended-fields.js`](../scripts/check-recommended-fields.js), which the test run writes to `recommendations.json` in its `pr-context` artifact. The script reads each changed descriptor and shared file as it is, without its `includes`, so an item names the file that the author must edit. A suggestion never blocks the pull request.

| Key | Type | Notes |
| --- | --- | --- |
| `type` | string | `no-interpolated-intent` or `deprecated-key`. A reader ignores a type it does not know |
| `file` | string | Repository path of the file to edit, e.g. `registry/safe/common-Safe.json` |
| `pointer` | string | [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointer into `file`: the format for `no-interpolated-intent`, the key for `deprecated-key`. In a segment, `~1` is `/` and `~0` is `~` |
| `message` | string | One sentence that explains the suggestion |
| `format` | string | `no-interpolated-intent` only: the format key |
| `key` | string | `deprecated-key` only: `context.contract.abi` or `context.eip712.schemas` |

## `descriptors[]`

| Key | Type | Notes |
| --- | --- | --- |
| `path` | string | Repository path, e.g. `registry/flare/calldata-AssetManager-FXRP-Flare.json` |
| `entity`, `name` | string | The two parts of the path |
| `kind` | `calldata` or `eip712` | From the file name prefix |
| `change.descriptor` | string | `added`, `modified`, `deleted`, `unchanged` or `unknown`. `modified` also when only a file that the descriptor includes changed: the resolved `head` and `base` differ |
| `change.viaInclude` | `true`, optional | Present when `change.descriptor` is `modified` only because a file that the descriptor includes changed. The descriptor file itself did not change |
| `change.tests` | string | Same values, for the test file |
| `testFile` | string or null | Repository path of the test file |
| `head` | object or null | The descriptor at `pr.headSha`, with `includes` resolved |
| `base` | object or null | The descriptor at `pr.baseSha`, resolved, when it existed there |
| `dataProvider` | object or null | The `dataProvider` block of the test file |
| `formats` | object | One entry per key of `head.display.formats`, see below |
| `recommendations` | array | The suggestions that apply to this descriptor, see below |
| `cases` | array | One entry per test of the test file, in file order |

### `formats`

Keyed by the format key exactly as the descriptor writes it.

| Key | Type | Notes |
| --- | --- | --- |
| `selector` | string or null | The 4-byte selector of a calldata format key |
| `primaryType` | string or null | The type name of an EIP-712 format key |
| `error` | string or null | Why no selector could be derived |
| `cases` | array of string | The `description` of every case that hits this format. Empty means the function has no test |

### `descriptors[].recommendations[]`

The items of the top-level `recommendations` that apply to this descriptor. An item applies when its `file` is the descriptor or a file in its `includes` chain. A `no-interpolated-intent` item applies only when `head.display.formats` has the format and the resolved format still has no `interpolatedIntent`, because a descriptor can override a format of the file that it includes.

| `type` | Other keys | Meaning |
| --- | --- | --- |
| `no-interpolated-intent` | `format` | The format has no `interpolatedIntent` |
| `deprecated-key` | `key` | The descriptor uses `context.contract.abi` or `context.eip712.schemas` |

Every item also has the optional keys `file` and `pointer`, with the meaning of the top-level list. They are an optional addition to schema version 1: an older bundle does not have them.

### `cases[]`

| Key | Type | Notes |
| --- | --- | --- |
| `description` | string | The join key, copied from the test |
| `index` | number | Position in the test file |
| `input.type` | `calldata`, `eip712` or `unknown` | |
| `input.chainId` | number or null | From the raw transaction, or from `domain.chainId` |
| `input.to` | string or null | The target address, or `domain.verifyingContract` |
| `input.value` | string | Wei as a decimal string. Calldata only |
| `input.selector` | string or null | First 4 bytes of the calldata. Calldata only |
| `input.txType` | string or null | `legacy`, `eip1559`, … Calldata only |
| `input.primaryType` | string or null | EIP-712 only |
| `input.error` | string | Present when the input could not be decoded |
| `format` | string or null | The format key the input hits, matched by selector or primary type |
| `expected` | object | The `expected` block of the test, with `fields` as an array of `{label, value}` |
| `from` | string or null | The signer, when the test names one |
| `txHash` | string or null | For reference only |
| `results` | object | One entry per implementation id, see below |

The raw transaction and the typed data are not in the bundle. The viewer decodes the arguments from `rawTx` itself, and reads them from the test file of the head commit when it needs them.

### `cases[].results[<implementation id>]`

| Key | Type | Notes |
| --- | --- | --- |
| `status` | `pass`, `fail`, `error` or `skipped` | An unknown status becomes `error` with a message |
| `rendered` | object or null | The runner's output, `fields` as an array |
| `message` | string or null | The runner's note |
| `warnings` | array | The runner's `warnings`, or empty |
| `format` | string or null | The format the runner says it matched, when it reports one |
| `chainId` | number or null | When the runner reports one |
| `durationMs` | number or null | When the runner reports one |
| `diff` | array or null | Differences between `expected` and `rendered`, computed here. `null` when there is no `rendered` |
| `diff[].path` | string | `intent`, `owner`, `fields[3].value`, `fields[1].value.fields[0].label`, `fields.length`, … |
| `diff[].expected`, `diff[].got` | any | The two values, `null` when one side has none |

A case that the runner did not report gets `status: "error"` and a message, so the report shows the gap.

## The `test-reports` branch

The results workflow publishes every bundle with [`publish-report.sh`](../scripts/publish-report.sh) to the orphan branch `test-reports` of this repository. The branch holds no code, and it is written only by CI. Do not edit it by hand, and do not base work on it: it can be recreated from scratch, without history, when it grows too large.

```
README.md                    what the branch is
pr/<number>/<run id>.json    the bundle of one run of the Descriptor Tests workflow
pr/<number>/index.json       the runs of one pull request, newest first
```

One commit per run adds the bundle and rewrites the index of that pull request. Two pull requests can finish at the same time, so the push retries: it fetches the new tip, applies the two files again on top of it, and pushes again. The files of a run are only added or replaced, so this is safe. There is no root index, because every run would touch it.

The files are served at `https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/test-reports/pr/<number>/<run id>.json`, with open CORS and a cache of about five minutes.

### `pr/<number>/index.json`

Written by [`report-index.js`](../scripts/report-index.js).

| Key | Type | Notes |
| --- | --- | --- |
| `indexVersion` | number | `1` |
| `pr` | number | The pull request |
| `updatedAt` | string | ISO 8601 |
| `runs` | array | One entry per run, newest first by run id |
| `runs[].runId`, `runs[].runUrl` | number, string | The workflow run |
| `runs[].headSha` | string | The commit that was tested |
| `runs[].startedAt`, `runs[].completedAt`, `runs[].generatedAt` | string or null | ISO 8601 |
| `runs[].schemaVersion` | number | The `schemaVersion` of the bundle |
| `runs[].summary.descriptors` | number | Descriptors in the bundle |
| `runs[].summary.missingTests` | number | Affected descriptors with no test file |
| `runs[].summary.cases` | number | Test cases in the bundle |
| `runs[].summary.byStatus` | object | Per implementation id: `{pass, fail, error, skipped}` counts |
| `runs[].summary.disagreements` | number | Cases where the implementations have different statuses |
