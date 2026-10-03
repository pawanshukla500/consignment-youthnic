/**
 * Consignment identity uniqueness:
 * - document ID + Internal Shipment No stay unique (create + edit guards).
 * - marketplace Consignment/Shipment No (shipmentNo) is repeatable across
 *   internal shipments, so uniqueness guards must ignore it while lookups
 *   still resolve it.
 */
const assert = require('assert');

// Stub the datastore before loading the module under test: no DB in CI unit run.
const database = require('../config/database');
database.pgEnabled = () => false;
const helpers = require('../utils/helpers');

const seed = [
  { id: 'DOC-A', internalShipmentNo: 'SEP-PH1-S26', shipmentNo: 'MYNJ-REPEAT-1', name: 'A' },
  { id: 'DOC-B', internalShipmentNo: 'SEP-PH1-S16', shipmentNo: 'MYNJ-REPEAT-1', name: 'B' },
];

helpers.firestoreHelpers.getDocument = async (collection, id) => {
  if (collection !== 'consignments') return null;
  return seed.find((c) => c.id === id) || null;
};
helpers.firestoreHelpers.queryCollection = async (collection, field, _op, value) => {
  if (collection !== 'consignments') return [];
  return seed.filter((c) => String(c[field] || '') === String(value));
};
helpers.firestoreHelpers.getCollection = async (collection) => {
  if (collection !== 'consignments') return [];
  return seed;
};

const {
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
} = require('../utils/resolveConsignment');

(async () => {
  assert.strictEqual(buildConsignmentId('123', 'OTHER'), '123');
  assert.strictEqual(buildConsignmentId('', '123'), '123');
  assert.strictEqual(buildConsignmentId('  123  ', 'x'), '123');
  assert.strictEqual(normalizeIdentityKey('  AbC '), 'abc');

  // 1. Repeat shipmentNo must NOT conflict for uniqueness guards.
  const repeatGuard = await findConsignmentIdentityConflict({
    keys: ['MYNJ-REPEAT-1'],
    includeShipmentNo: false,
  });
  assert.strictEqual(repeatGuard, null, 'repeat shipmentNo should be allowed by uniqueness guards');

  // 2. Default lookup behaviour still resolves a repeat shipmentNo.
  const lookup = await findConsignmentIdentityConflict({ keys: ['MYNJ-REPEAT-1'] });
  assert.ok(lookup, 'lookup should still resolve by shipmentNo');
  assert.strictEqual(lookup.field, 'shipmentNo');

  // 3. Duplicate internal shipment no is still blocked (case-insensitive).
  const internalConflict = await findConsignmentIdentityConflict({
    keys: ['  sep-ph1-s26 '],
    includeShipmentNo: false,
  });
  assert.ok(internalConflict, 'duplicate internalShipmentNo must conflict');
  assert.strictEqual(internalConflict.field, 'internalShipmentNo');

  // 4. Self-edit must not conflict with itself.
  const selfEdit = await findConsignmentIdentityConflict({
    keys: ['SEP-PH1-S26'],
    excludeId: 'DOC-A',
    includeShipmentNo: false,
  });
  assert.strictEqual(selfEdit, null, 'editing own internalShipmentNo should not conflict');

  // 5. Editing to another consignment's internal no must conflict.
  const steal = await findConsignmentIdentityConflict({
    keys: ['SEP-PH1-S16'],
    excludeId: 'DOC-A',
    includeShipmentNo: false,
  });
  assert.ok(steal, 'taking another consignment internalShipmentNo must conflict');

  const conflict = {
    field: 'internalShipmentNo',
    value: '123',
    consignment: { id: '123' },
  };
  assert.ok(formatIdentityConflictError(conflict).includes('123'));
  assert.ok(formatIdentityConflictError(conflict).includes('already exists'));

  console.log('Consignment uniqueness helpers passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
