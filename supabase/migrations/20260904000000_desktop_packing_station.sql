-- Desktop Packing Station contracts.
-- The desktop client remains local-first, but cloud writes need an immutable
-- operation record and a single active station lease per consignment.

CREATE TABLE IF NOT EXISTS packing_box_operations (
  operation_id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_packing_box_operations_consignment
  ON packing_box_operations(consignment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS packing_station_leases (
  lease_id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  station_name TEXT,
  warehouse TEXT,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_by TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_packing_station_one_active_lease
  ON packing_station_leases(consignment_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_packing_station_leases_station
  ON packing_station_leases(station_id, status, heartbeat_at DESC);

ALTER TABLE packing_box_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE packing_station_leases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_anon_packing_box_operations ON packing_box_operations;
DROP POLICY IF EXISTS deny_anon_packing_station_leases ON packing_station_leases;

CREATE POLICY deny_anon_packing_box_operations
  ON packing_box_operations FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY deny_anon_packing_station_leases
  ON packing_station_leases FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
