/**
 * Read-only database health check. Does not modify or delete production data.
 * Usage: node scripts/health-check-readonly.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');
const { resolveDatabaseUrl, validateDatabaseUrl, buildPoolConfig } = require('../utils/dbConnection');

async function main() {
  const connectionString = resolveDatabaseUrl();
  const validation = validateDatabaseUrl(connectionString);
  console.log('=== Connection validation ===');
  console.log(JSON.stringify(validation, null, 2));

  if (!validation.valid) {
    process.exit(1);
  }

  const pool = new Pool(buildPoolConfig(connectionString));
  const report = { pingsMs: [], checks: {} };

  try {
    for (let i = 0; i < 5; i += 1) {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      report.pingsMs.push(Date.now() - t0);
    }

    const tInfo = Date.now();
    const info = await pool.query(
      'SELECT version() AS version, current_database() AS db, current_user AS db_user, now() AS server_time'
    );
    report.checks.infoMs = Date.now() - tInfo;
    report.info = info.rows[0];

    const tTables = Date.now();
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    report.checks.tablesMs = Date.now() - tTables;
    report.tables = tables.rows.map((r) => r.tablename);

    const tIndexes = Date.now();
    const indexes = await pool.query(
      "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname"
    );
    report.checks.indexesMs = Date.now() - tIndexes;
    report.indexCount = indexes.rows.length;
    report.indexes = indexes.rows;

    const tFks = Date.now();
    const fks = await pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name
    `);
    report.checks.fksMs = Date.now() - tFks;
    report.foreignKeys = fks.rows;

    const countTargets = [
      'users',
      'documents',
      'consignments',
      'skus',
      'boxes',
      'box_items',
      'audit_logs',
      'videos',
      'scan_events',
      'productivity_events',
      'packing_drafts',
      'marketplaces',
    ];

    report.counts = {};
    for (const table of countTargets) {
      if (!report.tables.includes(table)) {
        report.counts[table] = { missing: true };
        continue;
      }
      const t0 = Date.now();
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
        report.counts[table] = { count: r.rows[0].c, ms: Date.now() - t0 };
      } catch (err) {
        report.counts[table] = { error: err.message, ms: Date.now() - t0 };
      }
    }

    // Read-only CRUD-shaped probes on a temp transaction that always rolls back
    const client = await pool.connect();
    try {
      const tTx = Date.now();
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE IF NOT EXISTS health_probe (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb
        ) ON COMMIT DROP
      `);
      await client.query(`INSERT INTO health_probe (id, data) VALUES ($1, $2)`, [
        'probe-1',
        JSON.stringify({ ok: true }),
      ]);
      const read = await client.query(`SELECT data FROM health_probe WHERE id = $1`, ['probe-1']);
      await client.query(`UPDATE health_probe SET data = $2 WHERE id = $1`, [
        'probe-1',
        JSON.stringify({ ok: true, updated: true }),
      ]);
      await client.query(`DELETE FROM health_probe WHERE id = $1`, ['probe-1']);
      await client.query('ROLLBACK');
      report.checks.txCrudMs = Date.now() - tTx;
      report.checks.txCrudOk = read.rows.length === 1;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      report.checks.txCrudOk = false;
      report.checks.txCrudError = err.message;
    } finally {
      client.release();
    }

    // Duplicate / integrity spot checks (read-only)
    if (report.tables.includes('users')) {
      const dupUsers = await pool.query(`
        SELECT email, COUNT(*)::int AS n
        FROM users
        WHERE email IS NOT NULL AND email <> ''
        GROUP BY email
        HAVING COUNT(*) > 1
        LIMIT 20
      `);
      report.duplicateEmails = dupUsers.rows;
    }

    if (report.tables.includes('documents')) {
      const userDocs = await pool.query(`
        SELECT COUNT(*)::int AS n FROM documents WHERE collection = 'users'
      `);
      report.documentUserCount = userDocs.rows[0].n;
    }

    // Pool / settings
    const settings = await pool.query(`
      SELECT name, setting
      FROM pg_settings
      WHERE name IN ('max_connections', 'shared_buffers', 'work_mem', 'statement_timeout', 'idle_in_transaction_session_timeout')
    `);
    report.pgSettings = Object.fromEntries(settings.rows.map((r) => [r.name, r.setting]));

    report.avgPingMs = Math.round(report.pingsMs.reduce((a, b) => a + b, 0) / report.pingsMs.length);
    report.minPingMs = Math.min(...report.pingsMs);
    report.maxPingMs = Math.max(...report.pingsMs);

    console.log('=== Health report ===');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
