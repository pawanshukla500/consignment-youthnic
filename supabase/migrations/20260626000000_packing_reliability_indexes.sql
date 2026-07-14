-- Production packing reliability indexes.
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_updated_at TIMESTAMPTZ;

-- scan_events.id is already a primary key; this names an idempotency guard for retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency
  ON scan_events(id);

-- A box can only contain one aggregate row per SKU/barcode identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_box_items_box_sku_barcode
  ON box_items(box_id, COALESCE(sku_id, ''), COALESCE(barcode, ''), COALESCE(marketplace_sku, ''));

-- Fast box-video status lookups for finish validation and operational dashboards.
CREATE INDEX IF NOT EXISTS idx_boxes_video_status
  ON boxes(consignment_id, video_status);
