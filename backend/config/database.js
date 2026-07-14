/**
 * PostgreSQL connection - Firebase SQL (Cloud SQL) / Neon / Supabase.
 *
 * Operational rule: PostgreSQL is the single source of truth for business data.
 * Set SUPABASE_DB_URL or DATABASE_URL in backend/.env — see backend/.env.example.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');
const {
  resolveDatabaseUrl,
  validateDatabaseUrl,
  buildPoolConfig,
} = require('../utils/dbConnection');

let pool = null;
let enabled = false;
let lastValidation = null;
let lastSuccessfulConnectionAt = null;
let lastConnectionError = null;
let failedQueryCount = 0;
let totalQueryCount = 0;

function recordQueryFailure(error) {
  failedQueryCount += 1;
  lastConnectionError = error?.message || String(error);
}

function recordQuerySuccess() {
  totalQueryCount += 1;
  lastSuccessfulConnectionAt = new Date().toISOString();
  lastConnectionError = null;
}

function initPostgres() {
  const connectionString = resolveDatabaseUrl();
  const useP = process.env.DB_USE_POSTGRES === 'true' || !!connectionString;
  lastValidation = validateDatabaseUrl(connectionString);

  if (!useP) {
    console.log('[Postgres] Not configured — set SUPABASE_DB_URL or DATABASE_URL. Operational API writes will fail unless ALLOW_MEMORY_FALLBACK=true.');
    return;
  }

  if (!lastValidation.valid) {
    console.error('[Postgres] Invalid database URL:', lastValidation.error);
    if (lastValidation.hint) console.error('[Postgres] Hint:', lastValidation.hint);
    console.error('[Postgres] Source env var:', lastValidation.source);
    enabled = false;
    return;
  }

  try {
    const config = buildPoolConfig(connectionString);
    pool = new Pool(config);
    enabled = true;
    pool.on('error', (err) => {
      recordQueryFailure(err);
      console.error('[Postgres] Idle client error:', err.message);
    });
    console.log(`[Postgres] Pool created (${lastValidation.provider} → ${lastValidation.host}/${lastValidation.database}).`);
  } catch (e) {
    console.error('[Postgres] Failed to create pool:', e.message);
    enabled = false;
    lastConnectionError = e.message;
  }
}

async function testConnection() {
  if (!pool) {
    return {
      ok: false,
      error: lastValidation?.valid === false
        ? lastValidation.error
        : 'PostgreSQL pool is not initialized.',
      validation: lastValidation,
    };
  }

  const started = Date.now();
  try {
    const result = await pool.query('SELECT version() AS version, current_database() AS db, now() AS server_time');
    const latencyMs = Date.now() - started;
    recordQuerySuccess();
    return {
      ok: true,
      latencyMs,
      version: result.rows[0]?.version || null,
      database: result.rows[0]?.db || null,
      serverTime: result.rows[0]?.server_time || null,
      validation: lastValidation,
    };
  } catch (e) {
    recordQueryFailure(e);
    return {
      ok: false,
      error: e.message,
      validation: lastValidation,
    };
  }
}

async function initSchema() {
  if (!pool) {
    if (lastValidation && !lastValidation.valid) {
      console.error('[Postgres] Schema init skipped — invalid database URL.');
    }
    return false;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
      CREATE INDEX IF NOT EXISTS idx_documents_data_gin ON documents USING GIN (data jsonb_path_ops);
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(collection, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_documents_status
        ON documents ((data->>'status'))
        WHERE collection = 'consignments';
      CREATE INDEX IF NOT EXISTS idx_documents_marketplace
        ON documents ((data->>'marketplaceId'))
        WHERE collection = 'consignments';
      CREATE INDEX IF NOT EXISTS idx_documents_consignment_id
        ON documents ((data->>'consignmentId'))
        WHERE collection IN ('skus', 'boxes', 'videos', 'documents', 'packing_drafts', 'scan_events', 'packing_sync_jobs');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_scan_events_idempotency
        ON documents (id)
        WHERE collection = 'scan_events';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_boxes_consignment_box
        ON documents ((data->>'consignmentId'), (data->>'boxNo'))
        WHERE collection = 'boxes';

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        firebase_uid TEXT UNIQUE,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'packer',
        warehouse_id TEXT,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        password_hash TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_login_at TIMESTAMPTZ,
        source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
    `);

    await pool.query(`
      ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          GRANT SELECT ON documents TO authenticated;
          -- users table is never granted to authenticated (C1: no Realtime/user harvest)

          IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
            DROP POLICY IF EXISTS realtime_read_documents ON documents;
            CREATE POLICY realtime_read_documents ON documents
              FOR SELECT TO authenticated
              USING (
                (auth.jwt() ->> 'app_user_id') IS NOT NULL
                AND collection IS DISTINCT FROM 'users'
              );

            DROP POLICY IF EXISTS realtime_read_users ON users;
            DROP POLICY IF EXISTS deny_anon_users ON users;
            CREATE POLICY deny_anon_users ON users
              FOR ALL TO anon, authenticated
              USING (false)
              WITH CHECK (false);
          END IF;
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
          IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'documents'
          ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.documents;
          END IF;
          -- Explicitly keep users out of Realtime publication
          IF EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
          ) THEN
            ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
          END IF;
        END IF;
      END $$;
    `);

    recordQuerySuccess();
    console.log('[Postgres] Schema ready.');
    return true;
  } catch (e) {
    recordQueryFailure(e);
    console.error('[Postgres] Schema init failed:', e.message);
    return false;
  }
}

function getPool() {
  if (!pool && enabled) {
    throw new Error('PostgreSQL pool is enabled but not initialized.');
  }
  return pool;
}

function getDatabaseDiagnostics() {
  const connectionString = resolveDatabaseUrl();
  const validation = lastValidation || validateDatabaseUrl(connectionString);

  return {
    enabled: pgEnabled(),
    configured: Boolean(connectionString),
    validation,
    provider: validation.valid ? validation.provider : null,
    host: validation.valid ? validation.host : null,
    database: validation.valid ? validation.database : null,
    redactedUrl: validation.redacted || null,
    sourceEnvVar: validation.source || null,
    ssl: process.env.DB_SSL === 'true' || connectionString.includes('neon.tech') || connectionString.includes('supabase.co'),
    pool: pool ? {
      max: pool.options?.max ?? null,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    } : null,
    lastSuccessfulConnectionAt,
    lastConnectionError,
    failedQueryCount,
    totalQueryCount,
  };
}

function pgEnabled() {
  return enabled && Boolean(pool);
}

initPostgres();

module.exports = {
  getPool,
  pgEnabled,
  initSchema,
  testConnection,
  getDatabaseDiagnostics,
  recordQueryFailure,
  recordQuerySuccess,
  validateDatabaseUrl,
  resolveDatabaseUrl,
};
