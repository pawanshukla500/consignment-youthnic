-- Inventory Planning: OMSGuru stock snapshots, sync audit, email history

CREATE TABLE IF NOT EXISTS inventory_stock (
  internal_sku TEXT PRIMARY KEY,
  quantity INTEGER,
  previous_quantity INTEGER,
  product_name TEXT,
  sync_status TEXT NOT NULL DEFAULT 'ok',
  last_synced_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  error_message TEXT,
  source TEXT NOT NULL DEFAULT 'omsguru',
  manual_override BOOLEAN NOT NULL DEFAULT false,
  override_quantity INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_stock_quantity_non_negative CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT inventory_stock_override_non_negative CHECK (override_quantity IS NULL OR override_quantity >= 0)
);

CREATE TABLE IF NOT EXISTS inventory_sync_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  skus_fetched INTEGER NOT NULL DEFAULT 0,
  skus_updated INTEGER NOT NULL DEFAULT 0,
  skus_failed INTEGER NOT NULL DEFAULT 0,
  skus_skipped INTEGER NOT NULL DEFAULT 0,
  sheet_updated BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_by TEXT
);

CREATE TABLE IF NOT EXISTS inventory_sync_sku_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES inventory_sync_runs(id) ON DELETE CASCADE,
  internal_sku TEXT NOT NULL,
  omsguru_quantity INTEGER,
  previous_quantity INTEGER,
  quantity_change INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_planning_snapshots (
  id TEXT PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fingerprint TEXT NOT NULL,
  trigger_reason TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  skus JSONB NOT NULL DEFAULT '[]'::jsonb,
  consignments JSONB NOT NULL DEFAULT '[]'::jsonb,
  sync_meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS inventory_email_history (
  id TEXT PRIMARY KEY,
  trigger_reason TEXT NOT NULL,
  fingerprint TEXT,
  status TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '{}'::jsonb,
  subject TEXT,
  snapshot_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_sync_status ON inventory_stock(sync_status);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_last_synced ON inventory_stock(last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_sync_runs_started ON inventory_sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_sync_sku_logs_run ON inventory_sync_sku_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sync_sku_logs_sku ON inventory_sync_sku_logs(internal_sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_planning_snapshots_generated ON inventory_planning_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_planning_snapshots_fingerprint ON inventory_planning_snapshots(fingerprint);
CREATE INDEX IF NOT EXISTS idx_inventory_email_history_created ON inventory_email_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_email_history_fingerprint ON inventory_email_history(fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skus_internal_sku_active ON skus(internal_sku) WHERE internal_sku IS NOT NULL AND internal_sku <> '';
