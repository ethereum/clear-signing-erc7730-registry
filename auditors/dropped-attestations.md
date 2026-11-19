# Dropped attestations

An attestation signs the hash of one exact descriptor. When a pull request changes an attested descriptor, the attestation no longer matches the file, and the pull request removes it. This list records each removed attestation, so that the auditor can review the new version of the descriptor again.

When you remove an attestation, add a row here in the same pull request. When the auditor attests the descriptor again, remove the row.

| Descriptor | Auditor | Removed in | Why |
|---|---|---|---|
| `registry/celo/calldata-celo_accounts.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/celo/calldata-celo_validators.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/igra/calldata-KasExitBridge.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/layerswap/calldata-LayerswapDepository.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/sei/calldata-sei-distribution.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/sei/calldata-sei-staking.json` | Cyfrin | #3042 | Deployments that Sourcify cannot verify were removed |
| `registry/tether/calldata-usdt.json` | Cyfrin | #3043 | The Polygon deployment moved to `calldata-usdt-polygon.json`, because its ABI names parameters differently |
| `registry/kiln/calldata-kiln-fee-splitter-factory.json` | Cyfrin | #3036 | `$schema` changed from a URL to the relative path `../../specs/erc7730-v2.schema.json` |
