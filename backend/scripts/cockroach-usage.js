/**
 * Print Cockroach Cloud storage + best-effort RU-related usage from SQL.
 * Monthly free-tier RU totals live in the Cockroach Cloud Console / Cloud API;
 * SQL can show livebytes and some tenant counters when available.
 *
 * Usage: node backend/scripts/cockroach-usage.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KiB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(2)} MiB`;
  return `${(v / 1024 ** 3).toFixed(3)} GiB`;
}

async function tryQuery(pool, sql) {
  try {
    const res = await pool.query(sql);
    return res.rows;
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const meta = await pool.query(`
    SELECT
      current_database() AS database,
      version() AS version,
      inet_server_addr()::text AS server_addr,
      now() AS server_time
  `);
  console.log('Cluster');
  console.log(JSON.stringify({
    database: meta.rows[0].database,
    version: String(meta.rows[0].version).slice(0, 90),
    serverTime: meta.rows[0].server_time,
  }, null, 2));

  const tables = await tryQuery(pool, `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log('\nPublic tables:', Array.isArray(tables) ? tables.map((r) => r.table_name).join(', ') : tables);

  // Approximate logical storage from live ranges (when permitted)
  const rangeStats = await tryQuery(pool, `
    SELECT
      COALESCE(sum(range_size)::float, 0) AS total_range_bytes,
      count(*)::int AS range_count
    FROM crdb_internal.ranges_no_leases
  `);
  console.log('\nStorage (crdb_internal.ranges_no_leases)');
  if (Array.isArray(rangeStats) && rangeStats[0]) {
    console.log(JSON.stringify({
      rangeCount: rangeStats[0].range_count,
      approxBytes: Number(rangeStats[0].total_range_bytes),
      approxHuman: fmtBytes(rangeStats[0].total_range_bytes),
      freeTierStorageGiB: 10,
      note: 'Logical on-disk range size (not billed compression/replication accounting). Free Basic: ~10 GiB/month included.',
    }, null, 2));
  } else {
    console.log(rangeStats);
  }

  const tableBytes = await tryQuery(pool, `
    SELECT
      name AS table_name,
      approximate_disk_size
    FROM crdb_internal.tables
    WHERE database_name = current_database()
      AND schema_name = 'public'
    ORDER BY approximate_disk_size DESC NULLS LAST
  `);
  console.log('\nApprox table disk size');
  if (Array.isArray(tableBytes)) {
    tableBytes.forEach((r) => {
      console.log(`  ${r.table_name}: ${r.approximate_disk_size || 'n/a'}`);
    });
  } else {
    console.log(tableBytes);
  }

  const docs = await tryQuery(pool, `
    SELECT collection, count(*)::int AS n
    FROM documents
    GROUP BY collection
    ORDER BY n DESC
  `);
  console.log('\nDocuments rows');
  console.log(Array.isArray(docs) ? docs : docs);

  // Tenant RU counters (may be empty / restricted on Basic)
  const tenantUsage = await tryQuery(pool, `
    SELECT *
    FROM crdb_internal.kv_tenant_usage
    LIMIT 5
  `);
  console.log('\nRU counters (crdb_internal.kv_tenant_usage)');
  console.log(Array.isArray(tenantUsage) ? (tenantUsage[0] || '(empty)') : tenantUsage);

  const ruMetrics = await tryQuery(pool, `
    SELECT name, value
    FROM crdb_internal.node_metrics
    WHERE name ILIKE '%request_unit%'
       OR name ILIKE '%sql.bytes%'
       OR name = 'livebytes'
    ORDER BY name
    LIMIT 40
  `);
  console.log('\nNode metrics (RU / livebytes sample)');
  if (Array.isArray(ruMetrics)) {
    ruMetrics.forEach((r) => console.log(`  ${r.name}: ${r.value}`));
    if (!ruMetrics.length) console.log('  (none exposed on this cluster)');
  } else {
    console.log(ruMetrics);
  }

  console.log('\nFree-tier reminder');
  console.log(JSON.stringify({
    includedRUsPerMonth: '≈ 50,000,000 (via $15 org credit)',
    includedStorageGiB: 10,
    exactMonthlyRU: 'Open Cockroach Cloud → Cluster Overview → Usage this month (or Cloud API)',
  }, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
