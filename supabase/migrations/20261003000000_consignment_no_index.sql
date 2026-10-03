-- Consignment No index (documents JSONB path).
-- Speeds Consignment No searches when consignments share a marketplace Consignment No across distinct internal shipments.
-- Safe to apply online (IF NOT EXISTS); no drops.

CREATE INDEX IF NOT EXISTS idx_documents_consignments_consignment_no
  ON documents ((data->>'consignmentNo'))
  WHERE collection = 'consignments';
