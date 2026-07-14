-- OMSGuru quantity-removal checklist on consignments (operations verification)
ALTER TABLE consignments
  ADD COLUMN IF NOT EXISTS oms_guru_qty_removed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oms_guru_qty_removed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oms_guru_qty_removed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_consignments_oms_guru_pending
  ON consignments (oms_guru_qty_removed)
  WHERE oms_guru_qty_removed = false;
