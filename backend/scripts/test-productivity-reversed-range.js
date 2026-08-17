/**
 * Regression test for a reversed startDate/endDate on GET /api/productivity,
 * specifically through the document-fallback code path (the same class of
 * bug as test-consignments-bucket-filter.js: a fix that lived only in a
 * pure helper function didn't actually reach the route handler's own
 * inline usage of the raw, unnormalized query params).
 *
 * Boots the real productivity router (auth/permissions mocked, no live
 * Postgres in this environment so pgEnabled() is false and every request
 * exercises the document-fallback branch directly) and asserts that a
 * request with startDate after endDate still returns the records in the
 * (normalized) range instead of silently empty results.
 *
 * Run: node scripts/test-productivity-reversed-range.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');
const path = require('path');

const productivityStore = [];

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'productivity') return productivityStore;
      return [];
    },
    async getDocument() { return null; },
    async setDocument(collection, id, data) { return { id, ...data }; },
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
installMock(path.join(__dirname, '..', 'utils', 'resend.js'), {
  isResendConfigured: () => false,
  sendViaResend: async () => ({ ok: true }),
});
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

const router = require('../routes/productivity');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/productivity', router);
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
  productivityStore.length = 0;
  const earlier = '2026-06-01T12:00:00.000Z';
  const later = '2026-06-05T12:00:00.000Z';
  productivityStore.push(
    { id: 'p1', eventType: 'box_saved', timestamp: earlier, itemsCount: 5, userId: 'u1' },
    { id: 'p2', eventType: 'box_saved', timestamp: later, itemsCount: 3, userId: 'u1' },
    // Outside the [earlier, later] window entirely — must never be counted.
    { id: 'p3', eventType: 'box_saved', timestamp: '2020-01-01T00:00:00.000Z', itemsCount: 99, userId: 'u1' },
  );

  const server = await startServer();
  try {
    // Forward order (startDate <= endDate) — sanity baseline.
    {
      const { status, json } = await get(server, `/api/productivity?startDate=${encodeURIComponent(earlier)}&endDate=${encodeURIComponent(later)}&limit=50`);
      assert.strictEqual(status, 200);
      assert.strictEqual(json.summary.totalBoxes, 2, `forward range must match both in-window records: ${JSON.stringify(json.summary)}`);
      assert.strictEqual(json.recentActivity.length, 2, 'recentActivity must include both in-window records');
    }

    // Reversed order (startDate after endDate) — must resolve to the SAME
    // result as the forward-order request above, not silently empty.
    {
      const { status, json } = await get(server, `/api/productivity?startDate=${encodeURIComponent(later)}&endDate=${encodeURIComponent(earlier)}&limit=50`);
      assert.strictEqual(status, 200);
      assert.strictEqual(json.summary.totalBoxes, 2, `reversed range must still match both in-window records, got: ${JSON.stringify(json.summary)}`);
      assert.strictEqual(json.recentActivity.length, 2, 'reversed range must still return recentActivity, not silently empty');
      assert.ok(json.dailyTrend.some((d) => d.boxes > 0), 'reversed range must still populate a non-empty daily trend');
    }

    console.log('Productivity reversed-range fallback tests passed.');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
