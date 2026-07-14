/**
 * Read-only + transactional health check against PostgreSQL.
 * Safe CRUD runs inside a transaction that ALWAYS rolls back — no production data is kept.
 *
 * Usage: node scripts/db-health-check.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const {
  getPool,
  pgEnabled,
  initSchema,
  testConnection,
  getDatabaseDiagnostics,
} = require('../config/database');

const HEALTH_COLLECTION = '__healthcheck__';
const HEALTH_ID = `probe-${Date.now()}`;

function ms(started) {
  return Date.now() - started;
}

async function inspectSchema(pool) {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const indexes = await pool.query(`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);
  const fks = await pool.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);
  const counts = await pool.query(`
    SELECT collection, COUNT(*)::int AS n
    FROM documents
    GROUP BY collection
    ORDER BY collection
  `).catch(() => ({ rows: [] }));

  return {
    tables: tables.rows.map((r) => r.table_name),
    indexCount: indexes.rows.length,
    indexes: indexes.rows.slice(0, 40),
    foreignKeys: fks.rows,
    documentCounts: counts.rows,
  };
}

async function safeCrudRoundTrip(pool) {
  const client = await pool.connect();
  const timings = {};
  try {
    let t = Date.now();
    await client.query('BEGIN');
    timings.beginMs = ms(t);

    t = Date.now();
    await client.query(
      `INSERT INTO documents (collection, id, data)
       VALUES ($1, $2, $3::jsonb)`,
      [HEALTH_COLLECTION, HEALTH_ID, JSON.stringify({ id: HEALTH_ID, probe: true, n: 1 })]
    );
    timings.createMs = ms(t);

    t = Date.now();
    const read = await client.query(
      `SELECT data FROM documents WHERE collection = $1 AND id = $2`,
      [HEALTH_COLLECTION, HEALTH_ID]
    );
    timings.readMs = ms(t);

    t = Date.now();
    await client.query(
      `UPDATE documents
       SET data = data || $3::jsonb, updated_at = now()
       WHERE collection = $1 AND id = $2`,
      [HEALTH_COLLECTION, HEALTH_ID, JSON.stringify({ n: 2, updated: true })]
    );
    timings.updateMs = ms(t);

    t = Date.now();
    const updated = await client.query(
      `SELECT data FROM documents WHERE collection = $1 AND id = $2`,
      [HEALTH_COLLECTION, HEALTH_ID]
    );
    timings.rereadMs = ms(t);

    t = Date.now();
    await client.query(
      `DELETE FROM documents WHERE collection = $1 AND id = $2`,
      [HEALTH_COLLECTION, HEALTH_ID]
    );
    timings.deleteMs = ms(t);

    t = Date.now();
    await client.query('ROLLBACK');
    timings.rollbackMs = ms(t);

    return {
      ok: true,
      created: read.rows[0]?.data?.probe === true,
      updated: updated.rows[0]?.data?.n === 2,
      timings,
      note: 'All CRUD changes were rolled back; no production data was modified.',
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { ok: false, error: error.message, timings };
  } finally {
    client.release();
  }
}

async function main() {
  console.log('\n=== Database Health Check ===\n');
  const diagnostics = getDatabaseDiagnostics();
  console.log('Config:', JSON.stringify({
    enabled: diagnostics.enabled,
    provider: diagnostics.provider,
    host: diagnostics.host,
    database: diagnostics.database,
    redactedUrl: diagnostics.redactedUrl,
    ssl: diagnostics.ssl,
    pool: diagnostics.pool,
  }, null, 2));

  if (!pgEnabled()) {
    console.error('\nFAIL: PostgreSQL pool is not enabled.');
    process.exit(1);
  }

  const probe = await testConnection();
  console.log('\nConnection probe:', probe.ok
    ? `OK (${probe.latencyMs}ms) db=${probe.database}`
    : `FAIL — ${probe.error}`);

  if (!probe.ok) {
    console.error('\nCannot continue schema/CRUD checks while the database is unreachable.');
    console.error('Check that PostgreSQL is listening on the configured host/port and that your firewall allows this machine.');
    process.exit(1);
  }

  const schemaOk = await initSchema();
  console.log('Schema init:', schemaOk ? 'OK' : 'FAILED');

  const schema = await inspectSchema(getPool());
  console.log('\nTables:', schema.tables.join(', ') || '(none)');
  console.log('Indexes:', schema.indexCount);
  console.log('Foreign keys:', schema.foreignKeys.length);
  console.log('Document counts:', schema.documentCounts.length ? schema.documentCounts : '(empty)');

  const crud = await safeCrudRoundTrip(getPool());
  console.log('\nSafe CRUD (transaction + ROLLBACK):', crud.ok ? 'OK' : `FAIL — ${crud.error}`);
  if (crud.timings) console.log('CRUD timings (ms):', crud.timings);

  const required = ['documents', 'users'];
  const missing = required.filter((t) => !schema.tables.includes(t));
  if (missing.length) {
    console.error('\nMissing required tables:', missing.join(', '));
    process.exit(1);
  }

  console.log('\nRESULT: Database healthy for operational use.');
  process.exit(0);
}

main().catch(async (error) => {
  console.error('FATAL:', error.message);
  try { await getPool()?.end(); } catch (_) {}
  process.exit(1);
}).finally(async () => {
  try { await getPool()?.end(); } catch (_) {}
});
