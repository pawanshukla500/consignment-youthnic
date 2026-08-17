/**
 * Behavioral tests for the new dashboard analytics aggregation
 * (routes/productivity.js buildDashboardAnalytics / getRecentDaysTrend).
 *
 * Mocks firestoreHelpers (in-memory) so this runs with no live Postgres,
 * matching this repo's other scripts/test-*.js conventions.
 *
 * Run: node scripts/test-dashboard-analytics.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

const consignmentsStore = [];
const marketplacesStore = [
  { id: 'mp1', name: 'Amazon' },
  { id: 'mp2', name: 'Myntra' },
];

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection === 'consignments') return consignmentsStore;
      if (collection === 'marketplaces') return marketplacesStore;
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

const router = require('../routes/productivity');
const { buildDashboardAnalytics, getRecentDaysTrend } = router.__testables;
const { buildMarketplaceMap } = require('../utils/dispatchPlanning');
const { invalidateMarketplaceCache } = require('../utils/reportingCache');

function confirmedStage(qty) {
  return { confirmedAt: new Date().toISOString(), confirmedByUserId: 'u1', confirmedByName: 'Tester', note: null, details: qty != null ? { receivedQty: qty } : {} };
}

async function testBuildDashboardAnalytics() {
  consignmentsStore.length = 0;
  invalidateMarketplaceCache();

  consignmentsStore.push(
    // c1: brand new — bucket 'new'
    { id: 'c1', marketplaceId: 'mp1', totalRequiredQty: 100, totalPackedQty: 0, status: 'pending', shipmentStatus: 'Planned', stageConfirmations: {} },
    // c2: in progress packing — bucket 'active'
    { id: 'c2', marketplaceId: 'mp1', totalRequiredQty: 50, totalPackedQty: 20, status: 'in_progress', shipmentStatus: 'Under Packing', stageConfirmations: {} },
    // c3: inward completed, matched, archived — bucket 'archived'
    {
      id: 'c3', marketplaceId: 'mp2', totalRequiredQty: 80, totalPackedQty: 80, status: 'completed', shipmentStatus: 'Inwarded',
      operationalStatus: 'archived', isArchived: true,
      stageConfirmations: {
        packing_completed: confirmedStage(), ready_for_invoice: confirmedStage(), invoice_created: confirmedStage(),
        ready_for_dispatch: confirmedStage(), dispatched: confirmedStage(), inward_completed: confirmedStage(80),
      },
    },
    // c4: inward completed WITH an open dispute — bucket 'disputed'
    {
      id: 'c4', marketplaceId: 'mp2', totalRequiredQty: 40, totalPackedQty: 40, status: 'completed', shipmentStatus: 'Inwarded',
      operationalStatus: 'disputed',
      stageConfirmations: {
        packing_completed: confirmedStage(), ready_for_invoice: confirmedStage(), invoice_created: confirmedStage(),
        ready_for_dispatch: confirmedStage(), dispatched: confirmedStage(), inward_completed: confirmedStage(39),
      },
      inwardDisputes: [{ id: 'd1', status: 'open', shippedQty: 40, inwardQty: 39, disputedQty: 1 }],
    },
    // c5: no marketplace assigned — groups under 'Unassigned'. Uses an
    // in_progress pack status (bucket 'active', same as c2) so it doesn't
    // collide with c1's 'new' bucket and muddy that assertion.
    { id: 'c5', marketplaceId: '', totalRequiredQty: 10, totalPackedQty: 10, status: 'in_progress', shipmentStatus: 'Under Packing', stageConfirmations: {} },
  );

  const marketplaceMap = await buildMarketplaceMap(fakeHelpers.firestoreHelpers);
  const result = await buildDashboardAnalytics(marketplaceMap);

  assert.strictEqual(result.totalConsignments, 5, 'totalConsignments must count every row');
  assert.strictEqual(result.disputedCount, 1, 'only c4 has an open dispute');
  assert.strictEqual(result.workflowBuckets.new, 1, 'c1 -> new');
  assert.strictEqual(result.workflowBuckets.active, 2, 'c2 + c5 -> active');
  assert.strictEqual(result.workflowBuckets.archived, 1, 'c3 -> archived');
  assert.strictEqual(result.workflowBuckets.disputed, 1, 'c4 -> disputed');
  assert.ok(Object.prototype.hasOwnProperty.call(result.workflowBuckets, 'inwarded'), 'zero-count buckets still present as keys');

  const mp1 = result.marketplaceBreakdown.find((m) => m.id === 'mp1');
  const mp2 = result.marketplaceBreakdown.find((m) => m.id === 'mp2');
  const unassigned = result.marketplaceBreakdown.find((m) => m.id === 'unassigned');
  assert.ok(mp1 && mp1.name === 'Amazon' && mp1.count === 2, `mp1 breakdown: ${JSON.stringify(mp1)}`);
  assert.strictEqual(mp1.required, 150, 'mp1 required sums c1+c2');
  assert.strictEqual(mp1.packed, 20, 'mp1 packed sums c1+c2');
  assert.ok(mp2 && mp2.name === 'Myntra' && mp2.count === 2, `mp2 breakdown: ${JSON.stringify(mp2)}`);
  assert.ok(unassigned && unassigned.count === 1, 'unassigned marketplaceId groups separately');
  // Sorted descending by count — mp1/mp2 (2 each) must precede unassigned (1).
  assert.ok(result.marketplaceBreakdown.indexOf(unassigned) > result.marketplaceBreakdown.indexOf(mp1), 'sorted desc by count');

  console.log('buildDashboardAnalytics tests passed.');
}

function testGetRecentDaysTrend() {
  const today = new Date();
  const records = [
    { eventType: 'box_saved', timestamp: today.toISOString() },
    { eventType: 'box_saved', timestamp: today.toISOString() },
    { eventType: 'scan', timestamp: today.toISOString() }, // must be ignored — not box_saved
  ];
  const trend14 = getRecentDaysTrend(records, 14);
  assert.strictEqual(trend14.length, 14, 'default window is 14 days');
  assert.strictEqual(trend14[13].value, 2, `today's bucket must count only the 2 box_saved events: ${JSON.stringify(trend14[13])}`);
  assert.strictEqual(trend14.slice(0, 13).every((d) => d.value === 0), true, 'no other day has activity');

  const labels = trend14.map((d) => d.label);
  assert.strictEqual(new Set(labels).size, 14, `labels must be unique across 14 days, got: ${labels.join(', ')}`);

  const trend7 = getRecentDaysTrend(records, 7);
  assert.strictEqual(trend7.length, 7, 'custom window size respected');

  console.log('getRecentDaysTrend tests passed.');
}

(async () => {
  await testBuildDashboardAnalytics();
  testGetRecentDaysTrend();
  console.log('Dashboard analytics tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
