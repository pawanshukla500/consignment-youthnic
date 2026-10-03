/**
 * Consignment identity tests.
 * Run: node scripts/test-consignment-identity.js
 *
 * Locks the uniqueness contract the list + detail editors depend on:
 * - document id + internalShipmentNo stay unique (case-insensitive,
 *   archived rows included, self excluded via excludeId)
 * - marketplace Shipment No. / Consignment No. may repeat across internal
 *   shipments (one Myntra SOR number split into SEP-PH1-S16, SEP-PH1-S26, …)
 *   unless the caller explicitly opts into includeShipmentNo.
 */
require('./ensureTestEnv');
const assert = require('assert');

const helpersPath = require.resolve('../utils/helpers');
const helpers = require('../utils/helpers');

// Two consignments sharing one marketplace number, different internals.
const store = [
  { id: 'SEP-PH1-S16', internalShipmentNo: 'SEP-PH1-S16', shipmentNo: 'MYNJ-VBXOE0310826-11', name: 'S16' },
  { id: 'SEP-PH1-S26', internalShipmentNo: 'SEP-PH1-S26', shipmentNo: 'MYNJ-VBXOE0310826-11', name: 'S26' },
  // Doc id differs from the internal number — proves the internal-only check.
  { id: 'DOC-SEP-99', internalShipmentNo: 'SEP-PH1-S99', shipmentNo: 'MYNJ-OTHER', name: 'S99' },
];

helpers.firestoreHelpers.getDocument = async (collection, id) => {
  if (collection !== 'consignments') return null;
  return store.find((c) => String(c.id) === String(id)) || null;
};
helpers.firestoreHelpers.queryCollection = async (collection, field, _op, value) => {
  if (collection !== 'consignments') return [];
  return store.filter((c) => String(c[field] || '') === String(value || ''));
};
helpers.firestoreHelpers.getCollection = async (collection) => {
  if (collection !== 'consignments') return [];
  return store.map((c) => ({ ...c }));
};

const {
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
} = require('../utils/resolveConsignment');

const run = async () => {
  // ── buildConsignmentId ─────────────────────────────────────────────
  assert.strictEqual(buildConsignmentId('CON-1', 'SEP-1'), 'CON-1');
  assert.strictEqual(buildConsignmentId('', 'SEP-1'), 'SEP-1');
  assert.strictEqual(buildConsignmentId('  ', '  '), null);

  // ── Repeated marketplace number is NOT a conflict by default ───────
  const repeatedShipment = await findConsignmentIdentityConflict({ keys: ['MYNJ-VBXOE0310826-11'] });
  assert.strictEqual(repeatedShipment, null, 'same Consignment No. must be reusable across internal shipments');

  // Opt-in lookup still finds shipmentNo hits (back-compat for resolvers).
  const optIn = await findConsignmentIdentityConflict({
    keys: ['MYNJ-VBXOE0310826-11'],
    includeShipmentNo: true,
  });
  assert.ok(optIn, 'includeShipmentNo:true must still match shipmentNo');
  assert.strictEqual(optIn.field, 'shipmentNo');

  // ── Internal Shipment No. stays unique (case-insensitive) ──────────
  const internalDup = await findConsignmentIdentityConflict({ keys: ['SEP-PH1-S99'] });
  assert.ok(internalDup, 'duplicate internalShipmentNo must conflict');
  assert.strictEqual(internalDup.field, 'internalShipmentNo');

  const internalCase = await findConsignmentIdentityConflict({ keys: ['sep-ph1-s99'] });
  assert.ok(internalCase, 'internalShipmentNo match must be case-insensitive');

  // ── Document id stays unique ───────────────────────────────────────
  const idDup = await findConsignmentIdentityConflict({ keys: ['SEP-PH1-S26'] });
  assert.ok(idDup, 'duplicate document id must conflict');

  // ── excludeId lets a consignment keep its own number on edit ───────
  const selfEdit = await findConsignmentIdentityConflict({
    keys: ['SEP-PH1-S16'],
    excludeId: 'SEP-PH1-S16',
  });
  assert.strictEqual(selfEdit, null, 'editing a consignment without changing its number must not conflict');

  const otherEdit = await findConsignmentIdentityConflict({
    keys: ['SEP-PH1-S26'],
    excludeId: 'SEP-PH1-S16',
  });
  assert.ok(otherEdit, 'taking another consignment’s internal number must conflict');

  // ── Error labels ───────────────────────────────────────────────────
  assert.ok(formatIdentityConflictError({ field: 'internalShipmentNo', value: 'SEP-1' }).includes('Internal Shipment No.'));
  assert.ok(formatIdentityConflictError({ field: 'shipmentNo', value: 'M-1' }).includes('Shipment No.'));
  assert.ok(formatIdentityConflictError({ field: 'id', value: 'C-1' }).includes('Consignment ID'));

  // ── Create-route contract: shipmentNo must not be part of the check ─
  // The route builds keys from [resolvedId, requestedId, internal] only. A
  // regression that re-adds shipmentNo would reject the valid second split
  // of a repeated marketplace number, so assert the source stays clean.
  const fs = require('fs');
  const routeSrc = fs.readFileSync(require.resolve('../routes/consignments'), 'utf8');
  const createBlock = routeSrc.slice(
    routeSrc.indexOf('const conflict = await findConsignmentIdentityConflict({'),
    routeSrc.indexOf('const conflict = await findConsignmentIdentityConflict({') + 400
  );
  assert.ok(
    createBlock.includes('trimmedInternal') && !createBlock.includes('shipmentNo'),
    'create conflict keys must be [resolvedId, requestedId, internal] — never shipmentNo'
  );

  console.log('✅ consignment identity tests passed');
};

run().catch((err) => {
  console.error('❌ consignment identity tests failed:', err.message);
  process.exit(1);
});
