/**
 * Regression test for GET /api/consignments' workflowBucket filter.
 *
 * Reproduces the CodeRabbit finding on PR #46: the bucket filter used to be
 * applied only on the client, against whatever page had already loaded —
 * so filtering to a bucket that isn't on page 1 could show zero results
 * even though matches exist, and the reported "total" was wrong. This test
 * boots the real consignments router (auth/permissions mocked, document
 * fallback only — no live Postgres in this environment) and asserts the
 * bucket filter is applied BEFORE total/pagination are computed.
 *
 * Run: node scripts/test-consignments-bucket-filter.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');
const path = require('path');

const consignmentsStore = [];

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'consignments') return consignmentsStore;
      return [];
    },
    async getDocument() { return null; },
    async setDocument(collection, id, data) { return { id, ...data }; },
    async batchGetDocuments() { return []; },
    async batchSetMulti() {},
    async queryCollection() { return []; },
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

const router = require('../routes/consignments');

function baseConsignment(overrides) {
  return {
    totalRequiredQty: 10,
    totalPackedQty: 0,
    boxIds: [],
    skuIds: [],
    stageConfirmations: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedFixture() {
  consignmentsStore.length = 0;
  // 6 'new' consignments (pending pack, Planned ship, no confirmations)
  for (let i = 1; i <= 6; i++) {
    consignmentsStore.push(baseConsignment({
      id: `new-${i}`, internalShipmentNo: `NEW-${i}`,
      status: 'pending', shipmentStatus: 'Planned',
    }));
  }
  // 4 'active' consignments (in_progress pack)
  for (let i = 1; i <= 4; i++) {
    consignmentsStore.push(baseConsignment({
      id: `active-${i}`, internalShipmentNo: `ACTIVE-${i}`,
      status: 'in_progress', shipmentStatus: 'Under Packing', totalPackedQty: 3,
    }));
  }
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/consignments', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function get(server, urlPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${body.slice(0, 300)}`));
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  seedFixture();
  const server = await startServer();

  try {
    // 1. Unfiltered request — unchanged behavior, total covers everything.
    {
      const { status, json } = await get(server, '/api/consignments?limit=4&page=1');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.total, 10, 'unfiltered total must count every consignment');
      assert.strictEqual(json.consignments.length, 4, 'page size respected');
    }

    // 2. Bucket filter, page 1 — must return only 'new' items, and total
    //    must be the TRUE bucket-filtered count (6), not the page size or
    //    the unfiltered total (10).
    {
      const { status, json } = await get(server, '/api/consignments?workflowBucket=new&limit=4&page=1');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.total, 6, `bucket-filtered total must be 6, got ${json.total}`);
      assert.strictEqual(json.consignments.length, 4, 'page 1 returns a full page of matches');
      assert.ok(json.consignments.every((c) => c.listPriorityBucket === 'new'), 'every row on page 1 must be in the requested bucket');
      assert.strictEqual(json.hasMore, true, 'more new-bucket rows remain beyond page 1');
    }

    // 3. Bucket filter, page 2 — the remaining 2 'new' items, not empty and
    //    not active-bucket items leaking in. This is exactly the scenario
    //    the old client-side-only filter would get wrong once a bucket's
    //    rows didn't all fit on the requested page.
    {
      const { status, json } = await get(server, '/api/consignments?workflowBucket=new&limit=4&page=2');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.consignments.length, 2, `page 2 must hold the remaining 2 new-bucket rows, got ${json.consignments.length}`);
      assert.ok(json.consignments.every((c) => c.listPriorityBucket === 'new'), 'page 2 rows must still be in the requested bucket');
      assert.strictEqual(json.hasMore, false, 'no more pages after the last new-bucket row');
    }

    // 4. A different bucket filter must not see the other bucket's rows at all.
    {
      const { status, json } = await get(server, '/api/consignments?workflowBucket=active&limit=10&page=1');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.total, 4, 'active-bucket total must be 4');
      assert.ok(json.consignments.every((c) => c.listPriorityBucket === 'active'), 'active filter must exclude new-bucket rows');
    }

    // 5. An unknown/invalid bucket value must be ignored, not error or return empty.
    {
      const { status, json } = await get(server, '/api/consignments?workflowBucket=not-a-real-bucket&limit=4&page=1');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.total, 10, 'invalid workflowBucket value falls back to unfiltered results');
    }

    console.log('Consignments workflowBucket filter tests passed.');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
