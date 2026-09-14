// Convert successful calls exported by `forge test` into unsigned formatter references.
// Expected labels and values below describe the effects asserted by the fork suite.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { decodeFunctionData, decodeAbiParameters, parseAbiParameters, parseAbiItem, toFunctionSelector, serializeTransaction, formatUnits, getAddress, maxUint256, recoverTypedDataAddress } = require('viem');
const repo = path.resolve(__dirname, '../../../..');
const root = path.resolve(__dirname, '../..');
const { resolveDescriptor } = require(path.join(repo, '.github/scripts/resolve-erc7730-includes.js'));
const prefix = 'Mainnet fork 25977595: ';
const tokens = new Map(fs.readFileSync(path.join(__dirname, 'tokens.tsv'), 'utf8').trim().split('\n').slice(1).map(line => {
  const [address, name, symbol, decimals] = line.split('\t');
  return [address.toLowerCase(), { name, symbol, decimals: Number(decimals) }];
}));
tokens.set('0x0000000000000000000000000000000000000000', { name: 'Ether', symbol: 'ETH', decimals: 18 });
const byTarget = new Map();
const fixtures = new Map();
for (const file of fs.readdirSync(root).filter(f => /^(calldata|eip712)-.*\.json$/.test(f))) {
  const descriptor = resolveDescriptor(path.join(root, file));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'testsv2', file.replace('.json', '.tests.json'))));
  fixture.tests = fixture.tests.filter(t => !t.description.startsWith(prefix) && !t.description.includes('with placeholder signature'));
  const entry = { file, descriptor, fixture };
  fixtures.set(file, entry);
  for (const deployment of descriptor.context.contract?.deployments || []) byTarget.set(deployment.address.toLowerCase(), entry);
}
const fi = (label, value) => ({ label, value: String(value) });
const addr = value => getAddress(value);
const date = value => new Date(Number(value) * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z');
function token(entry, address) {
  const metadata = tokens.get(address.toLowerCase());
  assert(metadata, `Missing verified token metadata: ${address}`);
  entry.fixture.dataProvider ||= {};
  entry.fixture.dataProvider.tokens ||= {};
  entry.fixture.dataProvider.tokens[address.toLowerCase()] = metadata;
  return metadata;
}
function amount(entry, value, address, allowance = false) {
  const t = token(entry, address);
  return `${allowance && value === maxUint256 ? 'Unlimited' : formatUnits(value, t.decimals)} ${t.symbol}`;
}
function display(intent, interpolatedIntent, fields) { return { intent, interpolatedIntent, owner: 'Symbiotic', fields }; }
function expectedCall(entry, target, fn, a) {
  const vault = fi('Vault', target);
  if (entry.file.startsWith('calldata-VaultV1-')) {
    const underlying = entry.descriptor.metadata.constants.underlyingToken;
    switch (fn) {
      case 'deposit': { const n = amount(entry, a[1], underlying); return display('Deposit into vault', `Deposit ${n}`, [vault, fi('Deposit amount', n), fi('Deposit beneficiary', a[0])]); }
      case 'withdraw': { const n = amount(entry, a[1], underlying); return display('Request withdrawal', `Request ${n} withdrawal`, [vault, fi('Requested assets', n), fi('Claim owner', a[0])]); }
      case 'redeem': return display('Queue share withdrawal', `Queue ${a[1]} raw shares`, [vault, fi('Vault shares (raw)', a[1]), fi('Claim owner', a[0])]);
      case 'claim': return display('Claim withdrawal', `Claim epoch ${a[1]}`, [vault, fi('Epoch', a[1]), fi('Recipient', a[0])]);
      case 'claimBatch': return display('Claim withdrawals', `Claim to ${a[0]}`, [vault, ...a[1].map(epoch => fi('Epoch', epoch)), fi('Recipient', a[0])]);
    }
  } else if (entry.file.startsWith('calldata-VaultV2-')) {
    const underlying = entry.descriptor.metadata.constants.underlyingToken;
    switch (fn) {
      case 'deposit': { const n = amount(entry, a[0], underlying); return display('Deposit into vault', `Deposit ${n}`, [vault, fi('Deposit amount', n), fi('Share recipient', a[1])]); }
      case 'mint': { const n = amount(entry, a[0], target); return display('Mint vault shares', `Mint ${n} for ${a[1]}`, [vault, fi('Deposit asset', 'USDC'), fi('Shares to mint', n), fi('Share recipient', a[1])]); }
      case 'withdraw': { const n = amount(entry, a[0], underlying); return display('Withdraw from vault', `Withdraw ${n}`, [vault, fi('Assets to withdraw', n), fi('Recipient', a[1]), fi('Share owner', a[2])]); }
      case 'redeem': { const n = amount(entry, a[0], target); return display('Redeem vault shares', `Redeem ${n} to ${a[1]}`, [vault, fi('Shares to redeem', n), fi('Recipient', a[1]), fi('Share owner', a[2])]); }
      case 'approve': { const n = amount(entry, a[1], target, true); return display('Approve vault share spending', `Approve ${n} for ${a[0]}`, [vault, fi('Spender', a[0]), fi('Allowance amount', n)]); }
      case 'permit': { const n = amount(entry, a[2], target, true); return display('Submit share permit', `Approve ${n} for ${a[1]}`, [vault, fi('Share owner', a[0]), fi('Spender', a[1]), fi('Allowance amount', n), fi('Signature deadline', date(a[3]))]); }
    }
  } else if (entry.file.startsWith('calldata-WithdrawalQueue-')) {
    const pairedVault = entry.descriptor.metadata.constants.vault;
    const fields = [fi('Vault', pairedVault)];
    if (fn === 'requestRedeem') { const n = amount(entry, a[0], pairedVault); return display('Request queued withdrawal', `Queue ${n}`, [...fields, fi('Shares to queue', n), fi('NFT recipient', a[1])]); }
    if (fn === 'claim') return display('Claim queued withdrawal', `Claim withdrawal ${a[0]}`, [...fields, fi('Withdrawal NFT ID', a[0]), fi('Asset recipient', a[1])]);
  } else if (entry.file === 'calldata-DefaultStakerRewards.json') {
    const symbol = token(entry, a[1]).symbol;
    const fields = [fi('Rewards contract', target), fi('Recipient', a[0]), fi('Reward token', symbol)];
    if (fn === 'claimAdminFee') return display('Claim admin fees', `Claim ${symbol} to ${a[0]}`, fields);
    if (fn === 'claimRewards') {
      const [network, count] = decodeAbiParameters(parseAbiParameters('address,uint256,bytes[]'), a[2]);
      return display('Claim staker rewards', `Claim ${symbol} to ${a[0]}`, [...fields, fi('Network', network), fi('Max rewards', count)]);
    }
  } else if (entry.file === 'calldata-RewardsV2.json') {
    const contract = fi('Rewards contract', target), recipient = fi('Recipient', a[0]);
    if (fn === 'claimVaultSnapshotRewards' || fn === 'claimOperatorFees') {
      const symbol = token(entry, a[2]).symbol;
      return display(fn === 'claimOperatorFees' ? 'Claim operator fees' : 'Claim snapshot rewards', `Claim ${symbol} to ${a[0]}`, [contract, recipient, fi('Network', a[1]), fi('Reward token', symbol), fi('Vault', a[3]), fi('Expected index', a[4]), fi('Skip to index', a[5]), fi('Max rewards', a[6])]);
    }
    if (fn === 'claimCuratorFees') { const symbol = token(entry, a[2]).symbol; return display('Claim curator fees', `Claim ${symbol} to ${a[0]}`, [contract, recipient, fi('Vault', a[1]), fi('Reward token', symbol)]); }
    if (fn === 'claimProtocolFees') { const symbol = token(entry, a[1]).symbol; return display('Claim protocol fees', `Claim ${symbol} to ${a[0]}`, [contract, recipient, fi('Reward token', symbol)]); }
    if (fn === 'claimCumulativeMerkleRewards') {
      const leaf = a[2], symbol = token(entry, leaf.token).symbol;
      return display('Claim Merkle rewards', `Claim ${symbol} rewards`, [contract, recipient, fi('Network', a[1]), fi('Total entitlement', amount(entry, leaf.amount, leaf.token)), fi('Reward token', symbol), fi('Rewardee type', leaf.rewardeeType), fi('Reward data hash', leaf.rewardeeDataHash), fi('Merkle root', a[4])]);
    }
  } else if (entry.file === 'calldata-Reactor.json' && fn === 'invalidateNonce') {
    return display('Cancel RFQ request', `Cancel RFQ request ${a[0]}`, [fi('Request nonce', a[0])]);
  }
  throw new Error(`Missing independently specified display: ${entry.file}/${fn}`);
}
async function main() {
  const rows = fs.readFileSync(path.join(__dirname, 'fork-actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).sort((a, b) => `${a.to}/${a.from}/${a.data}`.localeCompare(`${b.to}/${b.from}/${b.data}`));
  const unique = new Set();
  let calldataCases = 0, typedCases = 0;
  for (const row of rows) {
    assert.equal(row.forkBlock, 25977595);
    const key = `${row.to}/${row.from}/${row.data}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const entry = byTarget.get(row.to.toLowerCase());
    assert(entry, `No descriptor for successful fork target ${row.to}`);
    const abi = Object.keys(entry.descriptor.display.formats).map(s => parseAbiItem('function ' + s));
    // The suite also verifies generic RewardsV2 dispatch, intentionally outside this descriptor's clear-signing scope.
    if (entry.file === 'calldata-RewardsV2.json' && row.data.startsWith(toFunctionSelector('claimRewards(address,address,bytes)'))) continue;
    const { functionName, args } = decodeFunctionData({ abi, data: row.data });
    const target = addr(row.to);
    const expected = expectedCall(entry, target, functionName, args);
    entry.fixture.tests.push({ description: prefix + `${row.description} (${target}, case ${calldataCases + 1})`, rawTx: serializeTransaction({ type: 'eip1559', chainId: 1, to: target, data: row.data, value: 0n, nonce: 0, gas: 30000000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1n }), expected });
    calldataCases++;
    if (entry.file.startsWith('calldata-VaultV2-') && functionName === 'permit') {
      const permit = [...fixtures.values()].find(e => e.file.startsWith('eip712-VaultV2Permit-') && e.descriptor.context.eip712.deployments[0].address === target);
      const data = structuredClone(permit.fixture.tests[0].data);
      data.message = { owner: args[0], spender: args[1], value: String(args[2]), nonce: '0', deadline: String(args[3]) };
      const signature = args[5] + args[6].slice(2) + Number(args[4]).toString(16).padStart(2, '0');
      assert.equal(await recoverTypedDataAddress({ ...data, signature }), args[0]);
      const n = amount(permit, args[2], target, true);
      permit.fixture.tests.push({ description: prefix + 'Permit signature accepted by deployed vault', data, expected: display('Authorize share spending', `Approve ${n} for ${args[1]}`, [fi('Share owner', args[0]), fi('Spender', args[1]), fi('Allowance amount', n), fi('Signature deadline', date(args[3])), fi('Nonce', 0)]) });
      typedCases++;
    }
  }
  const reactor = fixtures.get('eip712-Reactor.json');
  const orderRow = JSON.parse(fs.readFileSync(path.join(__dirname, 'fork-signed-orders.jsonl'), 'utf8').trim().split('\n').at(-1));
  const output = '(address token,uint256 amount,address recipient)';
  const request = `(address tokenIn,uint256 amountIn,${output}[] outputs,uint256 deadline,uint256 nonce,address protocol)`;
  const [order] = decodeAbiParameters(parseAbiParameters(`(${request} request,bytes swapperSignature,address swapper,address filler,${output}[] outputs)`), orderRow.order);
  function outputsFields(outputs, label) { return outputs.flatMap(o => [fi(label, amount(reactor, o.amount, o.token)), fi('Output token', o.token), fi('Output recipient', o.recipient)]); }
  const requestFields = [fi('Input token', order.request.tokenIn), fi('Exact input', amount(reactor, order.request.amountIn, order.request.tokenIn)), ...outputsFields(order.request.outputs, 'Minimum output'), fi('Deadline', date(order.request.deadline)), fi('Request nonce', order.request.nonce), fi('Protocol signer', order.request.protocol)];
  for (const primaryType of ['Request', 'Order']) {
    const reference = reactor.fixture.tests.find(t => t.data.primaryType === primaryType);
    const data = structuredClone(reference.data);
    data.message = primaryType === 'Request' ? order.request : order;
    const signature = primaryType === 'Request' ? order.swapperSignature : orderRow.protocolSignature;
    assert.equal(await recoverTypedDataAddress({ ...data, signature }), primaryType === 'Request' ? order.swapper : order.request.protocol);
    const expected = primaryType === 'Request'
      ? display('Authorize RFQ swap request', `Swap ${amount(reactor, order.request.amountIn, order.request.tokenIn)}`, requestFields)
      : display('Authorize RFQ order for filler', `Authorize RFQ fill by ${order.filler}`, [fi('Swapper', order.swapper), fi('Authorized filler', order.filler), ...requestFields, ...outputsFields(order.outputs, 'Authorized output')]);
    reactor.fixture.tests.push({ description: prefix + `${primaryType} signature consumed by deployed Reactor`, data, expected });
    typedCases++;
  }
  for (const { file, fixture } of fixtures.values()) fs.writeFileSync(path.join(root, 'testsv2', file.replace('.json', '.tests.json')), JSON.stringify(fixture, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  console.log(JSON.stringify({ calldataCases, typedCases, totalCases: [...fixtures.values()].reduce((n, e) => n + e.fixture.tests.length, 0) }));
}
main().catch(error => { console.error(error.shortMessage || error.stack); process.exitCode = 1; });
