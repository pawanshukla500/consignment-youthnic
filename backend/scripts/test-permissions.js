/**
 * H1 permission helper tests.
 * Run: node scripts/test-permissions.js
 */
const assert = require('assert');
const {
  hasPermission,
  normalizePermissions,
  isElevatedRole,
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

assert.strictEqual(isElevatedRole('admin'), true);
assert.strictEqual(isElevatedRole('organization_head'), true);
assert.strictEqual(isElevatedRole('user'), false);

// Organization Head = full access by default (same operational surface as admin).
const orgHead = normalizePermissions('organization_head', {
  consignments: false,
  packing: false,
  users: false,
  deleteConsignments: false,
});
assert.strictEqual(orgHead.consignments, true);
assert.strictEqual(orgHead.packing, true);
assert.strictEqual(orgHead.users, true);
assert.strictEqual(orgHead.productivity, true);
assert.strictEqual(orgHead.marketplaces, true);
assert.strictEqual(orgHead.auditLogs, true);
assert.strictEqual(orgHead.inventoryPlanning, true);
assert.strictEqual(orgHead[DELETE_CONSIGNMENTS], true);
assert.strictEqual(orgHead[DELETE_VIDEOS], true);
assert.strictEqual(hasPermission({ role: 'organization_head', permissions: orgHead }, 'consignments'), true);
assert.strictEqual(hasPermission({ role: 'organization_head', permissions: {} }, 'users'), true);

console.log('H1 permission helper tests passed.');
