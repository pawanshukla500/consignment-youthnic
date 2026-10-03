/**
 * Consignment identity: internal shipment stays unique.
 * Consignment No. can be repeated across different internal shipments.
 */
const assert = require('assert');
const {
  buildConsignmentId,
  formatIdentityConflictError,
  normalizeIdentityKey,
  planIdentityUpdate,
} = require('../utils/resolveConsignment');

assert.strictEqual(buildConsignmentId('MYNJ-1', 'SEP-S26'), 'SEP-S26');
assert.strictEqual(buildConsignmentId('', '123'), '123');
assert.strictEqual(buildConsignmentId('  MYNJ-1  ', '  SEP-S26  '), 'SEP-S26');
assert.strictEqual(buildConsignmentId('MYNJ-1', ''), 'MYNJ-1');
assert.strictEqual(buildConsignmentId('', 'SEP PH1'), 'SEP_PH1');
assert.strictEqual(normalizeIdentityKey('  AbC '), 'abc');

const conflict = {
  field: 'internalShipmentNo',
  value: 'SEP-S26',
  consignment: { id: 'SEP-S26' },
};
const message = formatIdentityConflictError(conflict);
assert.ok(message.includes('SEP-S26'));
assert.ok(message.includes('already used'));
assert.ok(message.toLowerCase().includes('consignment no'));

const repeatNumber = planIdentityUpdate(
  { id: 'SEP-S26', internalShipmentNo: 'SEP-S26', consignmentNo: 'MYNJ-1' },
  { consignmentNo: 'MYNJ-1' }
);
assert.strictEqual(repeatNumber.ok, true);
assert.strictEqual(repeatNumber.moveId, false);
assert.deepStrictEqual(repeatNumber.keys, []);
assert.strictEqual(repeatNumber.nextConsignmentNo, 'MYNJ-1');

const renamedInternal = planIdentityUpdate(
  { id: 'SEP-S26', internalShipmentNo: 'SEP-S26', consignmentNo: 'MYNJ-1' },
  { internalShipmentNo: 'SEP-S16' }
);
assert.strictEqual(renamedInternal.moveId, true);
assert.strictEqual(renamedInternal.nextId, 'SEP-S16');
assert.ok(renamedInternal.keys.includes('SEP-S16'));

const legacyIdStays = planIdentityUpdate(
  { id: 'MYNJ-1', internalShipmentNo: 'SEP-S26', pendingExternalId: false },
  { internalShipmentNo: 'SEP-S16', consignmentNo: 'MYNJ-1' }
);
assert.strictEqual(legacyIdStays.moveId, false);
assert.strictEqual(legacyIdStays.nextId, 'MYNJ-1');
assert.strictEqual(legacyIdStays.nextConsignmentNo, 'MYNJ-1');
assert.ok(legacyIdStays.keys.includes('SEP-S16'));

const missingInternal = planIdentityUpdate(
  { id: 'SEP-S26', internalShipmentNo: 'SEP-S26' },
  { internalShipmentNo: '   ' }
);
assert.strictEqual(missingInternal.ok, false);

console.log('Consignment uniqueness helpers passed.');
