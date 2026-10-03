const { firestoreHelpers } = require('./helpers');
const { pgEnabled, getPool } = require('../config/database');

function normalizeIdentityKey(value) {
  return String(value || '').trim().toLowerCase();
}

function displayConsignmentNo(consignment) {
  return String(consignment?.consignmentNo || consignment?.id || '').trim();
}

/**
 * Stable unique document id is always derived from Internal Shipment No.
 * Marketplace consignment numbers may be reused across different internal shipments.
 */
function buildConsignmentId(requestedId, internalShipmentNo) {
  const fromInternal = String(internalShipmentNo || '').trim().replace(/[^\w.-]/g, '_');
  if (fromInternal) return fromInternal;
  const trimmedId = String(requestedId || '').trim();
  if (trimmedId) return trimmedId;
  return null;
}

function uniqueIdentityKeys({ resolvedId, internalShipmentNo } = {}) {
  return [...new Set(
    [resolvedId, internalShipmentNo]
      .map((k) => String(k || '').trim())
      .filter(Boolean)
  )];
}

function normalizeCreateIdentity({ id, consignmentNo, internalShipmentNo, shipmentNo } = {}) {
  const trimmedInternal = String(internalShipmentNo || '').trim();
  const trimmedConsignmentNo = String(consignmentNo || id || '').trim();
  const trimmedShipmentNo = String(shipmentNo || '').trim();
  const resolvedId = buildConsignmentId(null, trimmedInternal);
  return {
    trimmedInternal,
    trimmedConsignmentNo,
    trimmedShipmentNo,
    resolvedId,
    pendingExternalId: !trimmedConsignmentNo,
  };
}

function ambiguousConsignmentError(value) {
  const error = new Error(
    `Multiple consignments share "${value}". Load using the unique Internal Shipment No.`
  );
  error.statusCode = 409;
  error.code = 'AMBIGUOUS_CONSIGNMENT_ID';
  return error;
}

function identityRank(consignment, lowerKey) {
  if (normalizeIdentityKey(consignment?.id) === lowerKey) return 0;
  if (normalizeIdentityKey(consignment?.internalShipmentNo) === lowerKey) return 1;
  if (normalizeIdentityKey(consignment?.consignmentNo) === lowerKey) return 2;
  if (normalizeIdentityKey(consignment?.shipmentNo) === lowerKey) return 3;
  return 9;
}

function pickResolvedConsignment(matches, key) {
  const lower = normalizeIdentityKey(key);
  const ranked = (Array.isArray(matches) ? matches : []).filter(Boolean);
  if (!ranked.length) return null;

  const bestRank = Math.min(...ranked.map((c) => identityRank(c, lower)));
  const best = ranked.filter((c) => identityRank(c, lower) === bestRank);
  if (best.length > 1 && bestRank >= 2) {
    throw ambiguousConsignmentError(key);
  }
  if (best.length > 1) {
    throw ambiguousConsignmentError(key);
  }
  return best[0];
}

async function findLookupMatchesPg(lowerKey) {
  const { rows } = await getPool().query(
    `SELECT id, data
     FROM documents
     WHERE collection = 'consignments'
       AND (
         lower(id) = $1
         OR lower(coalesce(data->>'id','')) = $1
         OR lower(coalesce(data->>'internalShipmentNo','')) = $1
         OR lower(coalesce(data->>'consignmentNo','')) = $1
         OR (
           coalesce(data->>'shipmentNo','') <> ''
           AND lower(data->>'shipmentNo') = $1
         )
       )`,
    [lowerKey]
  );
  return rows.map((row) => {
    const consignment = row.data || { id: row.id };
    return { ...consignment, id: consignment.id || row.id };
  });
}

async function resolveConsignmentByKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  const byId = await firestoreHelpers.getDocument('consignments', trimmed);
  if (byId) return byId;

  const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', trimmed);
  if (byInternal.length === 1) return byInternal[0];
  if (byInternal.length > 1) throw ambiguousConsignmentError(trimmed);

  if (pgEnabled()) {
    try {
      const matches = await findLookupMatchesPg(trimmed.toLowerCase());
      return pickResolvedConsignment(matches, trimmed);
    } catch (e) {
      if (e.code === 'AMBIGUOUS_CONSIGNMENT_ID') throw e;
      console.warn('[Consignments] lookup SQL failed, falling back:', e.message);
    }
  }

  const byConsNo = await firestoreHelpers.queryCollection('consignments', 'consignmentNo', '==', trimmed);
  const byShipNo = await firestoreHelpers.queryCollection('consignments', 'shipmentNo', '==', trimmed);
  try {
    const all = await firestoreHelpers.getCollection('consignments');
    const lower = normalizeIdentityKey(trimmed);
    const matches = (all || []).filter((c) => c && (
      normalizeIdentityKey(c.id) === lower
      || normalizeIdentityKey(c.internalShipmentNo) === lower
      || normalizeIdentityKey(c.consignmentNo) === lower
      || normalizeIdentityKey(c.shipmentNo) === lower
    ));
    if (matches.length) return pickResolvedConsignment(matches, trimmed);
  } catch (e) {
    console.warn('[Consignments] lookup fallback scan failed:', e.message);
  }

  const combined = [...byConsNo, ...byShipNo];
  if (combined.length) return pickResolvedConsignment(combined, trimmed);
  return null;
}

/**
 * Find an existing consignment that already owns a *unique* identity key.
 * Unique keys are document id and internalShipmentNo only.
 * Marketplace consignmentNo may be reused when Internal Shipment No differs.
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
        )) || lowerKeys[0];
        const field = normalizeIdentityKey(consignment.internalShipmentNo) === hit
          ? 'internalShipmentNo'
          : 'id';
        const value = field === 'internalShipmentNo'
          ? consignment.internalShipmentNo
          : (consignment.id || rows[0].id);
        return { field, value: String(value || hit), consignment };
      }
      return null;
    } catch (e) {
      console.warn('[Consignments] identity conflict SQL failed, falling back:', e.message);
    }
  }

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
    }
  } catch (e) {
    console.warn('[Consignments] identity conflict fallback scan failed:', e.message);
  }

  return null;
}

function formatIdentityConflictError(conflict) {
  if (!conflict) return 'Consignment already exists';
  if (conflict.field === 'internalShipmentNo') {
    return `Internal Shipment No. "${conflict.value}" already exists. Each internal shipment must be unique — the same Consignment No. can be used on more than one internal shipment.`;
  }
  return `Internal identity "${conflict.value}" already exists as another consignment. Internal Shipment No. must stay unique.`;
}

module.exports = {
  resolveConsignmentByKey,
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
  normalizeIdentityKey,
  displayConsignmentNo,
  uniqueIdentityKeys,
  normalizeCreateIdentity,
  pickResolvedConsignment,
  ambiguousConsignmentError,
};
