-- 20260706000000_sync_documents_trigger.sql
-- Synchronizes the legacy `documents` JSONB table to the normalized tables.

CREATE OR REPLACE FUNCTION sync_documents_to_relational()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.collection = 'consignments' THEN
    INSERT INTO consignments (
      id, internal_shipment_no, shipment_no, name, description, marketplace_id, 
      status, date_of_inward, total_required_qty, total_packed_qty, source_document, created_at, updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.data->>'internalShipmentNo', 'UNKNOWN'),
      NEW.data->>'shipmentNo',
      NEW.data->>'name',
      NEW.data->>'description',
      NEW.data->>'marketplaceId',
      COALESCE(NEW.data->>'status', 'pending'),
      NULLIF(NEW.data->>'dateOfInward', '')::DATE,
      COALESCE((NEW.data->>'totalRequiredQty')::INTEGER, 0),
      COALESCE((NEW.data->>'totalPackedQty')::INTEGER, 0),
      NEW.data,
      COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
      NEW.updated_at
    ) ON CONFLICT (id) DO UPDATE SET
      internal_shipment_no = EXCLUDED.internal_shipment_no,
      shipment_no = EXCLUDED.shipment_no,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      marketplace_id = EXCLUDED.marketplace_id,
      status = EXCLUDED.status,
      date_of_inward = EXCLUDED.date_of_inward,
      total_required_qty = EXCLUDED.total_required_qty,
      total_packed_qty = EXCLUDED.total_packed_qty,
      source_document = EXCLUDED.source_document,
      updated_at = EXCLUDED.updated_at;

  ELSIF NEW.collection = 'skus' THEN
    INSERT INTO skus (
      id, consignment_id, barcode, marketplace_sku, internal_sku, 
      required_qty, packed_qty, status, source_document, created_at, updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.data->>'consignmentId', 'UNKNOWN'),
      NEW.data->>'barcode',
      NEW.data->>'marketplaceSku',
      NEW.data->>'internalSku',
      COALESCE((NEW.data->>'requiredQty')::INTEGER, 0),
      COALESCE((NEW.data->>'packedQty')::INTEGER, 0),
      COALESCE(NEW.data->>'status', 'pending'),
      NEW.data,
      COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
      NEW.updated_at
    ) ON CONFLICT (id) DO UPDATE SET
      consignment_id = EXCLUDED.consignment_id,
      barcode = EXCLUDED.barcode,
      marketplace_sku = EXCLUDED.marketplace_sku,
      internal_sku = EXCLUDED.internal_sku,
      required_qty = EXCLUDED.required_qty,
      packed_qty = EXCLUDED.packed_qty,
      status = EXCLUDED.status,
      source_document = EXCLUDED.source_document,
      updated_at = EXCLUDED.updated_at;

  ELSIF NEW.collection = 'boxes' THEN
    INSERT INTO boxes (
      id, consignment_id, box_no, total_qty, source_document, created_at, updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.data->>'consignmentId', 'UNKNOWN'),
      COALESCE(NEW.data->>'boxNo', 'UNKNOWN'),
      COALESCE((NEW.data->>'totalQty')::INTEGER, 0),
      NEW.data,
      COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
      NEW.updated_at
    ) ON CONFLICT (id) DO UPDATE SET
      consignment_id = EXCLUDED.consignment_id,
      box_no = EXCLUDED.box_no,
      total_qty = EXCLUDED.total_qty,
      source_document = EXCLUDED.source_document,
      updated_at = EXCLUDED.updated_at;

    IF NEW.data ? 'items' AND jsonb_typeof(NEW.data->'items') = 'array' THEN
      DELETE FROM box_items WHERE box_id = NEW.id;
      
      INSERT INTO box_items (box_id, consignment_id, sku_id, barcode, marketplace_sku, internal_sku, qty)
      SELECT 
        NEW.id,
        COALESCE(NEW.data->>'consignmentId', 'UNKNOWN'),
        item->>'skuId',
        item->>'barcode',
        item->>'marketplaceSku',
        item->>'internalSku',
        COALESCE((item->>'qty')::INTEGER, 0)
      FROM jsonb_array_elements(NEW.data->'items') AS item;
    END IF;

  ELSIF NEW.collection = 'videos' THEN
    INSERT INTO videos (
      id, consignment_id, box_id, box_no, url, original_name, storage_path, created_at, updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.data->>'consignmentId', 'UNKNOWN'),
      NEW.data->>'boxId',
      NEW.data->>'boxNo',
      NEW.data->>'url',
      NEW.data->>'originalName',
      NEW.data->>'storagePath',
      COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
      NEW.updated_at
    ) ON CONFLICT (id) DO UPDATE SET
      consignment_id = EXCLUDED.consignment_id,
      box_id = EXCLUDED.box_id,
      box_no = EXCLUDED.box_no,
      url = EXCLUDED.url,
      original_name = EXCLUDED.original_name,
      storage_path = EXCLUDED.storage_path,
      updated_at = EXCLUDED.updated_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_documents_trigger ON documents;

CREATE TRIGGER sync_documents_trigger
AFTER INSERT OR UPDATE ON documents
FOR EACH ROW
EXECUTE FUNCTION sync_documents_to_relational();
