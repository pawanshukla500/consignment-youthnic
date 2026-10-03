/**
 * Consignment identity: Internal Shipment No is unique; marketplace Consignment No may be reused.
 */
const assert = require('assert');
const {
  buildConsignmentId,
  formatIdentityConflictError,
  normalizeIdentityKey,
  normalizeCreateIdentity,
  uniqueIdentityKeys,
  displayConsignmentNo,
  pickResolvedConsignment,
} = require('../utils/resolveConsignment');

assert.strictEqual(buildConsignmentId('MYNJ-SHARED', 'SEP-PH1-S26'), 'SEP-PH1-S26');
assert.strictEqual(buildConsignmentId('', '123'), '123');
assert.strictEqual(buildConsignmentId('  123  ', 'SEP-PH1-S16'), 'SEP-PH1-S16');
assert.strictEqual(buildConsignmentId('only-external', ''), 'only-external');
assert.strictEqual(normalizeIdentityKey('  AbC '), 'abc');

const created = normalizeCreateIdentity({
  id: 'MYNJ-VBXOEO310826-11',
  internalShipmentNo: 'SEP-PH1-S26',
});
assert.strictEqual(created.resolvedId, 'SEP-PH1-S26');
assert.strictEqual(created.trimmedConsignmentNo, 'MYNJ-VBXOEO310826-11');
assert.strictEqual(created.trimmedInternal, 'SEP-PH1-S26');
assert.strictEqual(created.pendingExternalId, false);

const pending = normalizeCreateIdentity({ internalShipmentNo: 'SEP-PH1-S27' });
assert.strictEqual(pending.resolvedId, 'SEP-PH1-S27');
assert.strictEqual(pending.trimmedConsignmentNo, '');
assert.strictEqual(pending.pendingExternalId, true);

const keys = uniqueIdentityKeys({
  resolvedId: created.resolvedId,
  internalShipmentNo: created.trimmedInternal,
  consignmentNo: created.trimmedConsignmentNo,
});
assert.deepStrictEqual(keys, ['SEP-PH1-S26']);
assert.ok(!keys.includes('MYNJ-VBXOEO310826-11'), 'marketplace consignment no is not a uniqueness key');

const second = normalizeCreateIdentity({
  consignmentNo: 'MYNJ-VBXOEO310826-11',
  internalShipmentNo: 'SEP-PH1-S16',
});
assert.strictEqual(second.resolvedId, 'SEP-PH1-S16');
assert.strictEqual(second.trimmedConsignmentNo, 'MYNJ-VBXOEO310826-11');
assert.notStrictEqual(second.resolvedId, created.resolvedId);

assert.strictEqual(
  displayConsignmentNo({ id: 'SEP-PH1-S26', consignmentNo: 'MYNJ-VBXOEO310826-11' }),
  'MYNJ-VBXOEO310826-11'
);

const conflict = {
  field: 'internalShipmentNo',
  value: 'SEP-PH1-S26',
  consignment: { id: 'SEP-PH1-S26' },
};
assert.ok(formatIdentityConflictError(conflict).includes('SEP-PH1-S26'));
assert.ok(formatIdentityConflictError(conflict).includes('already exists'));
assert.ok(formatIdentityConflictError(conflict).includes('same Consignment No'));

const uniqueMatch = pickResolvedConsignment([
  { id: 'SEP-PH1-S26', internalShipmentNo: 'SEP-PH1-S26', consignmentNo: 'MYNJ-SHARED' },
], 'SEP-PH1-S26');
assert.strictEqual(uniqueMatch.id, 'SEP-PH1-S26');

const sharedNo = pickResolvedConsignment([
  { id: 'SEP-PH1-S26', internalShipmentNo: 'SEP-PH1-S26', consignmentNo: 'MYNJ-SHARED' },
], 'MYNJ-SHARED');
assert.strictEqual(sharedNo.id, 'SEP-PH1-S26');

let ambiguous = false;
try {
  pickResolvedConsignment([
    { id: 'SEP-PH1-S26', internalShipmentNo: 'SEP-PH1-S26', consignmentNo: 'MYNJ-SHARED' },
    { id: 'SEP-PH1-S16', internalShipmentNo: 'SEP-PH1-S16', consignmentNo: 'MYNJ-SHARED' },
  ], 'MYNJ-SHARED');
} catch (e) {
  ambiguous = e.code === 'AMBIGUOUS_CONSIGNMENT_ID';
}
assert.ok(ambiguous, 'shared consignment no must not pick a random internal shipment');

console.log('Consignment uniqueness helpers passed.');
