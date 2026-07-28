-- Consignment list filter indexes (documents JSONB path).
-- Speeds archive filters + internal shipment search without changing schema shape.
-- Safe to apply online (IF NOT EXISTS); no drops.

CREATE INDEX IF NOT EXISTS idx_documents_consignments_archived
  ON documents ((data->>'operationalStatus'))
  WHERE collection = 'consignments';

CREATE INDEX IF NOT EXISTS idx_documents_consignments_is_archived
  ON documents ((data->>'isArchived'))
  WHERE collection = 'consignments';

CREATE INDEX IF NOT EXISTS idx_documents_consignments_internal_shipment
  ON documents ((data->>'internalShipmentNo'))
  WHERE collection = 'consignments';
