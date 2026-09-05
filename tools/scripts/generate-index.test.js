/**
 * Regression coverage for the index key space of generate-index.js.
 *
 * index.eip712.json keys are a tagged union: an eip155: deployment key or an
 * eip712-domain-separator: key. A consumer that resolves only by deployment
 * must keep working unchanged, which holds only while the two namespaces stay
 * disjoint, no descriptor lands in both, and keys stay normalized.
 *
 * Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { caip, domainSeparatorKey, indexDescriptor } = require('./generate-index.js');

const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const SEPARATOR = '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05';
const PERMIT = 'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)';

function emptyIndex() {
  return { calldata: {}, eip712: {} };
}

function eip712Descriptor(eip712) {
  return { context: { eip712 }, display: { formats: { [PERMIT]: { fields: [] } } } };
}

test('indexes an EIP-712 descriptor by deployment', () => {
  const index = emptyIndex();
  indexDescriptor(
    eip712Descriptor({ deployments: [{ chainId: 137, address: USDT }] }),
    'registry/permit/eip712-permit-polygon-usdt.json',
    index,
  );

  const key = caip(137, USDT);
  assert.deepEqual(Object.keys(index.eip712), [key]);
  assert.deepEqual(Object.keys(index.eip712[key]), ['Permit']);
  assert.equal(index.eip712[key].Permit[0].path, 'registry/permit/eip712-permit-polygon-usdt.json');
});

test('indexes a separator-only descriptor by its domain separator', () => {
  const index = emptyIndex();
  indexDescriptor(
    eip712Descriptor({
      domain: { name: 'USDT0', version: '1', verifyingContract: USDT },
      domainSeparator: SEPARATOR,
    }),
    'registry/permit/eip712-permit-polygon-usdt.json',
    index,
  );

  assert.deepEqual(Object.keys(index.eip712), [domainSeparatorKey(SEPARATOR)]);
});

test('does not index one descriptor under both namespaces', () => {
  const index = emptyIndex();
  indexDescriptor(
    eip712Descriptor({
      deployments: [{ chainId: 137, address: USDT }],
      domainSeparator: SEPARATOR,
    }),
    'registry/permit/eip712-permit-polygon-usdt.json',
    index,
  );

  assert.deepEqual(Object.keys(index.eip712), [caip(137, USDT)]);
});

test('a separator-bound descriptor is invisible to an exact deployment lookup', () => {
  const index = emptyIndex();
  indexDescriptor(
    eip712Descriptor({
      domain: { name: 'USDT0', version: '1', verifyingContract: USDT },
      domainSeparator: SEPARATOR,
    }),
    'registry/permit/eip712-permit-polygon-usdt.json',
    index,
  );

  assert.equal(index.eip712[caip(137, USDT)], undefined);
  assert.equal(
    Object.keys(index.eip712).some((key) => key.startsWith('eip155:')),
    false,
  );
});

test('normalizes both kinds of key', () => {
  const index = emptyIndex();
  indexDescriptor(
    eip712Descriptor({ deployments: [{ chainId: 137, address: ` ${USDT} ` }] }),
    'a.json',
    index,
  );
  indexDescriptor(
    eip712Descriptor({ domainSeparator: ` ${SEPARATOR.toUpperCase().replace('0X', '0x')} ` }),
    'b.json',
    index,
  );

  assert.deepEqual(Object.keys(index.eip712).sort(), [
    caip(137, USDT),
    domainSeparatorKey(SEPARATOR),
  ]);
});

test('the two namespaces cannot collide', () => {
  assert.equal(domainSeparatorKey(SEPARATOR).startsWith('eip155:'), false);
  assert.equal(caip(137, USDT).startsWith('eip712-domain-separator:'), false);
});

test('skips an EIP-712 descriptor with neither deployments nor a separator', () => {
  const index = emptyIndex();
  indexDescriptor(eip712Descriptor({ domain: { name: 'USDT0' } }), 'a.json', index);

  assert.deepEqual(index.eip712, {});
});

test('skips a separator-only descriptor with no display formats', () => {
  const index = emptyIndex();
  indexDescriptor({ context: { eip712: { domainSeparator: SEPARATOR } } }, 'a.json', index);

  assert.deepEqual(index.eip712, {});
});

test('leaves calldata indexing untouched', () => {
  const index = emptyIndex();
  indexDescriptor(
    { context: { contract: { deployments: [{ chainId: 137, address: USDT }] } } },
    'registry/permit/calldata-usdt.json',
    index,
  );

  assert.deepEqual(index.calldata, { [caip(137, USDT)]: 'registry/permit/calldata-usdt.json' });
  assert.deepEqual(index.eip712, {});
});
