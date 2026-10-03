/**
 * Consignment identity edit rules:
 * - document id + internalShipmentNo stay unique (case-insensitive, incl. archived)
 * - external shipmentNo (marketplace Consignment No) may repeat across shipments
 * - PUT /:id validates internalShipmentNo changes with excludeId, trims shipmentNo
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildConsignmentId,
  formatIdentityConflictError,
  normalizeIdentityKey,
} = require('../utils/resolveConsignment');

assert.strictEqual(buildConsignmentId('123', 'OTHER'), '123');
assert.strictEqual(buildConsignmentId('', '123'), '123');
assert.strictEqual(buildConsignmentId('  123  ', 'x'), '123');
assert.strictEqual(normalizeIdentityKey('  AbC '), 'abc');

const conflict = {
  field: 'internalShipmentNo',
  value: 'SEP-PH1-S26',
  consignment: { id: 'SEP-PH1-S26' },
};
assert.ok(formatIdentityConflictError(conflict).includes('SEP-PH1-S26'));
assert.ok(formatIdentityConflictError(conflict).includes('already exists'));

// Regression guard: the uniqueness check must not treat shipmentNo as unique.
// Otherwise the same marketplace Consignment No could not repeat across
// different internal shipments.
const resolveSrc = fs.readFileSync(
  path.join(__dirname, '..', 'utils', 'resolveConsignment.js'),
  'utf8'
);
const conflictFn = resolveSrc.slice(
  resolveSrc.indexOf('async function findConsignmentIdentityConflict')
);
assert.ok(conflictFn, 'findConsignmentIdentityConflict should exist');
assert.ok(
  !conflictFn.includes("data->>'shipmentNo'"),
  'uniqueness check must ignore shipmentNo so duplicates are allowed'
);
assert.ok(
  conflictFn.includes("data->>'internalShipmentNo'"),
  'uniqueness check must still cover internalShipmentNo'
);

// Route guards: POST must not block on shipmentNo; PUT must validate
// internalShipmentNo edits with excludeId while trimming shipmentNo.
const routeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'consignments.js'),
  'utf8'
);
assert.ok(
  routeSrc.includes('keys: [resolvedId, trimmedRequestedId, trimmedInternal]'),
  'POST conflict keys must exclude shipmentNo'
);
assert.ok(
  !routeSrc.includes('[resolvedId, trimmedRequestedId, trimmedInternal, shipmentNo]'),
  'POST must no longer pass shipmentNo into the uniqueness check'
);
assert.ok(
  routeSrc.includes("keys: [trimmedInternal]") && routeSrc.includes('excludeId: id'),
  'PUT must validate changed internalShipmentNo with excludeId'
);

console.log('Consignment identity edit rules passed.');
