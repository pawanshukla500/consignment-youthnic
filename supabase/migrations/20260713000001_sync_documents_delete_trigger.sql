-- H5: Mirror DELETE from documents JSONB into normalized Realtime tables.
-- Source of truth remains documents; normalized tables are Realtime mirrors.
-- Rollback: DROP TRIGGER IF EXISTS sync_documents_delete_trigger ON documents;
--           DROP FUNCTION IF EXISTS sync_documents_delete_to_relational();

CREATE OR REPLACE FUNCTION sync_documents_delete_to_relational()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF OLD.collection = 'boxes' THEN
      DELETE FROM box_items WHERE box_id = OLD.id;
      DELETE FROM boxes WHERE id = OLD.id;

    ELSIF OLD.collection = 'skus' THEN
      DELETE FROM box_items WHERE sku_id = OLD.id;
      DELETE FROM skus WHERE id = OLD.id;

    ELSIF OLD.collection = 'videos' THEN
      DELETE FROM videos WHERE id = OLD.id;

    ELSIF OLD.collection = 'consignments' THEN
      -- Child mirror rows may exist if document deletes were skipped historically.
      DELETE FROM box_items WHERE consignment_id = OLD.id;
      DELETE FROM boxes WHERE consignment_id = OLD.id;
      DELETE FROM skus WHERE consignment_id = OLD.id;
      DELETE FROM videos WHERE consignment_id = OLD.id;
      DELETE FROM consignments WHERE id = OLD.id;

    ELSIF OLD.collection = 'scan_events' THEN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'scan_events'
      ) THEN
        DELETE FROM scan_events WHERE id = OLD.id;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sync_documents_delete_to_relational failed for %/%: %',
      OLD.collection, OLD.id, SQLERRM;
  END;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_documents_delete_trigger ON documents;

CREATE TRIGGER sync_documents_delete_trigger
AFTER DELETE ON documents
FOR EACH ROW
EXECUTE FUNCTION sync_documents_delete_to_relational();

-- One-time orphan cleanup for rows left behind before this trigger existed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='box_items') THEN
    DELETE FROM box_items bi
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.collection = 'boxes' AND d.id = bi.box_id
    );
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='boxes') THEN
    DELETE FROM boxes b
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.collection = 'boxes' AND d.id = b.id
    );
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='skus') THEN
    DELETE FROM skus s
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.collection = 'skus' AND d.id = s.id
    );
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='videos') THEN
    DELETE FROM videos v
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.collection = 'videos' AND d.id = v.id
    );
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='consignments') THEN
    DELETE FROM consignments c
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.collection = 'consignments' AND d.id = c.id
    );
  END IF;
END $$;
