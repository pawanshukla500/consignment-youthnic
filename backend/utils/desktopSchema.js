// Additive desktop contract. This runs with the application's existing pool;
// it never selects a different database or changes operational records.
const DESKTOP_PROTOCOL = 1;

async function ensureDesktopSchema(pool, { isCockroach = false } = {}) {
  // Consignments are authoritative in the existing documents store. Do not add
  // a foreign key to the optional normalized `consignments` table here: that
  // would make the desktop upgrade fail in an otherwise valid current install.
  // The packing routes lock and validate the canonical document transactionally.
  await pool.query(`CREATE TABLE IF NOT EXISTS packing_box_operations (
    operation_id TEXT PRIMARY KEY,
    consignment_id TEXT NOT NULL,
    box_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_packing_box_operations_consignment ON packing_box_operations(consignment_id, created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS packing_station_leases (
    lease_id TEXT PRIMARY KEY,
    consignment_id TEXT NOT NULL,
    station_id TEXT NOT NULL, station_name TEXT, warehouse TEXT, user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(), heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ, released_by TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_packing_station_one_active_lease ON packing_station_leases(consignment_id) WHERE status = 'active'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_packing_station_leases_station ON packing_station_leases(station_id, status, heartbeat_at DESC)`);
  if (!isCockroach) {
    // RLS with no client policies denies browser roles. The server's existing
    // owner/service connection performs authenticated business operations.
    await pool.query('ALTER TABLE packing_box_operations ENABLE ROW LEVEL SECURITY');
    await pool.query('ALTER TABLE packing_station_leases ENABLE ROW LEVEL SECURITY');
  }
}

async function checkDesktopSchema(pool) {
  if (!pool) return { ready: false, protocolVersion: DESKTOP_PROTOCOL, code: 'DESKTOP_DATABASE_UNAVAILABLE' };
  try {
    // Query real required columns, not just connection health or table names.
    await pool.query('SELECT operation_id, consignment_id, box_id, payload_hash, result, created_at, updated_at FROM packing_box_operations LIMIT 0');
    await pool.query('SELECT lease_id, consignment_id, station_id, station_name, warehouse, user_id, status, claimed_at, heartbeat_at, released_at, released_by, metadata FROM packing_station_leases LIMIT 0');
    const { rows } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'packing_station_leases' AND indexname = 'idx_packing_station_one_active_lease'`);
    if (!rows.some((row) => /UNIQUE/i.test(row.indexdef) && /consignment_id/.test(row.indexdef) && /WHERE.*status.*active/is.test(row.indexdef))) {
      return { ready: false, protocolVersion: DESKTOP_PROTOCOL, code: 'DESKTOP_SCHEMA_REQUIRED' };
    }
    return { ready: true, protocolVersion: DESKTOP_PROTOCOL, capabilities: { stationLeases: true, boxIdempotency: true, multipartRecovery: true } };
  } catch (error) {
    return { ready: false, protocolVersion: DESKTOP_PROTOCOL,
      code: ['42P01', '42703', '42501'].includes(error.code) ? 'DESKTOP_SCHEMA_REQUIRED' : 'DESKTOP_DATABASE_UNAVAILABLE' };
  }
}

module.exports = { ensureDesktopSchema, checkDesktopSchema, DESKTOP_PROTOCOL };
