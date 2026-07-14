/**
 * H1 permission helper tests.
 * Run: node scripts/test-permissions.js
 */
const assert = require('assert');
const {
  hasPermission,
  normalizePermissions,
  DELETE_CONSIGNMENTS,
  DELETE_VIDEOS,
} = require('../utils/permissions');

assert.strictEqual(hasPermission({ role: 'admin' }, 'consignments'), true);
assert.strictEqual(hasPermission({ role: 'user', permissions: { consignments: true } }, 'consignments'), true);
assert.strictEqual(hasPermission({ role: 'user', permissions: { consignments: false } }, 'consignments'), false);
assert.strictEqual(hasPermission(null, 'consignments'), false);

const packer = normalizePermissions('user', { packing: true, consignments: false });
assert.strictEqual(packer.packing, true);
assert.strictEqual(packer.consignments, false);
assert.strictEqual(packer[DELETE_CONSIGNMENTS], false);
assert.strictEqual(packer[DELETE_VIDEOS], false);

// Non-admin cannot self-grant delete via normalize unless explicitly true
const sneaky = normalizePermissions('user', { deleteConsignments: true, deleteVideos: true });
assert.strictEqual(sneaky[DELETE_CONSIGNMENTS], true);
assert.strictEqual(sneaky[DELETE_VIDEOS], true);

const denied = normalizePermissions('user', {});
assert.strictEqual(denied[DELETE_CONSIGNMENTS], false);

const orgHead = normalizePermissions('organization_head', {
  consignments: true,
  packing: true,
  users: true,
  deleteConsignments: true,
});
assert.strictEqual(orgHead.consignments, false);
assert.strictEqual(orgHead.packing, false);
assert.strictEqual(orgHead.users, false);
assert.strictEqual(orgHead[DELETE_CONSIGNMENTS], false);
assert.strictEqual(hasPermission({ role: 'organization_head', permissions: orgHead }, 'consignments'), false);

console.log('H1 permission helper tests passed.');
