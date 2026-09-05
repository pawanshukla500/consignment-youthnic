const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendClient } = require('../src/backendClient.cjs');
const { ensureDesktopSchema, checkDesktopSchema } = require('../../backend/utils/desktopSchema');

test('old server 404 is a server upgrade error, not an incorrect consignment or offline mode', async (t) => {
  t.mock.method(global, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'POST');
    return new Response('Cannot POST /api/desktop/status', { status: 404 });
  });
  await assert.rejects(new BackendClient({ baseUrl: 'https://fixture.invalid/api' }).checkCompatibility(), { code: 'DESKTOP_SERVER_UPGRADE_REQUIRED', status: 409 });
});

test('connected server with missing desktop tables cannot pass compatibility', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ ready: false, code: 'DESKTOP_SCHEMA_REQUIRED' }), { status: 503 }));
  await assert.rejects(new BackendClient({ baseUrl: 'https://fixture.invalid/api' }).checkCompatibility(), { code: 'DESKTOP_SERVER_UPGRADE_REQUIRED' });
});

test('HTML fallback and wrong protocol cannot be mistaken for compatible JSON', async (t) => {
  const client = new BackendClient({ baseUrl: 'https://fixture.invalid/api' });
  t.mock.method(global, 'fetch', async () => new Response('<html>web app</html>'));
  await assert.rejects(client.checkCompatibility(), { code: 'DESKTOP_SERVER_UPGRADE_REQUIRED' });
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ ready: true, protocolVersion: 99 })));
  await assert.rejects(client.checkCompatibility(), { code: 'DESKTOP_SERVER_UPGRADE_REQUIRED' });
});

test('readiness probes required columns and station uniqueness, without writes', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); return { rows: sql.includes('pg_indexes') ? [{ indexdef: "CREATE UNIQUE INDEX idx ON packing_station_leases(consignment_id) WHERE status = 'active'" }] : [] }; } };
  assert.equal((await checkDesktopSchema(pool)).ready, true);
  assert.ok(queries.every((sql) => sql.startsWith('SELECT')));
  assert.ok(queries.some((sql) => sql.includes('payload_hash')));
  assert.equal((await checkDesktopSchema({ async query() { throw Object.assign(new Error('missing'), { code: '42P01' }); } })).code, 'DESKTOP_SCHEMA_REQUIRED');
  assert.equal((await checkDesktopSchema({ async query() { return { rows: [] }; } })).ready, false);
  assert.equal((await checkDesktopSchema(null)).code, 'DESKTOP_DATABASE_UNAVAILABLE');
});

test('startup schema only adds desktop structures and keeps provider-specific RLS separate', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); } };
  await ensureDesktopSchema(pool);
  assert.ok(queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS packing_station_leases')));
  assert.ok(queries.some((sql) => sql.includes('ENABLE ROW LEVEL SECURITY')));
  const desktopTableSql = queries.filter((sql) => sql.includes('packing_box_operations') || sql.includes('packing_station_leases')).join('\n');
  assert.doesNotMatch(desktopTableSql, /REFERENCES\s+consignments/i);
  assert.ok(queries.every((sql) => !/DROP|DELETE|TRUNCATE/.test(sql.replaceAll('ON DELETE CASCADE', ''))));
  queries.length = 0;
  await ensureDesktopSchema(pool, { isCockroach: true });
  assert.ok(queries.every((sql) => !sql.includes('ROW LEVEL SECURITY')));
});
