/**
 * Behavioral tests for the /productivity daily-trend + top-packers leaderboard
 * (routes/productivity.js computeDailyTrend / computeTopPackers — the
 * document-fallback mirror of pgHelpers.queryProductivityStats' trendSql /
 * topPackersSql).
 *
 * Mocks firestoreHelpers (in-memory) so this runs with no live Postgres,
 * matching this repo's other scripts/test-*.js conventions.
 *
 * Run: node scripts/test-productivity-trends.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection() { return []; },
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
const { computeDailyTrend, computeTopPackers } = router.__testables;

function daysAgoIso(n, hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function testComputeDailyTrend() {
  const startMs = new Date(daysAgoIso(6, 0)).getTime();
  const endMs = new Date(daysAgoIso(0, 23)).getTime();

  const records = [
    { eventType: 'box_saved', timestamp: daysAgoIso(6), itemsCount: 5 },
    { eventType: 'box_saved', timestamp: daysAgoIso(6), itemsCount: 3 },
    { eventType: 'box_saved', timestamp: daysAgoIso(3), itemsCount: 10 },
    { eventType: 'box_saved', timestamp: daysAgoIso(0), itemsCount: 7 },
    // Outside the window — must be excluded from every bucket.
    { eventType: 'box_saved', timestamp: daysAgoIso(9), itemsCount: 999 },
  ];

  const trend = computeDailyTrend(records, startMs, endMs);

  assert.strictEqual(trend.length, 7, 'window is inclusive of both endpoints (6 days ago .. today = 7 days)');
  assert.strictEqual(trend[0].boxes, 2, `oldest day must count its 2 box_saved events: ${JSON.stringify(trend[0])}`);
  assert.strictEqual(trend[0].items, 8, 'oldest day items = 5 + 3');
  assert.strictEqual(trend[3].boxes, 1, `3-days-ago bucket: ${JSON.stringify(trend[3])}`);
  assert.strictEqual(trend[6].boxes, 1, `today's bucket: ${JSON.stringify(trend[6])}`);
  assert.ok(trend.slice(1, 3).every((d) => d.boxes === 0), 'days with no activity are zero-filled, not omitted');
  assert.strictEqual(new Set(trend.map((d) => d.date)).size, 7, 'every day has a unique date key');
  assert.strictEqual(new Set(trend.map((d) => d.label)).size, 7, 'every day has a unique display label');

  const totalBoxesInTrend = trend.reduce((sum, d) => sum + d.boxes, 0);
  assert.strictEqual(totalBoxesInTrend, 4, 'the out-of-window record (9 days ago) must never be counted');

  console.log('computeDailyTrend tests passed.');
}

function testComputeTopPackers() {
  const startMs = new Date(daysAgoIso(6, 0)).getTime();
  const endMs = new Date(daysAgoIso(0, 23)).getTime();
  const userMap = {
    u1: { id: 'u1', name: 'Aditya Shah' },
    u2: { id: 'u2', name: 'Chandan Yadav' },
  };

  const records = [
    { eventType: 'box_saved', timestamp: daysAgoIso(2), itemsCount: 10, userId: 'u1' },
    { eventType: 'box_saved', timestamp: daysAgoIso(1), itemsCount: 8, userId: 'u1' },
    { eventType: 'box_saved', timestamp: daysAgoIso(1), itemsCount: 6, userId: 'u2' },
    // Record carries its own userName — must win over the users-collection lookup.
    { eventType: 'box_saved', timestamp: daysAgoIso(0), itemsCount: 4, userId: 'u3', userName: 'Guest Packer' },
    // No userId at all — must be excluded from the leaderboard entirely.
    { eventType: 'box_saved', timestamp: daysAgoIso(0), itemsCount: 2, userId: '' },
    // Outside the window — must not count toward u1's total.
    { eventType: 'box_saved', timestamp: daysAgoIso(9), itemsCount: 100, userId: 'u1' },
  ];

  const packers = computeTopPackers(records, userMap, startMs, endMs, 10);

  assert.strictEqual(packers.length, 3, `expected 3 distinct packers (u1, u2, u3): ${JSON.stringify(packers)}`);
  assert.strictEqual(packers[0].userId, 'u1', 'u1 has the most boxes (2) and must rank first');
  assert.strictEqual(packers[0].boxes, 2, 'u1 boxes = 2 within window (the 9-days-ago record is excluded)');
  assert.strictEqual(packers[0].items, 18, 'u1 items = 10 + 8');
  assert.strictEqual(packers[0].userName, 'Aditya Shah', 'name resolved from the users map');

  const u3 = packers.find((p) => p.userId === 'u3');
  assert.ok(u3, 'u3 must appear even though absent from userMap');
  assert.strictEqual(u3.userName, 'Guest Packer', "the record's own userName wins over an (absent) users-map lookup");

  assert.ok(!packers.some((p) => p.userId === ''), 'records with no userId are excluded from the leaderboard');

  const limited = computeTopPackers(records, userMap, startMs, endMs, 1);
  assert.strictEqual(limited.length, 1, 'limit is respected');
  assert.strictEqual(limited[0].userId, 'u1', 'limit keeps the highest-ranked packer');

  console.log('computeTopPackers tests passed.');
}

(async () => {
  testComputeDailyTrend();
  testComputeTopPackers();
  console.log('Productivity trend/leaderboard tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
