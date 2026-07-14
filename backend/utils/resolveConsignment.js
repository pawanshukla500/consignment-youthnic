const { firestoreHelpers } = require('./helpers');

async function resolveConsignmentByKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return null;

  let consignment = await firestoreHelpers.getDocument('consignments', trimmed);
  if (consignment) return consignment;

  const byInternal = await firestoreHelpers.queryCollection('consignments', 'internalShipmentNo', '==', trimmed);
  if (byInternal.length) return byInternal[0];

  const byShipNo = await firestoreHelpers.queryCollection('consignments', 'shipmentNo', '==', trimmed);
  if (byShipNo.length) return byShipNo[0];

  return null;
}

function buildConsignmentId(requestedId, internalShipmentNo) {
  const trimmedId = String(requestedId || '').trim();
  if (trimmedId) return trimmedId;

  const fromInternal = String(internalShipmentNo || '').trim().replace(/[^\w.-]/g, '_');
  if (fromInternal) return fromInternal;

  return null;
}

module.exports = {
  resolveConsignmentByKey,
  buildConsignmentId,
};
