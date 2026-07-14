/**
 * Apply operational schema to CockroachDB Cloud (Postgres wire-compatible).
 *
 * Skips Supabase-only pieces (anon/authenticated RLS, auth.jwt(), realtime
 * publication, pgcrypto extension). Uses inverted indexes instead of
 * Postgres GIN jsonb_path_ops.
 *
 * Usage:
 *   node backend/scripts/apply-cockroach-schema.js
 *
 * Requires DATABASE_URL pointing at Cockroach Cloud (sslmode=verify-full or require).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');

function looksLikeCockroach(url) {
  return /cockroachlabs\.cloud|:26257\b/i.test(String(url || ''));
}

function buildPool(connectionString) {
  // Cockroach Cloud always requires TLS. Prefer rejectUnauthorized:false unless CA is set.
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 30000,
    application_name: 'consignment-cockroach-schema',
  });
}

async function run(pool, label, sql) {
  try {
    await pool.query(sql);
    console.log(`  OK: ${label}`);
    return true;
  } catch (error) {
    const msg = error.message || String(error);
    if (/already exists|duplicate|does not exist/i.test(msg) && /index|relation|policy|constraint/i.test(msg)) {
      console.log(`  Skip: ${label} (${msg.split('\n')[0]})`);
      return true;
    }
    console.warn(`  WARN: ${label} — ${msg.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error('FAIL: Set DATABASE_URL in backend/.env');
    process.exit(1);
  }

  if (!looksLikeCockroach(connectionString)) {
    console.warn('WARN: Host does not look like Cockroach Cloud. Continuing anyway.');
  }

  const host = connectionString.split('@')[1] || '(unknown)';
  console.log(`Connecting to: ${host}`);
  const pool = buildPool(connectionString);

  try {
    const probe = await pool.query('SELECT version() AS v, current_database() AS db');
    console.log(`✓ Connected: ${probe.rows[0].db}`);
    console.log(`  ${String(probe.rows[0].v).slice(0, 80)}`);
  } catch (error) {
    console.error('FAIL: Could not connect:', error.message);
    console.error('Hint: Cockroach Cloud needs SSL. Use ?sslmode=verify-full and DB_SSL=true');
    process.exit(1);
  }

  console.log('\n--- Core bridge + operational tables ---');

  await run(pool, 'documents', `
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )
  `);

  await run(pool, 'consignments', `
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
    )
  `);

  await run(pool, 'skus', `
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
    )
  `);

  await run(pool, 'boxes', `
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
    )
  `);

  await run(pool, 'box_items', `
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
    )
  `);

  await run(pool, 'videos', `
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
      box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,
      box_no TEXT,
      original_name TEXT,
      file_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      storage_provider TEXT NOT NULL DEFAULT 'r2',
      storage_path TEXT,
      url TEXT,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await run(pool, 'shipment_documents', `
    CREATE TABLE IF NOT EXISTS shipment_documents (
      id TEXT PRIMARY KEY,
      consignment_id TEXT REFERENCES consignments(id) ON DELETE CASCADE,
      type TEXT,
      original_name TEXT,
      file_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      storage_provider TEXT NOT NULL DEFAULT 'r2',
      storage_path TEXT,
      url TEXT,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await run(pool, 'users', `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      firebase_uid TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'packer',
      warehouse_id TEXT,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      password_hash TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_login_at TIMESTAMPTZ,
      source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await run(pool, 'marketplaces', `
    CREATE TABLE IF NOT EXISTS marketplaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      transit_days INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      source_document JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await run(pool, 'audit_logs', `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      user_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await run(pool, 'productivity_events', `
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
    )
  `);

  await run(pool, 'packing_sync_jobs', `
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
    )
  `);

  await run(pool, 'scan_events', `
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
    )
  `);

  await run(pool, 'oms_guru_upload_logs', `
    CREATE TABLE IF NOT EXISTS oms_guru_upload_logs (
      id TEXT PRIMARY KEY,
      consignment_id TEXT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
      file_name TEXT,
      uploaded_by TEXT,
      uploaded_by_name TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      updated_sku_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      changes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  console.log('\n--- Additive columns ---');

  await run(pool, 'consignments.oms_guru_*', `
    ALTER TABLE consignments ADD COLUMN IF NOT EXISTS oms_guru_qty_removed BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE consignments ADD COLUMN IF NOT EXISTS oms_guru_qty_removed_at TIMESTAMPTZ;
    ALTER TABLE consignments ADD COLUMN IF NOT EXISTS oms_guru_qty_removed_by TEXT;
    ALTER TABLE consignments ADD COLUMN IF NOT EXISTS is_disputed BOOLEAN NOT NULL DEFAULT false
  `);

  await run(pool, 'skus.oms_guru_*', `
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS oms_guru_removed_qty INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS oms_guru_remarks TEXT;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS oms_guru_updated_at TIMESTAMPTZ;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS oms_guru_updated_by TEXT
  `);

  await run(pool, 'skus.inward_*', `
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS inward_qty INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS quantity_difference INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS inward_status TEXT NOT NULL DEFAULT 'not_inwarded';
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS inward_upload_ref TEXT;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS inward_date DATE;
    ALTER TABLE skus ADD COLUMN IF NOT EXISTS inward_remarks TEXT
  `);

  await run(pool, 'boxes.video_*', `
    ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_id TEXT;
    ALTER TABLE boxes ADD COLUMN IF NOT EXISTS video_updated_at TIMESTAMPTZ
  `);

  console.log('\n--- Indexes ---');

  const indexes = [
    ['idx_documents_collection', 'CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection)'],
    ['idx_documents_data_inverted', 'CREATE INVERTED INDEX IF NOT EXISTS idx_documents_data_inverted ON documents(data)'],
    ['idx_documents_updated_at', 'CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(collection, updated_at DESC)'],
    ['idx_documents_consignment_id', `CREATE INDEX IF NOT EXISTS idx_documents_consignment_id ON documents ((data->>'consignmentId'))`],
    ['idx_consignments_status_updated', 'CREATE INDEX IF NOT EXISTS idx_consignments_status_updated ON consignments(status, updated_at DESC)'],
    ['idx_consignments_marketplace_dispatch', 'CREATE INDEX IF NOT EXISTS idx_consignments_marketplace_dispatch ON consignments(marketplace_id, scheduled_dispatch_date)'],
    ['idx_consignments_oms_guru_pending', 'CREATE INDEX IF NOT EXISTS idx_consignments_oms_guru_pending ON consignments (oms_guru_qty_removed)'],
    ['idx_consignments_video_retention', 'CREATE INDEX IF NOT EXISTS idx_consignments_video_retention_protection ON consignments(date_of_inward, is_disputed, marketplace_ticket_id)'],
    ['idx_skus_consignment', 'CREATE INDEX IF NOT EXISTS idx_skus_consignment ON skus(consignment_id)'],
    ['idx_skus_lookup', 'CREATE INDEX IF NOT EXISTS idx_skus_lookup ON skus(consignment_id, barcode, marketplace_sku, internal_sku)'],
    ['idx_skus_inward_status', 'CREATE INDEX IF NOT EXISTS idx_skus_inward_status ON skus (inward_status)'],
    ['idx_skus_consignment_inward', 'CREATE INDEX IF NOT EXISTS idx_skus_consignment_inward ON skus (consignment_id, inward_status)'],
    ['idx_boxes_consignment', 'CREATE INDEX IF NOT EXISTS idx_boxes_consignment ON boxes(consignment_id, box_no)'],
    ['idx_boxes_video_status', 'CREATE INDEX IF NOT EXISTS idx_boxes_video_status ON boxes(consignment_id, video_status)'],
    ['idx_box_items_box', 'CREATE INDEX IF NOT EXISTS idx_box_items_box ON box_items(box_id)'],
    ['idx_box_items_consignment_sku', 'CREATE INDEX IF NOT EXISTS idx_box_items_consignment_sku ON box_items(consignment_id, sku_id)'],
    ['idx_box_items_box_sku_barcode', `CREATE UNIQUE INDEX IF NOT EXISTS idx_box_items_box_sku_barcode ON box_items(box_id, COALESCE(sku_id, ''), COALESCE(barcode, ''), COALESCE(marketplace_sku, ''))`],
    ['idx_videos_consignment', 'CREATE INDEX IF NOT EXISTS idx_videos_consignment ON videos(consignment_id, box_no)'],
    ['idx_videos_consignment_box', 'CREATE INDEX IF NOT EXISTS idx_videos_consignment_box ON videos (consignment_id, box_no)'],
    ['idx_shipment_documents_consignment', 'CREATE INDEX IF NOT EXISTS idx_shipment_documents_consignment ON shipment_documents(consignment_id)'],
    ['idx_users_firebase_uid', 'CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)'],
    ['idx_audit_logs_entity', 'CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id, created_at DESC)'],
    ['idx_productivity_events_consignment', 'CREATE INDEX IF NOT EXISTS idx_productivity_events_consignment ON productivity_events(consignment_id, created_at DESC)'],
    ['idx_packing_sync_jobs_status', 'CREATE INDEX IF NOT EXISTS idx_packing_sync_jobs_status ON packing_sync_jobs(status, created_at)'],
    ['idx_scan_events_consignment_created', 'CREATE INDEX IF NOT EXISTS idx_scan_events_consignment_created ON scan_events(consignment_id, created_at DESC)'],
    ['idx_scan_events_station_created', 'CREATE INDEX IF NOT EXISTS idx_scan_events_station_created ON scan_events(station_id, created_at DESC)'],
    ['idx_oms_guru_upload_logs_consignment', 'CREATE INDEX IF NOT EXISTS idx_oms_guru_upload_logs_consignment ON oms_guru_upload_logs(consignment_id, created_at DESC)'],
  ];

  for (const [name, sql] of indexes) {
    await run(pool, name, sql);
  }

  console.log('\n--- Sync triggers (best-effort) ---');
  // Prefer PROCEDURE-style execution for wider Cockroach compatibility.
  await run(pool, 'sync_documents_to_relational fn', `
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
          NEW.data->>'consignmentId',
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
          NEW.data->>'consignmentId',
          COALESCE(NEW.data->>'boxNo', NEW.id),
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
      ELSIF NEW.collection = 'videos' THEN
        INSERT INTO videos (
          id, consignment_id, box_no, original_name, storage_path, url, source_document, created_at, updated_at
        ) VALUES (
          NEW.id,
          NEW.data->>'consignmentId',
          NEW.data->>'boxNo',
          NEW.data->>'originalName',
          NEW.data->>'storagePath',
          NEW.data->>'url',
          NEW.data,
          COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
          NEW.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          consignment_id = EXCLUDED.consignment_id,
          box_no = EXCLUDED.box_no,
          original_name = EXCLUDED.original_name,
          storage_path = EXCLUDED.storage_path,
          url = EXCLUDED.url,
          updated_at = EXCLUDED.updated_at;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // videos table has no source_document — fix trigger if that part failed partially
  // Use a simpler trigger without videos.source_document
  await run(pool, 'sync_documents_to_relational fn (compat)', `
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
          NEW.data->>'consignmentId',
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
          NEW.data->>'consignmentId',
          COALESCE(NEW.data->>'boxNo', NEW.id),
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
      ELSIF NEW.collection = 'videos' THEN
        INSERT INTO videos (
          id, consignment_id, box_no, original_name, storage_path, url, created_at, updated_at
        ) VALUES (
          NEW.id,
          NEW.data->>'consignmentId',
          NEW.data->>'boxNo',
          NEW.data->>'originalName',
          NEW.data->>'storagePath',
          NEW.data->>'url',
          COALESCE((NEW.data->>'createdAt')::TIMESTAMPTZ, NEW.created_at),
          NEW.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          consignment_id = EXCLUDED.consignment_id,
          box_no = EXCLUDED.box_no,
          original_name = EXCLUDED.original_name,
          storage_path = EXCLUDED.storage_path,
          url = EXCLUDED.url,
          updated_at = EXCLUDED.updated_at;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await run(pool, 'drop sync trigger', 'DROP TRIGGER IF EXISTS sync_documents_trigger ON documents');
  await run(pool, 'create sync trigger', `
    CREATE TRIGGER sync_documents_trigger
    AFTER INSERT OR UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION sync_documents_to_relational()
  `);

  await run(pool, 'sync_documents_delete fn', `
    CREATE OR REPLACE FUNCTION sync_documents_delete_to_relational()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.collection = 'consignments' THEN
        DELETE FROM consignments WHERE id = OLD.id;
      ELSIF OLD.collection = 'skus' THEN
        DELETE FROM skus WHERE id = OLD.id;
      ELSIF OLD.collection = 'boxes' THEN
        DELETE FROM boxes WHERE id = OLD.id;
      ELSIF OLD.collection = 'videos' THEN
        DELETE FROM videos WHERE id = OLD.id;
      ELSIF OLD.collection = 'users' THEN
        DELETE FROM users WHERE id = OLD.id;
      ELSIF OLD.collection = 'marketplaces' THEN
        DELETE FROM marketplaces WHERE id = OLD.id;
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);

  await run(pool, 'drop delete trigger', 'DROP TRIGGER IF EXISTS sync_documents_delete_trigger ON documents');
  await run(pool, 'create delete trigger', `
    CREATE TRIGGER sync_documents_delete_trigger
    AFTER DELETE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION sync_documents_delete_to_relational()
  `);

  console.log('\n--- Verify ---');
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log(`Tables (${tables.rows.length}):`, tables.rows.map((r) => r.table_name).join(', '));

  await pool.end();
  console.log('\n✓ Cockroach schema apply finished.');
  console.log('Note: This creates an empty database. Migrate data separately if you need existing consignments.');
}

main().catch((error) => {
  console.error('[Cockroach schema] Fatal:', error);
  process.exit(1);
});
