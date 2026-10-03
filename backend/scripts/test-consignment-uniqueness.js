/**
 * Consignment identity uniqueness & editing tests:
 * - Internal Shipment No. MUST remain strictly unique across all consignments.
 * - Consignment No. / Consignment ID CAN be reused across different internal shipments.
 * - Editing Consignment No. updates consignmentNo / shipmentNo without breaking document identity.
 */
require('./ensureTestEnv');
const assert = require('assert');
const helpers = require('../utils/helpers');

// Set up in-memory datastore for standalone test
const store = new Map();
helpers.firestoreHelpers = {
  async getDocument(coll, id) {
    return store.get(`${coll}:${id}`) ? JSON.parse(JSON.stringify(store.get(`${coll}:${id}`))) : null;
  },
  async setDocument(coll, id, data) {
    const item = { ...data, id };
    store.set(`${coll}:${id}`, JSON.parse(JSON.stringify(item)));
    return item;
  },
  async deleteDocument(coll, id) {
    store.delete(`${coll}:${id}`);
    return true;
  },
  async queryCollection(coll, field, op, val) {
    const res = [];
    for (const [k, v] of store.entries()) {
      if (k.startsWith(`${coll}:`) && v[field] === val) {
        res.push(JSON.parse(JSON.stringify(v)));
      }
    }
    return res;
  },
  async getCollection(coll) {
    const res = [];
    for (const [k, v] of store.entries()) {
      if (k.startsWith(`${coll}:`)) res.push(JSON.parse(JSON.stringify(v)));
    }
    return res;
  },
};

const {
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
  resolveConsignmentByKey,
} = require('../utils/resolveConsignment');
const { reassignConsignmentId } = require('../utils/consignmentIdMigration');

async function runTests() {
  assert.strictEqual(buildConsignmentId('123', 'OTHER'), '123');
  assert.strictEqual(buildConsignmentId('', '123'), '123');
  assert.strictEqual(buildConsignmentId('  123  ', 'x'), '123');
  assert.strictEqual(normalizeIdentityKey('  AbC '), 'abc');

  const conflict = {
    field: 'internalShipmentNo',
    value: 'SEP-PH1-S26',
    consignment: { id: 'c1', internalShipmentNo: 'SEP-PH1-S26' },
  };
  assert.ok(formatIdentityConflictError(conflict).includes('SEP-PH1-S26'));
  assert.ok(formatIdentityConflictError(conflict).includes('already exists'));

  // Seed two consignments sharing the SAME consignmentNo but DIFFERENT internalShipmentNo
  const c1 = {
    id: 'MYNJ-VBXOEO310826-11',
    consignmentNo: 'MYNJ-VBXOEO310826-11',
    internalShipmentNo: 'SEP-PH1-S26',
    shipmentNo: 'MYNJ-VBXOEO310826-11',
    status: 'pending',
  };
  const c2 = {
    id: 'SEP-PH1-S27',
    consignmentNo: 'MYNJ-VBXOEO310826-11', // same consignmentNo as c1!
    internalShipmentNo: 'SEP-PH1-S27',
    shipmentNo: 'MYNJ-VBXOEO310826-11',
    status: 'pending',
  };

  await helpers.firestoreHelpers.setDocument('consignments', c1.id, c1);
  await helpers.firestoreHelpers.setDocument('consignments', c2.id, c2);

  // 1. Conflict check on duplicate internalShipmentNo should FAIL
  const conflict1 = await findConsignmentIdentityConflict({
    internalShipmentNo: 'SEP-PH1-S26',
  });
  assert.ok(conflict1, 'Should detect conflict for duplicate internalShipmentNo SEP-PH1-S26');
  assert.strictEqual(conflict1.field, 'internalShipmentNo');

  // 2. Conflict check on unique internalShipmentNo should PASS (even with same consignmentNo)
  const conflict2 = await findConsignmentIdentityConflict({
    internalShipmentNo: 'SEP-PH1-S28',
  });
  assert.strictEqual(conflict2, null, 'Unique internal shipment should not conflict');

  // 3. Exclude ID check when editing an existing consignment
  const conflictSelf = await findConsignmentIdentityConflict({
    internalShipmentNo: 'SEP-PH1-S26',
    excludeId: 'MYNJ-VBXOEO310826-11',
  });
  assert.strictEqual(conflictSelf, null, 'Updating own consignment should exclude self');

  const conflictOther = await findConsignmentIdentityConflict({
    internalShipmentNo: 'SEP-PH1-S26',
    excludeId: 'SEP-PH1-S27',
  });
  assert.ok(conflictOther, 'Changing internal shipment to another existing internal shipment must conflict');

  // 4. Resolve consignment by unique internalShipmentNo
  const resolvedInternal1 = await resolveConsignmentByKey('SEP-PH1-S26');
  assert.strictEqual(resolvedInternal1?.id, 'MYNJ-VBXOEO310826-11');

  const resolvedInternal2 = await resolveConsignmentByKey('SEP-PH1-S27');
  assert.strictEqual(resolvedInternal2?.id, 'SEP-PH1-S27');

  // 5. Reassign official ID when target ID is already a document ID in another consignment
  // Should set consignmentNo and shipmentNo without throwing or colliding with the primary key
  const reassignRes = await reassignConsignmentId('SEP-PH1-S27', 'MYNJ-VBXOEO310826-11', 'user-1');
  assert.strictEqual(reassignRes.ok, true, 'Reassign should succeed even if target ID is already used as doc ID');
  assert.strictEqual(reassignRes.newId, 'SEP-PH1-S27', 'Keeps unique document ID to prevent collision');
  assert.strictEqual(reassignRes.consignment.consignmentNo, 'MYNJ-VBXOEO310826-11');

  // Cleanup test documents
  await helpers.firestoreHelpers.deleteDocument('consignments', c1.id);
  await helpers.firestoreHelpers.deleteDocument('consignments', c2.id);

  console.log('✅ Consignment uniqueness & multi-shipment duplicate consignment ID tests passed.');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
