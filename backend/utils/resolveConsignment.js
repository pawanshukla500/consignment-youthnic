const { firestoreHelpers } = require('./helpers');
const { pgEnabled, getPool } = require('../config/database');

async function resolveConsignmentByKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  let consignment = await firestoreHelpers.getDocument('consignments', trimmed);
  if (consignment) return consignment;

  const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', trimmed);
  if (byInternal.length) return byInternal[0];

  const byConsignmentNo = await firestoreHelpers.queryCollection('consignments', 'consignmentNo', '==', trimmed);
  if (byConsignmentNo.length) {
    const active = byConsignmentNo.find((c) => c?.status !== 'archived' && c?.status !== 'inward_completed') || byConsignmentNo[0];
    if (active) return active;
  }

  const byShipNo = await firestoreHelpers.queryCollection('consignments', 'shipmentNo', '==', trimmed);
  if (byShipNo.length) {
    const active = byShipNo.find((c) => c?.status !== 'archived' && c?.status !== 'inward_completed') || byShipNo[0];
    if (active) return active;
  }

  // Case-insensitive fallback (PG) for id / internalShipmentNo / consignmentNo / shipmentNo.
  if (pgEnabled()) {
    try {
      const lower = trimmed.toLowerCase();
      const { rows } = await getPool().query(
        `SELECT id, data FROM documents
         WHERE collection = 'consignments'
           AND (
             lower(id) = $1
             OR lower(coalesce(data->>'internalShipmentNo','')) = $1
             OR lower(coalesce(data->>'consignmentNo','')) = $1
             OR lower(coalesce(data->>'shipmentNo','')) = $1
           )
         ORDER BY (CASE WHEN coalesce(data->>'status','') NOT IN ('archived','inward_completed') THEN 0 ELSE 1 END), updated_at DESC
         LIMIT 1`,
        [lower]
      );
      if (rows[0]) return rows[0].data || { id: rows[0].id };
    } catch (e) {
      console.warn('[Consignments] case-insensitive lookup failed:', e.message);
    }
  }

  const conflict = await findConsignmentIdentityConflict({
    internalShipmentNo: trimmed,
  });
  return conflict?.consignment || null;
}

function buildConsignmentId(requestedId, internalShipmentNo) {
  const trimmedId = String(requestedId || '').trim();
  if (trimmedId) return trimmedId;

  const fromInternal = String(internalShipmentNo || '').trim().replace(/[^\w.-]/g, '_');
  if (fromInternal) return fromInternal;

  return null;
}

function normalizeIdentityKey(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Find an existing consignment that already owns the internalShipmentNo.
 * Internal shipment numbers MUST remain strictly unique across all consignments (including archived).
 * Consignment numbers / Consignment IDs can be reused across different internal shipments.
 *
 * @param {{ internalShipmentNo?: string, keys?: string[], excludeId?: string }} opts
 * @returns {Promise<null | { field: string, value: string, consignment: object }>}
 */
async function findConsignmentIdentityConflict({ internalShipmentNo = null, keys = [], excludeId = null } = {}) {
  const targets = [];
  if (internalShipmentNo) {
    const s = String(internalShipmentNo || '').trim();
    if (s) targets.push(s);
  } else if (keys && (Array.isArray(keys) ? keys.length : true)) {
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
      const s = String(k || '').trim();
      if (s) targets.push(s);
    });
  }

  const normalized = [...new Set(targets)];
  if (!normalized.length) return null;

  const exclude = String(excludeId || '').trim();
  const lowerKeys = normalized.map((k) => k.toLowerCase());

  if (pgEnabled()) {
    try {
      const params = [lowerKeys];
      let n = 2;
      let excludeSql = '';
      if (exclude) {
        excludeSql = `AND lower(id) <> lower($${n++})`;
        params.push(exclude);
      }
      const { rows } = await getPool().query(
        `SELECT id, data
         FROM documents
         WHERE collection = 'consignments'
           ${excludeSql}
           AND (
             lower(coalesce(data->>'internalShipmentNo','')) = ANY($1::text[])
             OR (
               coalesce(data->>'internalShipmentNo','') = ''
               AND lower(id) = ANY($1::text[])
             )
           )
         LIMIT 1`,
        params
      );
      if (rows[0]) {
        const consignment = rows[0].data || { id: rows[0].id };
        const value = consignment.internalShipmentNo || rows[0].id;
        return { field: 'internalShipmentNo', value: String(value), consignment };
      }
      return null;
    } catch (e) {
      console.warn('[Consignments] identity conflict SQL failed, falling back:', e.message);
    }
  }

  // Memory / fallback path — search internalShipmentNo
  for (const key of normalized) {
    const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', key);
    const internalHit = byInternal.find((c) => !exclude || c.id !== exclude);
    if (internalHit) {
      return { field: 'internalShipmentNo', value: internalHit.internalShipmentNo || key, consignment: internalHit };
    }
  }

  try {
    const all = await firestoreHelpers.getCollection('consignments');
    const keySet = new Set(lowerKeys);
    for (const c of all) {
      if (!c || (exclude && c.id === exclude)) continue;
      const internalKey = normalizeIdentityKey(c.internalShipmentNo || (c.id && !c.internalShipmentNo ? c.id : ''));
      if (internalKey && keySet.has(internalKey)) {
        return { field: 'internalShipmentNo', value: c.internalShipmentNo || c.id, consignment: c };
      }
    }
  } catch (e) {
    console.warn('[Consignments] identity conflict fallback scan failed:', e.message);
  }

  return null;
}

function formatIdentityConflictError(conflict) {
  if (!conflict) return 'Consignment already exists';
  return `Internal Shipment No. "${conflict.value}" already exists. Each internal shipment must be unique.`;
}

module.exports = {
  resolveConsignmentByKey,
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
};
