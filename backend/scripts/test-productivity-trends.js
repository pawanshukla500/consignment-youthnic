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
const { computeDailyTrend, computeTopPackers, resolveProductivityDateRanges } = router.__testables;

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

  // Regression: a user whose box_saved records carry two DIFFERENT embedded
  // userName values (e.g. logged before and after a display-name change,
  // with no live users-map entry) must still collapse into ONE leaderboard
  // row with ONE deterministic name — never two rows for the same userId,
  // and never a name that depends on which record happened to be seen first.
  const mixedNameRecords = [
    { eventType: 'box_saved', timestamp: daysAgoIso(2), itemsCount: 5, userId: 'u4', userName: 'Priya Singh' },
    { eventType: 'box_saved', timestamp: daysAgoIso(1), itemsCount: 3, userId: 'u4', userName: 'Priya S.' },
  ];
  const forward = computeTopPackers(mixedNameRecords, {}, startMs, endMs, 10);
  const reversed = computeTopPackers([...mixedNameRecords].reverse(), {}, startMs, endMs, 10);
  assert.strictEqual(forward.length, 1, `u4's two records must collapse into a single row: ${JSON.stringify(forward)}`);
  assert.strictEqual(forward[0].boxes, 2, 'boxes must still sum across both differently-named records');
  // Assert the actual expected value, not just forward===reversed — a
  // deterministic but wrong rule (e.g. lexical minimum) would also satisfy
  // order-independence alone. 'Priya Singh' > 'Priya S.' lexicographically
  // ('i' > '.'), matching the documented MAX(...) tie-break.
  assert.strictEqual(forward[0].userName, 'Priya Singh', 'fallback must match the documented lexical-maximum tie-break');
  assert.strictEqual(forward[0].userName, reversed[0].userName, 'resolved name must not depend on record iteration order');

  console.log('computeTopPackers tests passed.');
}

function testResolveProductivityDateRanges() {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // No filters at all — both totals and trend fall back to a 14-day window.
  {
    const { rangeStart, rangeEnd, trendStartIso, trendEndIso } = resolveProductivityDateRanges({});
    assert.strictEqual(rangeStart, undefined, 'no synthetic rangeStart when nothing was supplied');
    assert.strictEqual(rangeEnd, undefined, 'no synthetic rangeEnd when nothing was supplied');
    const spanDays = Math.round((new Date(trendEndIso) - new Date(trendStartIso)) / DAY_MS);
    assert.strictEqual(spanDays, 13, `default trend window must be 14 days (13 days apart), got ${spanDays}`);
  }

  // Regression: only endDate supplied. Before the fix, rangeStart defaulted
  // to 1970-01-01 and leaked into trendStartIso, producing a decades-long
  // window. It must now stay bounded to ~14 days ending at endDate.
  {
    const endDate = '2026-06-01T00:00:00.000Z';
    const { rangeStart, trendStartIso, trendEndIso } = resolveProductivityDateRanges({ endDate });
    assert.strictEqual(rangeStart, '1970-01-01T00:00:00.000Z', 'totals query is still allowed its all-time epoch default');
    assert.strictEqual(trendEndIso, endDate, 'trend end must be the explicit endDate');
    const spanDays = Math.round((new Date(trendEndIso) - new Date(trendStartIso)) / DAY_MS);
    assert.strictEqual(spanDays, 13, `trend window must stay bounded to 14 days even with only endDate given, got ${spanDays} days (trendStartIso=${trendStartIso})`);
    assert.notStrictEqual(trendStartIso, '1970-01-01T00:00:00.000Z', 'trend window must never inherit the epoch default');
  }

  // Only startDate supplied, within the span cap — trend end is "now",
  // trend start is the explicit startDate verbatim (unclamped, since it's
  // inside the 92-day cap).
  {
    const startDate = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const { rangeEnd, trendStartIso, trendEndIso } = resolveProductivityDateRanges({ startDate });
    assert.strictEqual(trendStartIso, startDate, 'trend start must be the explicit startDate when within the span cap');
    assert.ok(rangeEnd, 'totals rangeEnd still defaults to now');
    assert.strictEqual(trendEndIso, rangeEnd, 'trend end mirrors the totals "now" default when only startDate is given');
  }

  // Both supplied — trend window matches the explicit range exactly, no matter its size.
  {
    const startDate = '2020-01-01T00:00:00.000Z';
    const endDate = '2020-03-01T00:00:00.000Z';
    const { trendStartIso, trendEndIso } = resolveProductivityDateRanges({ startDate, endDate });
    assert.strictEqual(trendStartIso, startDate);
    assert.strictEqual(trendEndIso, endDate);
  }

  // Single `date` filter — trend window is that exact UTC day, not 14 days,
  // and not truncated by a local-time end-of-day computation (regression:
  // setHours instead of setUTCHours would render only 00:00-07:00 UTC of
  // the requested day in e.g. America/Los_Angeles).
  {
    const { trendStartIso, trendEndIso } = resolveProductivityDateRanges({ date: '2026-05-10' });
    assert.strictEqual(trendStartIso, '2026-05-10T00:00:00.000Z', `trend start must be exact UTC midnight, got ${trendStartIso}`);
    assert.strictEqual(trendEndIso, '2026-05-10T23:59:59.999Z', `trend end must cover the full UTC day, got ${trendEndIso}`);
  }

  // Same check under a non-UTC TZ env — this is exactly the scenario the
  // setHours/setUTCHours bug only reproduces under.
  {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const { trendStartIso, trendEndIso } = resolveProductivityDateRanges({ date: '2026-05-10' });
      assert.strictEqual(trendStartIso, '2026-05-10T00:00:00.000Z', `TZ=America/Los_Angeles: trend start must still be UTC midnight, got ${trendStartIso}`);
      assert.strictEqual(trendEndIso, '2026-05-10T23:59:59.999Z', `TZ=America/Los_Angeles: trend end must still cover the full UTC day, got ${trendEndIso}`);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  }

  // Explicit range wider than the cap must be clamped, not passed through
  // verbatim (Greptile finding: an uncapped explicit span still forces
  // per-day generate_series/loop work proportional to the span).
  {
    const startDate = '2000-01-01T00:00:00.000Z';
    const endDate = '2020-01-01T00:00:00.000Z';
    const { trendStartIso, trendEndIso } = resolveProductivityDateRanges({ startDate, endDate });
    assert.strictEqual(trendEndIso, endDate, 'trend end still honors the explicit endDate');
    const spanDays = Math.round((new Date(trendEndIso) - new Date(trendStartIso)) / DAY_MS);
    // 91 days apart = 92 inclusive daily buckets, matching MAX_TREND_SPAN_DAYS.
    assert.strictEqual(spanDays, 91, `a 92-bucket cap must clamp to 91 days apart, got ${spanDays} days`);
    assert.notStrictEqual(trendStartIso, startDate, 'the original 20-year-wide startDate must not pass through unclamped');
  }

  // Regression: a reversed explicit range (startDate after endDate — e.g.
  // from custom date-picker inputs with no min/max relationship enforced)
  // must be normalized, not passed through. Otherwise every downstream
  // query matches zero rows and the page silently renders empty analytics.
  {
    const laterDate = '2026-06-10T00:00:00.000Z';
    const earlierDate = '2026-06-01T00:00:00.000Z';
    const { rangeStart, rangeEnd, trendStartIso, trendEndIso } = resolveProductivityDateRanges({
      startDate: laterDate, endDate: earlierDate,
    });
    assert.strictEqual(rangeStart, earlierDate, 'totals rangeStart must be the earlier date after normalization');
    assert.strictEqual(rangeEnd, laterDate, 'totals rangeEnd must be the later date after normalization');
    assert.strictEqual(trendStartIso, earlierDate, 'trend start must be the earlier date after normalization');
    assert.strictEqual(trendEndIso, laterDate, 'trend end must be the later date after normalization');
    assert.ok(new Date(trendEndIso) > new Date(trendStartIso), 'normalized window must be non-negative');
  }

  console.log('resolveProductivityDateRanges tests passed.');
}

(async () => {
  testComputeDailyTrend();
  testComputeTopPackers();
  testResolveProductivityDateRanges();
  console.log('Productivity trend/leaderboard tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
