/**
 * Test for Consignment No editing, multi-shipment shared Consignment No,
 * and internal shipment uniqueness enforcement.
 *
 * Verifies:
 * 1. Multiple shipments can share the same marketplace Consignment No.
 * 2. Each shipment must have a unique internalShipmentNo (duplicates rejected with 409).
 * 3. Consignment No on existing consignments can be edited without uniqueness rejection.
 * 4. Internal shipment number collision on edit is rejected with 409.
 * 5. Reassigning official ID allows sharing Consignment No across shipments.
 * 6. Search and lookup works by both consignmentNo and internalShipmentNo.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');
const path = require('path');

const consignmentsStore = [];
const relatedStore = {};

const fakeHelpers = {
  generateId: (prefix = 'c') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'consignments') return consignmentsStore;
      return relatedStore[collection] || [];
    },
    async getDocument(collection, id) {
      if (collection === 'consignments') {
        return consignmentsStore.find((c) => c.id === id) || null;
      }
      return (relatedStore[collection] || []).find((r) => r.id === id) || null;
    },
    async setDocument(collection, id, data) {
      const doc = { id, ...data };
      if (collection === 'consignments') {
        const idx = consignmentsStore.findIndex((c) => c.id === id);
        if (idx >= 0) consignmentsStore[idx] = doc;
        else consignmentsStore.push(doc);
      } else {
        if (!relatedStore[collection]) relatedStore[collection] = [];
        const idx = relatedStore[collection].findIndex((r) => r.id === id);
        if (idx >= 0) relatedStore[collection][idx] = doc;
        else relatedStore[collection].push(doc);
      }
      return doc;
    },
    async deleteDocument(collection, id) {
      if (collection === 'consignments') {
        const idx = consignmentsStore.findIndex((c) => c.id === id);
        if (idx >= 0) consignmentsStore.splice(idx, 1);
      } else if (relatedStore[collection]) {
        const idx = relatedStore[collection].findIndex((r) => r.id === id);
        if (idx >= 0) relatedStore[collection].splice(idx, 1);
      }
    },
    async batchGetDocuments() { return []; },
    async batchSetMulti() {},
    async batchCreateMulti(items) {
      for (const [collection, id, data] of items) {
        await fakeHelpers.firestoreHelpers.setDocument(collection, id, data);
      }
    },
    async queryCollection(collection, field, op, val) {
      const arr = collection === 'consignments' ? consignmentsStore : (relatedStore[collection] || []);
      return arr.filter((item) => {
        if (op === '==' || op === '===') return item[field] === val;
        return false;
      });
    },
  },
};

function installMock(relativePath, exportsObj) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].exports = exportsObj;
  require.cache[resolved].loaded = true;
}

installMock(path.join(__dirname, '..', 'utils', 'helpers.js'), fakeHelpers);
installMock(path.join(__dirname, '..', 'middleware', 'auth.js'), {
  authenticateToken: (req, res, next) => {
    req.user = { id: 'test-admin', name: 'Test Admin', role: 'admin', permissions: {} };
    next();
  },
  requireRole: () => (req, res, next) => next(),
  loadFreshUserRecord: async () => null,
  currentTokenVersion: () => 0,
  DEFAULT_USER: {},
  JWT_SECRET: 'test-only-jwt-secret-ci-do-not-use-in-production',
});
installMock(path.join(__dirname, '..', 'utils', 'permissions.js'), {
  BASE_PERMISSIONS: {},
  DELETE_CONSIGNMENTS: 'deleteConsignments',
  DELETE_VIDEOS: 'deleteVideos',
  EDIT_BOX_QUANTITIES: 'editBoxQuantities',
  isElevatedRole: () => true,
  normalizePermissions: (p) => p || {},
  hasPermission: () => true,
  requestUserHasPermission: () => true,
  requestUserHasAnyPermission: () => true,
  requirePermission: () => (req, res, next) => next(),
  requireAnyPermission: () => (req, res, next) => next(),
});
installMock(path.join(__dirname, '..', 'config', 'database.js'), {
  pgEnabled: () => false,
  getPool: () => null,
});

const { router } = require('../routes/consignments');
const { resolveConsignmentByKey } = require('../utils/resolveConsignment');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/consignments', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function requestJson(server, method, pathname, body = null) {
  const port = server.address().port;
  const postData = body ? JSON.stringify(body) : null;
  const options = {
    hostname: '127.0.0.1',
    port,
    path: pathname,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  const server = await startServer();
  try {
    consignmentsStore.length = 0;

    console.log('Test 1: Create consignment 1 with Consignment No and Internal Shipment No');
    const res1 = await requestJson(server, 'POST', '/api/consignments', {
      id: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S26',
      marketplaceId: 'myntra',
      warehouse: 'Mumbai',
      skus: [{ barcode: 'SKU1', requiredQty: 10 }],
    });
    assert.strictEqual(res1.status, 201, `Expected 201, got ${res1.status}: ${JSON.stringify(res1.body)}`);
    assert.strictEqual(res1.body.consignment.id, 'MYNJ-VBXOEO310826-11');
    assert.strictEqual(res1.body.consignment.consignmentNo, 'MYNJ-VBXOEO310826-11');
    assert.strictEqual(res1.body.consignment.internalShipmentNo, 'SEP-PH1-S26');

    console.log('Test 2: Create consignment 2 sharing the SAME Consignment No with DIFFERENT Internal Shipment No');
    const res2 = await requestJson(server, 'POST', '/api/consignments', {
      id: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S16',
      marketplaceId: 'myntra',
      warehouse: 'Mumbai',
      skus: [{ barcode: 'SKU2', requiredQty: 5 }],
    });
    assert.strictEqual(res2.status, 201, `Expected 201, got ${res2.status}: ${JSON.stringify(res2.body)}`);
    // Should NOT conflict! Document id is derived safely from internalShipmentNo while consignmentNo stores the marketplace id
    assert.strictEqual(res2.body.consignment.consignmentNo, 'MYNJ-VBXOEO310826-11');
    assert.strictEqual(res2.body.consignment.internalShipmentNo, 'SEP-PH1-S16');
    assert.notStrictEqual(res2.body.consignment.id, res1.body.consignment.id, 'Documents must have distinct primary keys');

    console.log('Test 3: Reject creation when Internal Shipment No already exists');
    const res3 = await requestJson(server, 'POST', '/api/consignments', {
      id: 'OTHER-ID-999',
      internalShipmentNo: 'SEP-PH1-S26', // Collision with consignment 1
      marketplaceId: 'myntra',
      skus: [{ barcode: 'SKU3', requiredQty: 2 }],
    });
    assert.strictEqual(res3.status, 409, `Expected 409, got ${res3.status}`);
    assert.strictEqual(res3.body.code, 'CONSIGNMENT_ALREADY_EXISTS');
    assert.strictEqual(res3.body.field, 'internalShipmentNo');

    console.log('Test 4: Edit Consignment No on existing consignment to a shared value');
    const c2Id = res2.body.consignment.id;
    const resEdit = await requestJson(server, 'PUT', `/api/consignments/${c2Id}`, {
      consignmentNo: 'SHARED-CONS-001',
    });
    assert.strictEqual(resEdit.status, 200, `Expected 200, got ${resEdit.status}: ${JSON.stringify(resEdit.body)}`);
    assert.strictEqual(resEdit.body.consignment.consignmentNo, 'SHARED-CONS-001');

    console.log('Test 5: Also edit Consignment 1 to share the SAME Consignment No');
    const c1Id = res1.body.consignment.id;
    const resEdit1 = await requestJson(server, 'PUT', `/api/consignments/${c1Id}`, {
      consignmentNo: 'SHARED-CONS-001',
    });
    assert.strictEqual(resEdit1.status, 200, `Expected 200, got ${resEdit1.status}`);
    assert.strictEqual(resEdit1.body.consignment.consignmentNo, 'SHARED-CONS-001');

    console.log('Test 6: Reject editing Internal Shipment No to a conflicting value');
    const resEditConflict = await requestJson(server, 'PUT', `/api/consignments/${c2Id}`, {
      internalShipmentNo: 'SEP-PH1-S26', // Already used by consignment 1
    });
    assert.strictEqual(resEditConflict.status, 409, `Expected 409, got ${resEditConflict.status}`);
    assert.strictEqual(resEditConflict.body.code, 'CONSIGNMENT_ALREADY_EXISTS');

    console.log('Test 7: Allow editing Internal Shipment No to a new unique value');
    const resEditInternal = await requestJson(server, 'PUT', `/api/consignments/${c2Id}`, {
      internalShipmentNo: 'SEP-PH1-S16-RENAMED',
    });
    assert.strictEqual(resEditInternal.status, 200, `Expected 200, got ${resEditInternal.status}`);
    assert.strictEqual(resEditInternal.body.consignment.internalShipmentNo, 'SEP-PH1-S16-RENAMED');

    console.log('Test 8: Reassign official ID handles shared Consignment No cleanly');
    const resReassign = await requestJson(server, 'POST', `/api/consignments/${c2Id}/reassign-id`, {
      newConsignmentId: 'OFFICIAL-MARKETPLACE-100',
    });
    assert.strictEqual(resReassign.status, 200, `Expected 200, got ${resReassign.status}: ${JSON.stringify(resReassign.body)}`);

    const resReassignShared = await requestJson(server, 'POST', `/api/consignments/${c1Id}/reassign-id`, {
      newConsignmentId: 'OFFICIAL-MARKETPLACE-100',
    });
    assert.strictEqual(resReassignShared.status, 200, `Expected 200, got ${resReassignShared.status}: ${JSON.stringify(resReassignShared.body)}`);
    assert.strictEqual(resReassignShared.body.consignment.consignmentNo, 'OFFICIAL-MARKETPLACE-100');

    console.log('Test 9: Search consignments by Consignment No');
    const searchRes = await requestJson(server, 'GET', '/api/consignments?search=OFFICIAL-MARKETPLACE-100');
    assert.strictEqual(searchRes.status, 200);
    assert.strictEqual(searchRes.body.consignments.length, 2, 'Should find both shipments sharing this Consignment No');

    console.log('Test 10: Search consignments by Internal Shipment No');
    const searchInternal = await requestJson(server, 'GET', '/api/consignments?search=SEP-PH1-S26');
    assert.strictEqual(searchInternal.status, 200);
    assert.strictEqual(searchInternal.body.consignments.length, 1, 'Should find only the specific internal shipment');

    console.log('Test 11: resolveConsignmentByKey resolves by internalShipmentNo and consignmentNo');
    const resolvedByInternal = await resolveConsignmentByKey('SEP-PH1-S26');
    assert.ok(resolvedByInternal, 'Should resolve by internal shipment no');
    assert.strictEqual(resolvedByInternal.internalShipmentNo, 'SEP-PH1-S26');

    const resolvedByConsNo = await resolveConsignmentByKey('OFFICIAL-MARKETPLACE-100');
    assert.ok(resolvedByConsNo, 'Should resolve by consignment no');

    console.log('All consignment editing and identity tests passed successfully!');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
