-- Protect packing videos from retention cleanup when a consignment is disputed.
ALTER TABLE consignments ADD COLUMN IF NOT EXISTS is_disputed BOOLEAN NOT NULL DEFAULT false;

-- Backfill normalized rows from the JSONB bridge/source document where available.
UPDATE consignments
SET is_disputed = true
WHERE is_disputed = false
  AND (
    lower(COALESCE(source_document->>'isDisputed', 'false')) IN ('true', 't', '1', 'yes', 'y')
    OR lower(COALESCE(source_document->>'disputed', 'false')) IN ('true', 't', '1', 'yes', 'y')
    OR lower(COALESCE(source_document->>'shipmentStatus', shipment_status, source_document->>'status', status, '')) LIKE '%disput%'
  );

-- Also backfill the document bridge so app-facing JSON consistently exposes isDisputed.
UPDATE documents
SET data = data || jsonb_build_object('isDisputed', true)
WHERE collection = 'consignments'
  AND lower(COALESCE(data->>'isDisputed', 'false')) NOT IN ('true', 't', '1', 'yes', 'y')
  AND (
    lower(COALESCE(data->>'disputed', 'false')) IN ('true', 't', '1', 'yes', 'y')
    OR lower(COALESCE(data->>'shipmentStatus', data->>'status', '')) LIKE '%disput%'
  );

CREATE INDEX IF NOT EXISTS idx_consignments_video_retention_protection
  ON consignments(date_of_inward, is_disputed, marketplace_ticket_id);
