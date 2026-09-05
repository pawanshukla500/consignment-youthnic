const crypto = require('node:crypto');

function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      skuId: item?.skuId || null,
      barcode: item?.barcode || item?.marketplaceBarcode || null,
      marketplaceSku: item?.marketplaceSku || null,
      internalSku: item?.internalSku || item?.name || null,
      qty: Number(item?.qty ?? item?.quantity) || 0,
    }))
    .sort((a, b) => String(a.skuId || a.barcode || '').localeCompare(String(b.skuId || b.barcode || '')));
}

function buildBoxOperationPayload({
  consignmentId,
  boxNo,
  weight,
  weightUnit,
  weightImageId,
  items,
}) {
  return {
    consignmentId: String(consignmentId || ''),
    boxNo: String(boxNo || ''),
    weight: weight == null || weight === '' ? null : Number(weight),
    weightUnit: String(weightUnit || 'KG'),
    weightImageId: weightImageId || null,
    items: normalizeItems(items),
  };
}

function buildBoxOperationHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(buildBoxOperationPayload(payload)))
    .digest('hex');
}

function assertBoxOperationMatches(existing, expected) {
  if (!existing) return;
  const expectedHash = expected.payloadHash || buildBoxOperationHash(expected);
  if (
    String(existing.consignment_id) !== String(expected.consignmentId)
    || String(existing.box_id) !== String(expected.boxId)
    || String(existing.payload_hash) !== expectedHash
  ) {
    const error = new Error('operation_id was already used for a different box payload');
    error.statusCode = 409;
    error.code = 'BOX_OPERATION_PAYLOAD_MISMATCH';
    throw error;
  }
}

module.exports = {
  buildBoxOperationPayload,
  buildBoxOperationHash,
  assertBoxOperationMatches,
};
