-- SKU inward quantity tracking columns (normalized operational schema)
ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS inward_qty INTEGER NOT NULL DEFAULT 0 CHECK (inward_qty >= 0),
  ADD COLUMN IF NOT EXISTS quantity_difference INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inward_status TEXT NOT NULL DEFAULT 'not_inwarded',
  ADD COLUMN IF NOT EXISTS inward_upload_ref TEXT,
  ADD COLUMN IF NOT EXISTS inward_date DATE,
  ADD COLUMN IF NOT EXISTS inward_remarks TEXT;

CREATE INDEX IF NOT EXISTS idx_skus_inward_status ON skus (inward_status);
CREATE INDEX IF NOT EXISTS idx_skus_consignment_inward ON skus (consignment_id, inward_status);

COMMENT ON COLUMN skus.inward_qty IS 'Warehouse inward quantity; never overwrites packed_qty';
COMMENT ON COLUMN skus.quantity_difference IS 'inward_qty - packed_qty';
COMMENT ON COLUMN skus.inward_status IS 'not_inwarded|fully_inwarded|partially_inwarded|short_received|excess_received';
