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
  if (conflict?.consignment) return conflict.consignment;

  // Consignment No. may be shared. Use it only when exactly one shipment has it.
  return findSoleConsignmentByNumber(trimmed);
}

async function findSoleConsignmentByNumber(key) {
  const lowered = normalizeIdentityKey(key);
  if (!lowered) return null;

  if (pgEnabled()) {
    try {
      const { rows } = await getPool().query(
        `SELECT id, data
         FROM documents
         WHERE collection = 'consignments'
           AND lower(coalesce(data->>'consignmentNo','')) = $1
         LIMIT 2`,
        [lowered]
      );
      if (rows.length !== 1) return null;
      return rows[0].data || { id: rows[0].id };
    } catch (e) {
      console.warn('[Consignments] consignment number lookup failed:', e.message);
    }
  }

  try {
    const matches = await firestoreHelpers.queryCollection('consignments', 'consignmentNo', '==', key);
    const exact = matches.filter((row) => normalizeIdentityKey(row?.consignmentNo) === lowered);
    if (exact.length === 1) return exact[0];
  } catch (e) {
    console.warn('[Consignments] consignment number fallback failed:', e.message);
  }
  return null;
}

function buildConsignmentId(requestedId, internalShipmentNo) {
  // The document id follows the internal shipment. Marketplace consignment
  // numbers are repeatable, so they must not become the primary key.
  const fromInternal = String(internalShipmentNo || '').trim().replace(/[^\w.-]/g, '_');
  if (fromInternal) return fromInternal;

  const trimmedId = String(requestedId || '').trim();
  if (trimmedId) return trimmedId;

  return null;
}

/**
 * Decide how an edit changes identity without treating Consignment No. as unique.
 * The document id moves only when it was itself the internal shipment number,
 * so packed boxes, SKUs, and videos stay attached to the same shipment.
 */
function planIdentityUpdate(existing = {}, input = {}) {
  const hasInternal = Object.prototype.hasOwnProperty.call(input, 'internalShipmentNo');
  const hasConsignmentNo = Object.prototype.hasOwnProperty.call(input, 'consignmentNo');
  const nextInternal = hasInternal
    ? String(input.internalShipmentNo || '').trim()
    : String(existing.internalShipmentNo || '').trim();

  if (hasInternal && !nextInternal) {
    return { ok: false, error: 'Internal Shipment No. is required' };
  }

  const nextConsignmentNo = hasConsignmentNo
    ? String(input.consignmentNo || '').trim()
    : String(existing.consignmentNo || '').trim();

  const previousInternal = String(existing.internalShipmentNo || '').trim();
  const internalChanged = hasInternal && nextInternal !== previousInternal;
  const idFollowsInternal = normalizeIdentityKey(existing.id) === normalizeIdentityKey(previousInternal);
  const nextId = internalChanged && idFollowsInternal
    ? buildConsignmentId('', nextInternal)
    : String(existing.id || '').trim();
  const moveId = Boolean(nextId && normalizeIdentityKey(nextId) !== normalizeIdentityKey(existing.id));

  const keys = [];
  if (internalChanged || moveId) {
    if (nextInternal) keys.push(nextInternal);
    if (nextId) keys.push(nextId);
  }

  return {
    ok: true,
    nextInternal,
    nextConsignmentNo,
    pendingExternalId: hasConsignmentNo ? !nextConsignmentNo : Boolean(existing.pendingExternalId),
    consignmentNoChanged: hasConsignmentNo,
    nextId: nextId || existing.id,
    moveId,
    internalChanged,
    keys,
  };
}

function normalizeIdentityKey(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Find an existing consignment that already owns any of the given identity keys.
 * Matches document id, data.id, internalShipmentNo, and shipmentNo (case-insensitive).
 * Consignment No. is intentionally excluded — the same marketplace number can
 * belong to more than one internal shipment. Archived rows still count.
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
  if (!conflict) return 'That internal shipment is already used';
  const label =
    conflict.field === 'internalShipmentNo' ? 'Internal Shipment No.'
      : conflict.field === 'shipmentNo' ? 'Shipment No.'
        : 'Internal record id';
  return `${label} "${conflict.value}" is already used by another consignment. Internal shipments must stay unique. The same Consignment No. can be used again when the internal shipment is different.`;
}

module.exports = {
  resolveConsignmentByKey,
  buildConsignmentId,
  planIdentityUpdate,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
};
