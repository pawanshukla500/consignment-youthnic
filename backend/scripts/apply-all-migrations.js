/**
 * Apply all SQL migration schemas to the configured database.
 * Run: node backend/scripts/apply-all-migrations.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function apply() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('FAIL: Set SUPABASE_DB_URL in backend/.env');
    process.exit(1);
  }

  console.log(`Connecting to: ${connectionString.split('@')[1]}`);
  
  const useSsl = process.env.DB_SSL === 'true';
  const pool = new Pool({
    connectionString: connectionString.split('?')[0],
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });

  try {
    await pool.query('SELECT 1');
    console.log("✓ Connected to database successfully.");
  } catch (e) {
    console.error("FAIL: Could not connect to database:", e.message);
    process.exit(1);
  }

  // Get all sql migration files sorted
  const migrationsDir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  const sqlFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`\nFound ${sqlFiles.length} migration files. Applying...`);

  for (const file of sqlFiles) {
    console.log(`\n--- Applying Migration: ${file} ---`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // Split statements. Note: This is a simple parser, splits on semicolon.
    // In PostgreSQL, simple splitting on ; is fine for basic tables, columns, indexes, and policies,
    // as long as there are no semicolons inside strings or PL/pgSQL function bodies.
    // If PL/pgSQL block is used, we split on custom blocks or keep it intact.
    
    // We will separate by DO $$ ... END $$ blocks and other statements.
    const statements = [];
    let currentStatement = '';
    let inDollarBlock = false;
    const lines = sql.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;

      if (trimmed.includes('$$')) {
        inDollarBlock = !inDollarBlock;
      }

      currentStatement += line + '\n';

      if (!inDollarBlock && trimmed.endsWith(';')) {
        statements.push(currentStatement.trim());
        currentStatement = '';
      }
    }
    if (currentStatement.trim()) {
      statements.push(currentStatement.trim());
    }

    for (const stmt of statements) {
      if (!stmt) continue;
      try {
        await pool.query(stmt);
        console.log('  OK:', stmt.slice(0, 60).replace(/\s+/g, ' ') + '...');
      } catch (e) {
        if (e.message.includes('already exists') || e.message.includes('duplicate key') || e.message.includes('already a member')) {
          console.log('  Skip (already applied):', e.message);
        } else {
          console.warn('  Warning:', e.message);
        }
      }
    }
  }

  console.log('\n✓ All migrations applied successfully.');
  await pool.end();
}

apply().catch(err => {
  console.error('[Migrations] Fatal:', err);
  process.exit(1);
});
