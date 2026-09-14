// Read-only mainnet verification. Run from any directory after `npm ci` at the registry root.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createPublicClient, http, getAddress, keccak256, parseAbi, parseAbiItem, toFunctionSelector } = require('viem');
const repo = path.resolve(__dirname, '../../../..');
const { resolveDescriptor } = require(path.join(repo, '.github/scripts/resolve-erc7730-includes.js'));
const BLOCK = 25977595n;
const BLOCK_HASH = '0x9a8250316232f35d6ab00a08b8edb0240e99e71f1459890fd17f5bf0e7a09c9c';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const FACTORY = '0xAEb6bdd95c502390db8f52c8909F703E9Af6a346';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const client = createPublicClient({ transport: http(process.env.MAINNET_RPC_URL || 'https://eth.drpc.org', { timeout: 30000, retryCount: 3 }) });
const abi = parseAbi([
  'function collateral() view returns(address)', 'function asset() view returns(address)',
  'function vault() view returns(address)', 'function VAULT() view returns(address)',
  'function isEntity(address) view returns(bool)', 'function withdrawalQueue() view returns(address)',
  'function name() view returns(string)', 'function symbol() view returns(string)', 'function decimals() view returns(uint8)',
  'function eip712Domain() view returns(bytes1,string,string,uint256,address,bytes32,uint256[])',
]);
const normalize = inputs => inputs.map(({ name, type, components }) => ({ name, type, ...(components ? { components: normalize(components) } : {}) }));
function table(file, delimiter) {
  const [header, ...lines] = fs.readFileSync(path.join(__dirname, file), 'utf8').trim().split('\n');
  const keys = header.split(delimiter);
  return lines.map(line => Object.fromEntries(line.split(delimiter).map((v, i) => [keys[i], v])));
}
async function parallel(items, run) {
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { while (next < items.length) await run(items[next++]); }));
}
async function read(address, functionName, args = []) {
  return client.readContract({ address, abi, functionName, args, blockNumber: BLOCK });
}
async function main() {
  assert.equal((await client.getBlock({ blockNumber: BLOCK })).hash, BLOCK_HASH);
  const deployments = table('deployments.csv', ',');
  const byAddress = new Map(deployments.map(row => [getAddress(row.address), row]));
  const sources = new Map();
  await parallel([...new Set(deployments.map(row => row.implementation))], async address => {
    const response = await fetch(`https://sourcify.dev/server/v2/contract/1/${address}?fields=all`, { signal: AbortSignal.timeout(60000) });
    assert(response.ok, `${address}: Sourcify HTTP ${response.status}`);
    const source = await response.json();
    assert(['match', 'exact_match'].includes(source.runtimeMatch), `${address}: missing verified runtime`);
    const code = await client.getBytecode({ address, blockNumber: BLOCK });
    assert.equal(code.toLowerCase(), source.runtimeBytecode.onchainBytecode.toLowerCase(), `${address}: source/runtime mismatch`);
    source.codeHash = keccak256(code);
    sources.set(address, source);
  });
  let verifiedNonCloneSources = 0;
  await parallel(deployments, async row => {
    const code = await client.getBytecode({ address: row.address, blockNumber: BLOCK });
    assert.equal(keccak256(code), row.runtimeCodeHash, `${row.address}: target bytecode changed`);
    assert.equal(sources.get(row.implementation).codeHash, row.implementationCodeHash, `${row.address}: implementation bytecode changed`);
    if (row.kind === 'legacy-rewards') {
      assert.equal(code.toLowerCase(), `0x363d3d373d3d3d363d73${row.implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`);
      assert.equal(await read(FACTORY, 'isEntity', [await read(row.address, 'VAULT')]), true);
    } else if (row.kind !== 'reactor') {
      const slot = await client.getStorageAt({ address: row.address, slot: IMPLEMENTATION_SLOT, blockNumber: BLOCK });
      assert.equal(getAddress('0x' + slot.slice(-40)), row.implementation, `${row.address}: proxy implementation changed`);
      if (row.kind === 'vault') assert.equal(await read(FACTORY, 'isEntity', [row.address]), true);
    }
    if (row.kind !== 'legacy-rewards') {
      const response = await fetch(`https://sourcify.dev/server/v2/contract/1/${row.address}`, { signal: AbortSignal.timeout(60000) });
      assert(response.ok, `${row.address}: missing Sourcify source record`);
      const record = await response.json();
      assert(['match', 'exact_match'].includes(record.runtimeMatch), `${row.address}: unverified source record`);
      verifiedNonCloneSources++;
    }
  });
  const tokens = table('tokens.tsv', '\t');
  const tokenCalls = tokens.flatMap(row => ['name', 'symbol', 'decimals'].map(functionName => ({ address: row.address, abi, functionName })));
  const values = await client.multicall({ contracts: tokenCalls, blockNumber: BLOCK, multicallAddress: MULTICALL, batchSize: 8000, allowFailure: false });
  values.forEach((value, i) => assert.equal(String(value), tokens[Math.floor(i / 3)][tokenCalls[i].functionName], `${tokenCalls[i].address}: token metadata mismatch`));

  let comparisons = 0;
  let domains = 0;
  const seen = new Set();
  const templates = new Set();
  const probe = path.join(__dirname, 'out/abi-lint');
  fs.mkdirSync(probe, { recursive: true });
  for (const file of fs.readdirSync(path.join(__dirname, '../..')).filter(f => /^(calldata|eip712)-.*\.json$/.test(f))) {
    const descriptor = resolveDescriptor(path.join(__dirname, '../..', file));
    if (descriptor.context.contract) {
      const implementationAddresses = new Set();
      for (const deployment of descriptor.context.contract.deployments) {
        assert.equal(deployment.chainId, 1);
        const address = getAddress(deployment.address);
        assert(!seen.has(address), `${address}: duplicate address binding`);
        seen.add(address);
        const row = byAddress.get(address);
        // Multi-instantiation bindings identify immutable ERC-1167 implementation templates.
        // They do not represent initialized reward instances or direct claim transaction targets.
        if (!row) {
          assert.equal(file, 'calldata-DefaultStakerRewards.json');
          assert(deployments.some(r => r.kind === 'legacy-rewards' && r.implementation === address));
          templates.add(address);
        }
        const implementation = row?.implementation || address;
        implementationAddresses.add(implementation);
        const reference = sources.get(implementation).abi.filter(item => item.type === 'function');
        for (const signature of Object.keys(descriptor.display.formats)) {
          const fn = parseAbiItem('function ' + signature);
          const actual = reference.find(f => toFunctionSelector(f) === toFunctionSelector(fn));
          assert(actual, `${file}: selector absent from real implementation`);
          assert.deepEqual(normalize(fn.inputs), normalize(actual.inputs), `${file}: ABI argument names/types differ`);
          comparisons++;
        }
        if (row?.kind === 'vault') {
          const token = await read(address, file.includes('VaultV1') ? 'collateral' : 'asset');
          assert.equal(token, descriptor.metadata.constants.underlyingToken);
        }
        if (row?.kind === 'queue') {
          const vault = await read(address, 'vault');
          assert.equal(vault, descriptor.metadata.constants.vault);
          assert.equal(await read(vault, 'withdrawalQueue'), address);
        }
      }
      // Temporary diagnostic copies let the unmodified linter check verified implementation ABIs.
      // Production descriptors keep proxy targets; normal CI still has limited proxy ABI resolution.
      descriptor.context.contract.deployments = [...implementationAddresses].map(address => ({ chainId: 1, address }));
      delete descriptor.includes;
      fs.writeFileSync(path.join(probe, file), JSON.stringify(descriptor, null, 2) + '\n');
    } else {
      const context = descriptor.context.eip712;
      for (const deployment of context.deployments) {
        const domain = await read(deployment.address, 'eip712Domain');
        assert.equal(domain[0], '0x0f');
        assert.equal(domain[1], context.domain.name);
        assert.equal(domain[2], context.domain.version);
        assert.equal(domain[3], BigInt(deployment.chainId));
        assert.equal(domain[4], deployment.address);
        domains++;
      }
    }
  }
  assert.equal(seen.size - templates.size, deployments.length);
  assert.equal(templates.size, 2);
  assert.equal(domains, 8);
  console.log(JSON.stringify({ block: String(BLOCK), blockHash: BLOCK_HASH, transactionTargets: deployments.length, implementationTemplates: templates.size, verifiedImplementations: sources.size, verifiedNonCloneSources, abiComparisons: comparisons, eip712Domains: domains, tokens: tokens.length, implementationLintDirectory: probe }, null, 2));
}
main().catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
