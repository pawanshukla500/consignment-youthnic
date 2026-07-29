const { firestoreHelpers } = require('./helpers');
const { pgEnabled, getPool } = require('../config/database');

async function resolveConsignmentByKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  let consignment = await firestoreHelpers.getDocument('consignments', trimmed);
  if (consignment) return consignment;

  const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', trimmed);
  if (byInternal.length) return byInternal[0];

  const byShipNo = await firestoreHelpers.queryCollection('consignments', 'shipmentNo', '==', trimmed);
  if (byShipNo.length) return byShipNo[0];

  // Case-insensitive fallback (PG) for id / internalShipmentNo / shipmentNo.
  const conflict = await findConsignmentIdentityConflict({
    keys: [trimmed],
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
 * Find an existing consignment that already owns any of the given identity keys.
 * Matches document id, data.id, internalShipmentNo, and shipmentNo (case-insensitive).
 * Archived consignments still count — the same number cannot be reused.
 *
 * @param {{ keys?: string[], excludeId?: string }} opts
 * @returns {Promise<null | { field: string, value: string, consignment: object }>}
 */
async function findConsignmentIdentityConflict({ keys = [], excludeId = null } = {}) {
  const normalized = [...new Set(
    (Array.isArray(keys) ? keys : [keys])
      .map((k) => String(k || '').trim())
      .filter(Boolean)
  )];
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
             lower(id) = ANY($1::text[])
             OR lower(coalesce(data->>'id','')) = ANY($1::text[])
             OR lower(coalesce(data->>'internalShipmentNo','')) = ANY($1::text[])
             OR (
               coalesce(data->>'shipmentNo','') <> ''
               AND lower(data->>'shipmentNo') = ANY($1::text[])
             )
           )
         LIMIT 1`,
        params
      );
      if (rows[0]) {
        const consignment = rows[0].data || { id: rows[0].id };
        const hit = lowerKeys.find((k) => (
          normalizeIdentityKey(rows[0].id) === k
          || normalizeIdentityKey(consignment.id) === k
          || normalizeIdentityKey(consignment.internalShipmentNo) === k
          || normalizeIdentityKey(consignment.shipmentNo) === k
        )) || lowerKeys[0];
        const field =
          normalizeIdentityKey(consignment.internalShipmentNo) === hit ? 'internalShipmentNo'
            : normalizeIdentityKey(consignment.shipmentNo) === hit ? 'shipmentNo'
              : 'id';
        const value =
          field === 'internalShipmentNo' ? consignment.internalShipmentNo
            : field === 'shipmentNo' ? consignment.shipmentNo
              : (consignment.id || rows[0].id);
        return { field, value: String(value || hit), consignment };
      }
      return null;
    } catch (e) {
      console.warn('[Consignments] identity conflict SQL failed, falling back:', e.message);
    }
  }

  // Memory / fallback path — exact field queries then case-insensitive scan.
  for (const key of normalized) {
    const byId = await firestoreHelpers.getDocument('consignments', key);
    if (byId && (!exclude || byId.id !== exclude)) {
      return { field: 'id', value: byId.id || key, consignment: byId };
    }
    const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', key);
    const internalHit = byInternal.find((c) => !exclude || c.id !== exclude);
    if (internalHit) {
      return { field: 'internalShipmentNo', value: internalHit.internalShipmentNo || key, consignment: internalHit };
    }
    const byShip = await firestoreHelpers.queryCollection('consignments', 'shipmentNo', '==', key);
    const shipHit = byShip.find((c) => !exclude || c.id !== exclude);
    if (shipHit) {
      return { field: 'shipmentNo', value: shipHit.shipmentNo || key, consignment: shipHit };
    }
  }

  try {
    const all = await firestoreHelpers.getCollection('consignments');
    const keySet = new Set(lowerKeys);
    for (const c of all) {
      if (!c || (exclude && c.id === exclude)) continue;
      if (keySet.has(normalizeIdentityKey(c.id))) {
        return { field: 'id', value: c.id, consignment: c };
      }
      if (c.internalShipmentNo && keySet.has(normalizeIdentityKey(c.internalShipmentNo))) {
        return { field: 'internalShipmentNo', value: c.internalShipmentNo, consignment: c };
      }
      if (c.shipmentNo && keySet.has(normalizeIdentityKey(c.shipmentNo))) {
        return { field: 'shipmentNo', value: c.shipmentNo, consignment: c };
      }
    }
  } catch (e) {
    console.warn('[Consignments] identity conflict fallback scan failed:', e.message);
  }

  return null;
}

function formatIdentityConflictError(conflict) {
  if (!conflict) return 'Consignment already exists';
  const label =
    conflict.field === 'internalShipmentNo' ? 'Internal Shipment No.'
      : conflict.field === 'shipmentNo' ? 'Shipment No.'
        : 'Consignment ID';
  return `${label} "${conflict.value}" already exists. You cannot create the same consignment again.`;
}

module.exports = {
  resolveConsignmentByKey,
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
};
