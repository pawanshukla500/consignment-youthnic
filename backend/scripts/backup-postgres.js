/**
 * Affordable encrypted backup for locally hosted PostgreSQL.
 *
 * Prefers pg_dump custom format when available. Falls back to an encrypted
 * JSON data snapshot via node-pg (no PostgreSQL client tools required).
 *
 * Usage (from backend/):
 *   node scripts/backup-postgres.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { resolveDatabaseUrl, validateDatabaseUrl, buildPoolConfig } = require('../utils/dbConnection');
const { isResendConfigured, sendViaResend } = require('../utils/resend');
const { deriveBackupKey, encryptFile } = require('../utils/backupCrypto');

function fail(message, code = 1) {
  console.error(`[Backup] FAIL: ${message}`);
  process.exitCode = code;
}

function pruneOldBackups(dir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.enc') && !name.endsWith('.enc.sha256')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      console.log(`[Backup] Pruned old archive: ${name}`);
    }
  }
}

async function alertFailure(errorMessage) {
  const to = process.env.BACKUP_ALERT_TO;
  if (!to || !isResendConfigured()) {
    console.warn('[Backup] Failure alert skipped (BACKUP_ALERT_TO / Resend not configured).');
    return;
  }
  try {
    await sendViaResend({
      to,
      subject: '[Youthnic] PostgreSQL backup FAILED',
      text: `Automated backup failed at ${new Date().toISOString()}.\n\n${errorMessage}\n`,
      html: `<p>Automated backup failed at <strong>${new Date().toISOString()}</strong>.</p><pre>${String(errorMessage).replace(/</g, '&lt;')}</pre>`,
    });
  } catch (error) {
    console.error('[Backup] Could not send failure alert:', error.message);
  }
}

function resolvePgDumpBinary() {
  if (process.env.PG_DUMP_PATH) return process.env.PG_DUMP_PATH;
  const candidates = [
    'pg_dump',
    'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
  ];
  for (const candidate of candidates) {
    if (candidate === 'pg_dump') {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (probe.status === 0) return candidate;
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function dumpWithPgDump(connectionString, plainPath) {
  const pgDump = resolvePgDumpBinary();
  if (!pgDump) return { ok: false, reason: 'pg_dump_not_found' };
  console.log(`[Backup] Using pg_dump (${pgDump})`);
  const dump = spawnSync(pgDump, [
    `--dbname=${connectionString}`,
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--file=${plainPath}`,
  ], { encoding: 'utf8' });
  if (dump.status !== 0) {
    return { ok: false, reason: (dump.stderr || dump.stdout || 'pg_dump failed').trim() };
  }
  return { ok: true, format: 'custom' };
}

async function dumpWithJsonSnapshot(plainPath) {
  const pool = new Pool(buildPoolConfig(resolveDatabaseUrl()));
  try {
    const tables = await pool.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const payload = {
      type: 'youthnic-json-backup',
      version: 1,
      generatedAt: new Date().toISOString(),
      tables: {},
    };
    for (const { tablename } of tables.rows) {
      const rows = await pool.query(`SELECT * FROM "${tablename}"`);
      payload.tables[tablename] = rows.rows;
    }
    fs.writeFileSync(plainPath, JSON.stringify(payload), 'utf8');
    return { ok: true, format: 'json', tableCount: tables.rows.length };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    await pool.end();
  }
}

async function main() {
  const connectionString = resolveDatabaseUrl();
  const validation = validateDatabaseUrl(connectionString);
  if (!validation.valid) {
    await alertFailure(validation.error);
    return fail(validation.error);
  }

  let key;
  try {
    key = deriveBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  } catch (error) {
    await alertFailure(error.message);
    return fail(error.message);
  }

  const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  const retentionDays = Math.max(1, parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10));
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const customPath = path.join(backupDir, `consignment_db-${stamp}.dump`);
  const jsonPath = path.join(backupDir, `consignment_db-${stamp}.json`);

  console.log(`[Backup] Dumping ${validation.database}@${validation.host} …`);
  let plainPath = customPath;
  let dumpResult = dumpWithPgDump(connectionString, customPath);
  if (!dumpResult.ok) {
    console.warn(`[Backup] pg_dump unavailable (${dumpResult.reason}). Using JSON data snapshot fallback.`);
    plainPath = jsonPath;
    dumpResult = await dumpWithJsonSnapshot(jsonPath);
  }

  if (!dumpResult.ok) {
    await alertFailure(dumpResult.reason);
    return fail(dumpResult.reason);
  }

  const encPath = `${plainPath}.enc`;
  const hashPath = `${encPath}.sha256`;
  try {
    encryptFile(plainPath, encPath, key);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(encPath)).digest('hex');
    fs.writeFileSync(hashPath, `${hash}  ${path.basename(encPath)}\n`);
    fs.unlinkSync(plainPath);
  } catch (error) {
    try { if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath); } catch (_) {}
    await alertFailure(error.message);
    return fail(error.message);
  }

  pruneOldBackups(backupDir, retentionDays);
  console.log(`[Backup] OK (${dumpResult.format}) → ${encPath}`);
  console.log('[Backup] Copy the .enc (+ .sha256) file to Google Drive. Never put BACKUP_ENCRYPTION_KEY in Drive.');
  console.log(`[Backup] Retention: ${retentionDays} days in ${backupDir}`);
}

main().catch(async (error) => {
  await alertFailure(error.message);
  fail(error.message);
});
