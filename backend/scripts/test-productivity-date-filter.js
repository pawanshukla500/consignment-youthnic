/**
 * Tests for date-wise productivity filtering and detailed packed SKU/box reporting.
 *
 * Verifies:
 * 1. resolveProductivityDateRanges normalizes date-only strings (YYYY-MM-DD) into full UTC day windows.
 * 2. computePackedSkusAndBoxes correctly aggregates SKUs, quantities, box counts, and consignments.
 * 3. End-to-end GET /api/productivity returns packedBoxes, packedSkus, and accurate totals.
 *
 * Run: node scripts/test-productivity-date-filter.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');
const path = require('path');

const productivityStore = [];
const boxesStore = [];
const consignmentsStore = [];
const usersStore = [];

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'productivity') return productivityStore;
      if (collection === 'boxes') return boxesStore;
      if (collection === 'consignments') return consignmentsStore;
      if (collection === 'users') return usersStore;
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
const { resolveProductivityDateRanges, computePackedSkusAndBoxes } = router.__testables;

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

function testDateRangeNormalization() {
  // Single date YYYY-MM-DD
  const single = resolveProductivityDateRanges({ startDate: '2026-09-28', endDate: '2026-09-28' });
  assert.strictEqual(single.rangeStart, '2026-09-28T00:00:00.000Z', 'startDate must start at midnight UTC');
  assert.strictEqual(single.rangeEnd, '2026-09-28T23:59:59.999Z', 'endDate must end at end of day UTC');

  // Date range YYYY-MM-DD
  const range = resolveProductivityDateRanges({ startDate: '2026-09-20', endDate: '2026-09-28' });
  assert.strictEqual(range.rangeStart, '2026-09-20T00:00:00.000Z');
  assert.strictEqual(range.rangeEnd, '2026-09-28T23:59:59.999Z');

  // date param YYYY-MM-DD
  const dateParam = resolveProductivityDateRanges({ date: '2026-09-28' });
  assert.strictEqual(dateParam.rangeStart, '2026-09-28T00:00:00.000Z');
  assert.strictEqual(dateParam.rangeEnd, '2026-09-28T23:59:59.999Z');

  console.log('testDateRangeNormalization passed.');
}

function testComputePackedSkusAndBoxes() {
  const boxMap = new Map([
    ['c1_box_1', {
      id: 'c1_box_1',
      consignmentId: 'c1',
      boxNo: '1',
      items: [
        { skuId: 's1', internalSku: 'SKU-A', marketplaceSku: 'M-SKU-A', barcode: '111', qty: 5 },
        { skuId: 's2', internalSku: 'SKU-B', marketplaceSku: 'M-SKU-B', barcode: '222', qty: 3 },
      ],
      totalQty: 8,
    }],
    ['c1_box_2', {
      id: 'c1_box_2',
      consignmentId: 'c1',
      boxNo: '2',
      items: [
        { skuId: 's1', internalSku: 'SKU-A', marketplaceSku: 'M-SKU-A', barcode: '111', qty: 7 },
      ],
      totalQty: 7,
    }],
  ]);

  const consignmentMap = {
    c1: { id: 'c1', internalShipmentNo: 'VB-SHIP-001' },
  };

  const userMap = {
    u1: { id: 'u1', name: 'John Doe' },
  };

  const boxRecords = [
    { id: 'p1', consignmentId: 'c1', boxNo: '1', eventType: 'box_saved', itemsCount: 8, userId: 'u1', timestamp: '2026-09-28T10:00:00.000Z' },
    { id: 'p2', consignmentId: 'c1', boxNo: '2', eventType: 'box_saved', itemsCount: 7, userId: 'u1', timestamp: '2026-09-28T14:30:00.000Z' },
  ];

  const { packedBoxes, packedSkus } = computePackedSkusAndBoxes(boxRecords, boxMap, consignmentMap, userMap);

  assert.strictEqual(packedBoxes.length, 2, '2 boxes packed');
  assert.strictEqual(packedBoxes[0].internalShipmentNo, 'VB-SHIP-001');
  assert.strictEqual(packedBoxes[0].packerName, 'John Doe');
  assert.strictEqual(packedBoxes[0].items.length, 2);

  assert.strictEqual(packedSkus.length, 2, '2 unique SKUs');
  // SKU-A was 5 in box 1 + 7 in box 2 = 12 total
  assert.strictEqual(packedSkus[0].internalSku, 'SKU-A');
  assert.strictEqual(packedSkus[0].packedQty, 12);
  assert.strictEqual(packedSkus[0].boxCount, 2, 'SKU-A was in 2 boxes');

  // SKU-B was 3 in box 1
  assert.strictEqual(packedSkus[1].internalSku, 'SKU-B');
  assert.strictEqual(packedSkus[1].packedQty, 3);
  assert.strictEqual(packedSkus[1].boxCount, 1);

  console.log('testComputePackedSkusAndBoxes passed.');
}

async function testApiEndpoint() {
  productivityStore.length = 0;
  boxesStore.length = 0;
  consignmentsStore.length = 0;
  usersStore.length = 0;

  usersStore.push({ id: 'u1', name: 'Alice Packer' });
  consignmentsStore.push({ id: 'c100', internalShipmentNo: 'SHIP-SEP-28' });

  // A box saved on September 28 at 3:15 PM UTC
  const sep28Event = '2026-09-28T15:15:00.000Z';
  const sep20Event = '2026-09-20T11:00:00.000Z';

  boxesStore.push({
    id: 'c100_box_1',
    consignmentId: 'c100',
    boxNo: '1',
    items: [
      { skuId: 'sku_tshirt', internalSku: 'TSHIRT-RED-M', marketplaceSku: 'AMZ-TS-RED', barcode: '890123', qty: 10 },
      { skuId: 'sku_cap', internalSku: 'CAP-BLU-OS', marketplaceSku: 'AMZ-CAP-BLU', barcode: '890456', qty: 4 },
    ],
    totalQty: 14,
    createdAt: sep28Event,
  });

  productivityStore.push({
    id: 'prod_1',
    consignmentId: 'c100',
    boxNo: '1',
    eventType: 'box_saved',
    itemsCount: 14,
    items: [
      { skuId: 'sku_tshirt', internalSku: 'TSHIRT-RED-M', marketplaceSku: 'AMZ-TS-RED', barcode: '890123', qty: 10 },
      { skuId: 'sku_cap', internalSku: 'CAP-BLU-OS', marketplaceSku: 'AMZ-CAP-BLU', barcode: '890456', qty: 4 },
    ],
    userId: 'u1',
    timestamp: sep28Event,
  });

  // Out-of-window box (Sep 20)
  productivityStore.push({
    id: 'prod_old',
    consignmentId: 'c100',
    boxNo: '99',
    eventType: 'box_saved',
    itemsCount: 50,
    userId: 'u1',
    timestamp: sep20Event,
  });

  const server = await startServer();
  try {
    // 1. Single day filter matching Sept 28
    {
      const { status, json } = await get(server, '/api/productivity?startDate=2026-09-28&endDate=2026-09-28');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.summary.totalBoxes, 1, 'must find 1 box on 2026-09-28');
      assert.strictEqual(json.summary.totalItems, 14, 'must count 14 units on 2026-09-28');
      assert.strictEqual(json.summary.uniqueSkus, 2, '2 unique SKUs');
      assert.strictEqual(json.summary.uniqueConsignments, 1, '1 consignment');

      assert.ok(Array.isArray(json.packedBoxes), 'packedBoxes must be an array');
      assert.strictEqual(json.packedBoxes.length, 1);
      assert.strictEqual(json.packedBoxes[0].boxNo, '1');
      assert.strictEqual(json.packedBoxes[0].internalShipmentNo, 'SHIP-SEP-28');
      assert.strictEqual(json.packedBoxes[0].packerName, 'Alice Packer');
      assert.strictEqual(json.packedBoxes[0].items.length, 2);

      assert.ok(Array.isArray(json.packedSkus), 'packedSkus must be an array');
      assert.strictEqual(json.packedSkus.length, 2);
      assert.strictEqual(json.packedSkus[0].internalSku, 'TSHIRT-RED-M');
      assert.strictEqual(json.packedSkus[0].packedQty, 10);
      assert.strictEqual(json.packedSkus[1].internalSku, 'CAP-BLU-OS');
      assert.strictEqual(json.packedSkus[1].packedQty, 4);
    }

    // 2. Date with no activity (Sept 27)
    {
      const { status, json } = await get(server, '/api/productivity?startDate=2026-09-27&endDate=2026-09-27');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.summary.totalBoxes, 0, 'no boxes on 2026-09-27');
      assert.strictEqual(json.summary.totalItems, 0, 'no units on 2026-09-27');
      assert.strictEqual(json.packedBoxes.length, 0);
      assert.strictEqual(json.packedSkus.length, 0);
    }

    // 3. Multi-day range covering both events (Sept 20 to Sept 28)
    {
      const { status, json } = await get(server, '/api/productivity?startDate=2026-09-20&endDate=2026-09-28');
      assert.strictEqual(status, 200);
      assert.strictEqual(json.summary.totalBoxes, 2, 'both boxes matched in range');
      assert.strictEqual(json.summary.totalItems, 64, '14 + 50 = 64 units');
    }

    console.log('testApiEndpoint passed.');
  } finally {
    server.close();
  }
}

async function runAll() {
  testDateRangeNormalization();
  testComputePackedSkusAndBoxes();
  await testApiEndpoint();
  console.log('All productivity date filter & packed SKU tests passed successfully!');
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
