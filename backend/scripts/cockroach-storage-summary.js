require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  let approxPayloadBytes = 0;
  const rowCounts = {};
  for (const { table_name: table } of tables.rows) {
    try {
      const c = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      rowCounts[table] = c.rows[0].n;
    } catch {
      rowCounts[table] = null;
    }
  }

  try {
    const payload = await pool.query(`
      SELECT COALESCE(sum(octet_length(data::text)), 0)::bigint AS bytes
      FROM documents
    `);
    approxPayloadBytes = Number(payload.rows[0].bytes) || 0;
  } catch {
    approxPayloadBytes = 0;
  }

  console.log(JSON.stringify({
    provider: 'cockroach',
    host: 'consignment-18271.jxf.gcp-europe-west1.cockroachlabs.cloud',
    region: 'gcp-europe-west1',
    database: 'defaultdb',
    publicTables: tables.rows.length,
    rowCounts,
    approxDocumentsJsonBytes: approxPayloadBytes,
    approxDocumentsJsonPretty: `${(approxPayloadBytes / 1024).toFixed(1)} KiB`,
    freeTier: {
      includedRUsPerMonth: 50_000_000,
      includedStorageGiB: 10,
      orgCreditUsd: 15,
    },
    rusMonthToDate: null,
    storageGiBExact: null,
    note: 'Cockroach Basic blocks SQL access to crdb_internal / pg_database_size. Exact MTD RUs + billed storage are on: Cloud Console → Cluster Overview → Usage this month.',
  }, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
