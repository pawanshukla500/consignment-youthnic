/**
 * Unit and integration tests for:
 * 1. Allowing shared Consignment No across multiple shipments.
 * 2. Enforcing strict uniqueness on Internal Shipment No.
 * 3. Editing Consignment No and Internal Shipment No on created consignments via PUT /api/consignments/:id.
 *
 * Run: node scripts/test-consignment-shared-number.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');
const path = require('path');

const consignmentsStore = new Map();

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'consignments') return Array.from(consignmentsStore.values());
      return [];
    },
    async getDocument(collection, id) {
      if (collection === 'consignments') return consignmentsStore.get(id) || null;
      return null;
    },
    async setDocument(collection, id, data) {
      const doc = { id, ...data };
      if (collection === 'consignments') consignmentsStore.set(id, doc);
      return doc;
    },
    async batchCreateMulti(items) {
      for (const [collection, id, data] of items) {
        if (collection === 'consignments') consignmentsStore.set(id, { id, ...data });
      }
    },
    async batchGetDocuments() { return []; },
    async batchSetMulti() {},
    async queryCollection(collection, field, op, val) {
      if (collection === 'consignments') {
        return Array.from(consignmentsStore.values()).filter((c) => c[field] === val);
      }
      return [];
    },
    async deleteDocument(collection, id) {
      if (collection === 'consignments') consignmentsStore.delete(id);
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

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/consignments', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function request(server, method, urlPath, body = null) {
  const { port } = server.address();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: data
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => { resBody += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: resBody ? JSON.parse(resBody) : null });
          } catch (err) {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${resBody.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  consignmentsStore.clear();
  const server = await startServer();

  try {
    // 1. Create first consignment with Consignment No MYNJ-VBXOEO310826-11 and internal shipment SEP-PH1-S26
    const res1 = await request(server, 'POST', '/api/consignments', {
      id: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S26',
      marketplaceId: 'mp1',
      warehouse: 'Mumbai',
    });
    assert.strictEqual(res1.status, 201, `Expected 201, got ${res1.status}: ${JSON.stringify(res1.json)}`);
    assert.strictEqual(res1.json.consignment.consignmentNo, 'MYNJ-VBXOEO310826-11');
    assert.strictEqual(res1.json.consignment.internalShipmentNo, 'SEP-PH1-S26');
    assert.strictEqual(res1.json.consignment.id, 'MYNJ-VBXOEO310826-11');
    const firstConsignmentId = res1.json.consignment.id;

    // 2. Create second consignment with the SAME Consignment No MYNJ-VBXOEO310826-11 but different internal shipment SEP-PH1-S27
    // Must SUCCEED because operators frequently enter the same consignment ID across multiple shipments
    const res2 = await request(server, 'POST', '/api/consignments', {
      id: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S27',
      marketplaceId: 'mp1',
      warehouse: 'Mumbai',
    });
    assert.strictEqual(res2.status, 201, `Expected 201, got ${res2.status}: ${JSON.stringify(res2.json)}`);
    assert.strictEqual(res2.json.consignment.consignmentNo, 'MYNJ-VBXOEO310826-11', 'Shared consignment number preserved');
    assert.strictEqual(res2.json.consignment.internalShipmentNo, 'SEP-PH1-S27', 'Distinct internal shipment number preserved');
    assert.notStrictEqual(res2.json.consignment.id, firstConsignmentId, 'Internal PK id must remain unique across shipments');
    const secondConsignmentId = res2.json.consignment.id;

    // 3. Attempt to create a consignment with DUPLICATE Internal Shipment No SEP-PH1-S26
    // Must FAIL with 409 CONSIGNMENT_ALREADY_EXISTS because internal shipment indexing must be unique
    const res3 = await request(server, 'POST', '/api/consignments', {
      id: 'DIFFERENT-CONS-ID',
      internalShipmentNo: 'SEP-PH1-S26',
    });
    assert.strictEqual(res3.status, 409, `Expected 409, got ${res3.status}`);
    assert.strictEqual(res3.json.code, 'CONSIGNMENT_ALREADY_EXISTS');
    assert.ok(res3.json.error.includes('SEP-PH1-S26'), 'Error message identifies the conflicting internal shipment');

    // 4. Edit consignment 1: update consignmentNo and appointmentDate
    const resEdit1 = await request(server, 'PUT', `/api/consignments/${firstConsignmentId}`, {
      consignmentNo: 'MYNJ-EDITED-99',
      appointmentDate: '2026-11-01',
    });
    assert.strictEqual(resEdit1.status, 200, `Expected 200, got ${resEdit1.status}`);
    assert.strictEqual(resEdit1.json.consignment.consignmentNo, 'MYNJ-EDITED-99', 'Consignment No updated');
    assert.strictEqual(resEdit1.json.consignment.appointmentDate, '2026-11-01');

    // 5. Edit consignment 2: update internalShipmentNo to another unique value
    const resEdit2 = await request(server, 'PUT', `/api/consignments/${secondConsignmentId}`, {
      internalShipmentNo: 'SEP-PH1-S27-RENAMED',
    });
    assert.strictEqual(resEdit2.status, 200, `Expected 200, got ${resEdit2.status}`);
    assert.strictEqual(resEdit2.json.consignment.internalShipmentNo, 'SEP-PH1-S27-RENAMED');

    // 6. Edit consignment 2: attempt to set internalShipmentNo to SEP-PH1-S26 (which consignment 1 owns)
    // Must be blocked with 409
    const resEditConflict = await request(server, 'PUT', `/api/consignments/${secondConsignmentId}`, {
      internalShipmentNo: 'SEP-PH1-S26',
    });
    assert.strictEqual(resEditConflict.status, 409, 'Duplicate internalShipmentNo rejected on update');
    assert.strictEqual(resEditConflict.json.code, 'CONSIGNMENT_ALREADY_EXISTS');

    // 7. Search by consignmentNo matches
    const resSearch = await request(server, 'GET', '/api/consignments?search=EDITED');
    assert.strictEqual(resSearch.status, 200);
    assert.strictEqual(resSearch.json.consignments.length, 1);
    assert.strictEqual(resSearch.json.consignments[0].consignmentNo, 'MYNJ-EDITED-99');

    console.log('✅ Consignment shared number & edit tests passed successfully!');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
