-- Per-SKU OMSGuru removal tracking + upload audit history

ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS oms_guru_removed_qty INTEGER NOT NULL DEFAULT 0 CHECK (oms_guru_removed_qty >= 0),
  ADD COLUMN IF NOT EXISTS oms_guru_remarks TEXT,
  ADD COLUMN IF NOT EXISTS oms_guru_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oms_guru_updated_by TEXT;

CREATE TABLE IF NOT EXISTS oms_guru_upload_logs (
  id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  file_name TEXT,
  uploaded_by TEXT,
  uploaded_by_name TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  updated_sku_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oms_guru_upload_logs_consignment
  ON oms_guru_upload_logs(consignment_id, created_at DESC);
