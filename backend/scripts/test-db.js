/**
 * Quick database connectivity test.
 * Usage: node scripts/test-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { getPool, initSchema, pgEnabled } = require('../config/database');

async function main() {
  if (!pgEnabled()) {
    console.error('FAIL: SUPABASE_DB_URL not configured or DB_USE_POSTGRES=false');
    process.exit(1);
  }
  try {
    await initSchema();
    const ping = await getPool().query('SELECT now() AS time, version() AS version');
    const counts = await getPool().query(
      'SELECT collection, COUNT(*)::int AS n FROM documents GROUP BY collection ORDER BY collection'
    );
    console.log('OK: Connected to Firebase SQL (Cloud SQL) PostgreSQL');
    console.log('Server time:', ping.rows[0].time);
    console.log('Documents:', counts.rows.length ? counts.rows : '(empty — run node scripts/bootstrap-auth.js)');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    if (e.message.includes('tenant/user') || e.message.includes('connect')) {
      console.error('Hint: Check Cloud SQL instance connectivity, credentials, and IP allowlist configuration.');
    }
    process.exit(1);
  } finally {
    try { await getPool()?.end(); } catch (_) {}
  }
}

main();
