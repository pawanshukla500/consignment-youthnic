/**
 * Apply Supabase/Postgres schema (documents table and related). Files use Cloudflare R2.
 * Run: node scripts/apply-supabase-schema.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function apply() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Set SUPABASE_DB_URL or DATABASE_URL');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: connectionString.split('?')[0],
    ssl: { rejectUnauthorized: false }
  });

  const sqlPath = path.join(__dirname, '..', '..', 'supabase', 'migrations', '20250613000000_initial_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Run statements one at a time (storage policies may partially exist)
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      console.log('[Schema] OK:', stmt.slice(0, 60).replace(/\s+/g, ' ') + '...');
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('duplicate key')) {
        console.log('[Schema] Skip (exists):', stmt.slice(0, 40) + '...');
      } else {
        console.warn('[Schema] Warning:', e.message);
      }
    }
  }

  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'documents'"
  );
  console.log(rows.length ? '[Schema] documents table ready.' : '[Schema] documents table NOT found.');
  await pool.end();
}

apply().catch(err => {
  console.error(err);
  process.exit(1);
});
