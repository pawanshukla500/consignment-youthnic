/**
 * Consignment identity uniqueness: same ID / Internal Shipment No cannot be created twice.
 */
const assert = require('assert');
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
  value: '123',
  consignment: { id: '123' },
};
assert.ok(formatIdentityConflictError(conflict).includes('123'));
assert.ok(formatIdentityConflictError(conflict).includes('already exists'));

console.log('Consignment uniqueness helpers passed.');
