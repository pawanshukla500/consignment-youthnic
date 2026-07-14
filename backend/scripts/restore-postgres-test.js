/**
 * Decrypt + restore a backup into a SEPARATE test database.
 * Requires TEST_DATABASE_URL. Refuses primary DB name unless ALLOW_RESTORE_TO_PRIMARY=true.
 *
 *   *.dump.enc  → pg_restore
 *   *.json.enc  → node data restore (schema must already exist; run initSchema first)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { validateDatabaseUrl, buildPoolConfig } = require('../utils/dbConnection');
const { deriveBackupKey, decryptFile, decryptBuffer } = require('../utils/backupCrypto');

async function restoreJsonSnapshot(encPath, testUrl) {
  const key = deriveBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const payload = JSON.parse(decryptBuffer(fs.readFileSync(encPath), key).toString('utf8'));
  if (payload?.type !== 'youthnic-json-backup' || !payload.tables) {
    throw new Error('Not a Youthnic JSON backup archive.');
  }

  const pool = new Pool(buildPoolConfig(testUrl));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Disable FKs briefly for truncate order independence
    await client.query("SET session_replication_role = 'replica'");
    const names = Object.keys(payload.tables);
    for (const table of names) {
      await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
    }
    for (const table of names) {
      const rows = payload.tables[table] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const colList = cols.map((c) => `"${c}"`).join(', ');
        await client.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
          cols.map((c) => row[c])
        );
      }
    }
    await client.query("SET session_replication_role = 'origin'");
    await client.query('COMMIT');
    return names.length;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const encPath = process.argv[2];
  if (!encPath || !fs.existsSync(encPath)) {
    console.error('Usage: node scripts/restore-postgres-test.js <backup.dump.enc|backup.json.enc>');
    process.exit(1);
  }

  const testUrl = process.env.TEST_DATABASE_URL || '';
  const validation = validateDatabaseUrl(testUrl);
  if (!validation.valid) {
    console.error('TEST_DATABASE_URL is required and must be a valid postgres URL.');
    process.exit(1);
  }
  if (/consignment_db$/i.test(validation.database) && !process.env.ALLOW_RESTORE_TO_PRIMARY) {
    console.error(`Refusing to restore into primary-looking database "${validation.database}".`);
    process.exit(1);
  }

  console.log(`[Restore-Test] Restoring into ${validation.redacted} …`);

  if (/\.json\.enc$/i.test(encPath)) {
    const count = await restoreJsonSnapshot(encPath, testUrl);
    console.log(`[Restore-Test] OK — restored ${count} tables from JSON snapshot.`);
    return;
  }

  const key = deriveBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const tmpPath = path.join(os.tmpdir(), `restore-${Date.now()}.dump`);
  decryptFile(encPath, tmpPath, key);
  const pgRestore = process.env.PG_RESTORE_PATH || 'pg_restore';
  const result = spawnSync(pgRestore, [
    `--dbname=${testUrl}`,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    tmpPath,
  ], { encoding: 'utf8' });
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || 'pg_restore failed');
    process.exit(1);
  }
  console.log('[Restore-Test] OK — custom dump restored.');
}

main().catch((error) => {
  console.error('[Restore-Test] FAIL:', error.message);
  process.exit(1);
});
