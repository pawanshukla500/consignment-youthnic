-- Consignment Packing App - staged operational/reporting schema
-- This keeps the JSONB documents bridge intact and adds normalized tables for
-- fast box-derived reporting, transactional save-box writes, and migration checks.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE TABLE IF NOT EXISTS consignments (
  id TEXT PRIMARY KEY,
  internal_shipment_no TEXT NOT NULL,
  shipment_no TEXT,
  name TEXT,
  description TEXT,
  marketplace_id TEXT,
  warehouse TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  shipment_status TEXT,
  expected_date DATE,
  po_expiry_date DATE,
  appointment_date DATE,
  scheduled_dispatch_date DATE,
  actual_dispatch_date DATE,
  date_of_inward DATE,
  forward_invoice_no TEXT,
  docket_company TEXT,
  docket_no TEXT,
  marketplace_ticket_id TEXT,
  total_required_qty INTEGER NOT NULL DEFAULT 0,
  total_packed_qty INTEGER NOT NULL DEFAULT 0,
  units_shipped INTEGER NOT NULL DEFAULT 0,
  units_received INTEGER NOT NULL DEFAULT 0,
  units_inwarded INTEGER NOT NULL DEFAULT 0,
  qa_fail_excess_qty INTEGER NOT NULL DEFAULT 0,
  source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  barcode TEXT,
  marketplace_sku TEXT,
  internal_sku TEXT,
  marketplace_id TEXT,
  required_qty INTEGER NOT NULL DEFAULT 0 CHECK (required_qty >= 0),
  packed_qty INTEGER NOT NULL DEFAULT 0 CHECK (packed_qty >= 0),
  status TEXT NOT NULL DEFAULT 'pending',
  source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  box_no TEXT NOT NULL,
  total_qty INTEGER NOT NULL DEFAULT 0 CHECK (total_qty >= 0),
  source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (consignment_id, box_no)
);

CREATE TABLE IF NOT EXISTS box_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  sku_id TEXT REFERENCES skus(id) ON DELETE SET NULL,
  barcode TEXT,
  marketplace_sku TEXT,
  internal_sku TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,
  box_no TEXT,
  original_name TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_provider TEXT NOT NULL DEFAULT 'firebase',
  storage_path TEXT,
  url TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipment_documents (
  id TEXT PRIMARY KEY,
  consignment_id TEXT REFERENCES consignments(id) ON DELETE CASCADE,
  type TEXT,
  original_name TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_provider TEXT NOT NULL DEFAULT 'firebase',
  storage_path TEXT,
  url TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'packer',
  warehouse_id TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  password_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  transit_days INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  user_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS productivity_events (
  id TEXT PRIMARY KEY,
  consignment_id TEXT REFERENCES consignments(id) ON DELETE SET NULL,
  box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,
  box_no TEXT,
  event_type TEXT NOT NULL,
  items_count INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packing_sync_jobs (
  id TEXT PRIMARY KEY,
  consignment_id TEXT REFERENCES consignments(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_events (
  id TEXT PRIMARY KEY,
  consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,
  box_no TEXT,
  sku_id TEXT REFERENCES skus(id) ON DELETE SET NULL,
  barcode TEXT,
  marketplace_sku TEXT,
  internal_sku TEXT,
  qty_delta INTEGER NOT NULL DEFAULT 1,
  result TEXT NOT NULL DEFAULT 'accepted',
  station_id TEXT,
  user_id TEXT,
  client_created_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consignments_status_updated
  ON consignments(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_collection
  ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_documents_data_gin
  ON documents USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at
  ON documents(collection, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_consignment_id
  ON documents ((data->>'consignmentId'))
  WHERE collection IN ('skus', 'boxes', 'videos', 'documents', 'packing_drafts', 'scan_events', 'packing_sync_jobs');
CREATE INDEX IF NOT EXISTS idx_consignments_marketplace_dispatch
  ON consignments(marketplace_id, scheduled_dispatch_date);
CREATE INDEX IF NOT EXISTS idx_skus_consignment
  ON skus(consignment_id);
CREATE INDEX IF NOT EXISTS idx_skus_lookup
  ON skus(consignment_id, barcode, marketplace_sku, internal_sku);
CREATE INDEX IF NOT EXISTS idx_boxes_consignment
  ON boxes(consignment_id, box_no);
CREATE INDEX IF NOT EXISTS idx_box_items_box
  ON box_items(box_id);
CREATE INDEX IF NOT EXISTS idx_box_items_consignment_sku
  ON box_items(consignment_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_videos_consignment
  ON videos(consignment_id, box_no);
CREATE INDEX IF NOT EXISTS idx_shipment_documents_consignment
  ON shipment_documents(consignment_id);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid
  ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_productivity_events_consignment
  ON productivity_events(consignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_packing_sync_jobs_status
  ON packing_sync_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_scan_events_consignment_created
  ON scan_events(consignment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_station_created
  ON scan_events(station_id, created_at DESC);

ALTER TABLE consignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE productivity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE packing_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_anon_consignments ON consignments;
DROP POLICY IF EXISTS deny_anon_documents ON documents;
DROP POLICY IF EXISTS deny_anon_skus ON skus;
DROP POLICY IF EXISTS deny_anon_boxes ON boxes;
DROP POLICY IF EXISTS deny_anon_box_items ON box_items;
DROP POLICY IF EXISTS deny_anon_videos ON videos;
DROP POLICY IF EXISTS deny_anon_shipment_documents ON shipment_documents;
DROP POLICY IF EXISTS deny_anon_users ON users;
DROP POLICY IF EXISTS deny_anon_marketplaces ON marketplaces;
DROP POLICY IF EXISTS deny_anon_audit_logs ON audit_logs;
DROP POLICY IF EXISTS deny_anon_productivity_events ON productivity_events;
DROP POLICY IF EXISTS deny_anon_packing_sync_jobs ON packing_sync_jobs;
DROP POLICY IF EXISTS deny_anon_scan_events ON scan_events;
DROP POLICY IF EXISTS realtime_read_documents ON documents;
DROP POLICY IF EXISTS realtime_read_consignments ON consignments;
DROP POLICY IF EXISTS realtime_read_skus ON skus;
DROP POLICY IF EXISTS realtime_read_boxes ON boxes;
DROP POLICY IF EXISTS realtime_read_box_items ON box_items;
DROP POLICY IF EXISTS realtime_read_scan_events ON scan_events;
DROP POLICY IF EXISTS realtime_read_videos ON videos;
DROP POLICY IF EXISTS realtime_read_packing_sync_jobs ON packing_sync_jobs;

CREATE POLICY deny_anon_consignments ON consignments FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_documents ON documents FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_skus ON skus FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_boxes ON boxes FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_box_items ON box_items FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_videos ON videos FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_shipment_documents ON shipment_documents FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_users ON users FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_marketplaces ON marketplaces FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_audit_logs ON audit_logs FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_productivity_events ON productivity_events FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_packing_sync_jobs ON packing_sync_jobs FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_anon_scan_events ON scan_events FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY realtime_read_documents ON documents
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_consignments ON consignments
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_skus ON skus
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_boxes ON boxes
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_box_items ON box_items
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_scan_events ON scan_events
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_videos ON videos
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
CREATE POLICY realtime_read_packing_sync_jobs ON packing_sync_jobs
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);

GRANT SELECT ON documents TO authenticated;
GRANT SELECT ON consignments TO authenticated;
GRANT SELECT ON skus TO authenticated;
GRANT SELECT ON boxes TO authenticated;
GRANT SELECT ON box_items TO authenticated;
GRANT SELECT ON scan_events TO authenticated;
GRANT SELECT ON videos TO authenticated;
GRANT SELECT ON packing_sync_jobs TO authenticated;

DO $$
DECLARE
  realtime_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH realtime_table IN ARRAY ARRAY[
      'documents',
      'consignments',
      'skus',
      'boxes',
      'box_items',
      'scan_events',
      'packing_sync_jobs',
      'videos',
      'users'
    ]
    LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = realtime_table
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = realtime_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', realtime_table);
      END IF;
    END LOOP;
  END IF;
END $$;

