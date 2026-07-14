require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');

/**
 * Cockroach validates trigger functions as SQL and lowercases NEW → new,
 * which then fails as a relation prefix. Assign NEW/OLD to record vars first.
 */
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_documents_to_relational()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      n RECORD;
    BEGIN
      n := NEW;
      IF n.collection = 'consignments' THEN
        INSERT INTO consignments (
          id, internal_shipment_no, shipment_no, name, description, marketplace_id,
          status, date_of_inward, total_required_qty, total_packed_qty, source_document, created_at, updated_at
        ) VALUES (
          n.id,
          COALESCE(n.data->>'internalShipmentNo', 'UNKNOWN'),
          n.data->>'shipmentNo',
          n.data->>'name',
          n.data->>'description',
          n.data->>'marketplaceId',
          COALESCE(n.data->>'status', 'pending'),
          NULLIF(n.data->>'dateOfInward', '')::DATE,
          COALESCE((n.data->>'totalRequiredQty')::INTEGER, 0),
          COALESCE((n.data->>'totalPackedQty')::INTEGER, 0),
          n.data,
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
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
      ELSIF n.collection = 'skus' THEN
        INSERT INTO skus (
          id, consignment_id, barcode, marketplace_sku, internal_sku,
          required_qty, packed_qty, status, source_document, created_at, updated_at
        ) VALUES (
          n.id,
          n.data->>'consignmentId',
          n.data->>'barcode',
          n.data->>'marketplaceSku',
          n.data->>'internalSku',
          COALESCE((n.data->>'requiredQty')::INTEGER, 0),
          COALESCE((n.data->>'packedQty')::INTEGER, 0),
          COALESCE(n.data->>'status', 'pending'),
          n.data,
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
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
      ELSIF n.collection = 'boxes' THEN
        INSERT INTO boxes (
          id, consignment_id, box_no, total_qty, source_document, created_at, updated_at
        ) VALUES (
          n.id,
          n.data->>'consignmentId',
          COALESCE(n.data->>'boxNo', n.id),
          COALESCE((n.data->>'totalQty')::INTEGER, 0),
          n.data,
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          consignment_id = EXCLUDED.consignment_id,
          box_no = EXCLUDED.box_no,
          total_qty = EXCLUDED.total_qty,
          source_document = EXCLUDED.source_document,
          updated_at = EXCLUDED.updated_at;
      ELSIF n.collection = 'videos' THEN
        INSERT INTO videos (
          id, consignment_id, box_no, original_name, storage_path, url, created_at, updated_at
        ) VALUES (
          n.id,
          n.data->>'consignmentId',
          n.data->>'boxNo',
          n.data->>'originalName',
          n.data->>'storagePath',
          n.data->>'url',
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          consignment_id = EXCLUDED.consignment_id,
          box_no = EXCLUDED.box_no,
          original_name = EXCLUDED.original_name,
          storage_path = EXCLUDED.storage_path,
          url = EXCLUDED.url,
          updated_at = EXCLUDED.updated_at;
      ELSIF n.collection = 'users' THEN
        INSERT INTO users (
          id, email, name, role, permissions, firebase_uid, is_active, source_document, created_at, updated_at
        ) VALUES (
          n.id,
          COALESCE(n.data->>'email', n.id),
          n.data->>'name',
          COALESCE(n.data->>'role', 'packer'),
          COALESCE(n.data->'permissions', '{}'::jsonb),
          n.data->>'firebaseUid',
          COALESCE((n.data->>'isActive')::BOOLEAN, true),
          n.data,
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          permissions = EXCLUDED.permissions,
          firebase_uid = EXCLUDED.firebase_uid,
          is_active = EXCLUDED.is_active,
          source_document = EXCLUDED.source_document,
          updated_at = EXCLUDED.updated_at;
      ELSIF n.collection = 'marketplaces' THEN
        INSERT INTO marketplaces (
          id, name, code, transit_days, is_active, source_document, created_at, updated_at
        ) VALUES (
          n.id,
          COALESCE(n.data->>'name', n.id),
          n.data->>'code',
          COALESCE((n.data->>'transitDays')::INTEGER, 0),
          COALESCE((n.data->>'isActive')::BOOLEAN, true),
          n.data,
          COALESCE((n.data->>'createdAt')::TIMESTAMPTZ, n.created_at),
          n.updated_at
        ) ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          code = EXCLUDED.code,
          transit_days = EXCLUDED.transit_days,
          is_active = EXCLUDED.is_active,
          source_document = EXCLUDED.source_document,
          updated_at = EXCLUDED.updated_at;
      END IF;
      RETURN NEW;
    END;
    $$
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_documents_delete_to_relational()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      o RECORD;
    BEGIN
      o := OLD;
      IF o.collection = 'consignments' THEN
        DELETE FROM consignments WHERE id = o.id;
      ELSIF o.collection = 'skus' THEN
        DELETE FROM skus WHERE id = o.id;
      ELSIF o.collection = 'boxes' THEN
        DELETE FROM boxes WHERE id = o.id;
      ELSIF o.collection = 'videos' THEN
        DELETE FROM videos WHERE id = o.id;
      ELSIF o.collection = 'users' THEN
        DELETE FROM users WHERE id = o.id;
      ELSIF o.collection = 'marketplaces' THEN
        DELETE FROM marketplaces WHERE id = o.id;
      END IF;
      RETURN OLD;
    END;
    $$
  `);

  await pool.query('DROP TRIGGER IF EXISTS sync_documents_trigger ON documents');
  await pool.query(`
    CREATE TRIGGER sync_documents_trigger
    AFTER INSERT OR UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION sync_documents_to_relational()
  `);

  await pool.query('DROP TRIGGER IF EXISTS sync_documents_delete_trigger ON documents');
  await pool.query(`
    CREATE TRIGGER sync_documents_delete_trigger
    AFTER DELETE ON documents
    FOR EACH ROW EXECUTE FUNCTION sync_documents_delete_to_relational()
  `);

  const id = `mkt-trigger-${Date.now()}`;
  await pool.query(
    'INSERT INTO documents (collection, id, data) VALUES ($1, $2, $3::jsonb)',
    ['marketplaces', id, JSON.stringify({ name: 'Trigger Test', code: 'TRG', transitDays: 2, isActive: true })]
  );
  const m = await pool.query('SELECT name, code FROM marketplaces WHERE id = $1', [id]);
  console.log('trigger sync row:', m.rows[0] || null);
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  const after = await pool.query('SELECT count(*)::int AS n FROM marketplaces WHERE id = $1', [id]);
  console.log('after delete count:', after.rows[0].n);
  console.log('✓ Cockroach sync triggers installed');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
