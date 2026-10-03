-- Consignment No. is a marketplace reference and is intentionally NOT unique.
-- The same number can belong to more than one internal shipment.
-- Uniqueness stays on documents (collection, id) and on Internal Shipment No.
-- This index only speeds search; it does not constrain the value.

CREATE INDEX IF NOT EXISTS idx_documents_consignments_consignment_no
  ON documents ((lower(coalesce(data->>'consignmentNo', ''))))
  WHERE collection = 'consignments'
    AND coalesce(data->>'consignmentNo', '') <> '';
