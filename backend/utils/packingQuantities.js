function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumPackedQtyBySkuFromBoxes(boxes = {}) {
  const totals = {};
  for (const items of Object.values(boxes || {})) {
    for (const item of items || []) {
      const skuId = item?.skuId;
      if (!skuId) continue;
      totals[skuId] = (totals[skuId] || 0) + toNumber(item.qty ?? item.quantity);
    }
  }
  return totals;
}

function rebuildSessionSkuTotalsFromBoxes(session) {
  if (!session?.skus?.length) return session;
  const packedBySku = sumPackedQtyBySkuFromBoxes(session.boxes);
  for (const sku of session.skus) {
    const required = toNumber(sku.required ?? sku.requiredQty);
    const packed = packedBySku[sku.id] ?? 0;
    sku.packed = packed;
    sku.remaining = Math.max(0, required - packed);
    sku.overScanned = Math.max(0, packed - required);
    sku.status = required > 0 && packed >= required ? 'completed' : 'pending';
  }
  return session;
}

module.exports = {
  sumPackedQtyBySkuFromBoxes,
  rebuildSessionSkuTotalsFromBoxes,
};
