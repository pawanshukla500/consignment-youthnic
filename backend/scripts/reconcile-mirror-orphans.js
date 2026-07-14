/**
 * Compare documents JSONB source rows vs normalized mirror tables.
 * Run: node scripts/reconcile-mirror-orphans.js
 * Does not delete unless --fix is passed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { getPool, pgEnabled, initSchema } = require('../config/database');

async function countOrphans(client, mirrorTable, collection) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM ${mirrorTable} m
     WHERE NOT EXISTS (
       SELECT 1 FROM documents d WHERE d.collection = $1 AND d.id = m.id
     )`,
    [collection]
  );
  return rows[0].n;
}

async function main() {
  if (!pgEnabled()) {
    console.log('Postgres not enabled');
    process.exit(1);
  }
  await initSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    const pairs = [
      ['consignments', 'consignments'],
      ['skus', 'skus'],
      ['boxes', 'boxes'],
      ['videos', 'videos'],
    ];
    let total = 0;
    for (const [table, collection] of pairs) {
      try {
        const n = await countOrphans(client, table, collection);
        total += n;
        console.log(`${table}: ${n} orphan mirror row(s)`);
      } catch (e) {
        console.warn(`${table}: skipped (${e.message})`);
      }
    }
    console.log(`Total orphans: ${total}`);
    if (process.argv.includes('--fix') && total > 0) {
      console.log('Apply migration 20260713000001_sync_documents_delete_trigger.sql for cleanup + future deletes.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
