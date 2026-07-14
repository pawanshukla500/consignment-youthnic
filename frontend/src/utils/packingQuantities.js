function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function sumPackedQtyBySku(boxes = {}) {
  const totals = {}
  for (const items of Object.values(boxes || {})) {
    for (const item of items || []) {
      const skuId = item?.skuId
      if (!skuId) continue
      totals[skuId] = (totals[skuId] || 0) + toNumber(item.qty ?? item.quantity)
    }
  }
  return totals
}

export function recomputeSkuTotals(skus = [], boxes = {}) {
  const packedBySku = sumPackedQtyBySku(boxes)
  return skus.map((sku) => {
    const required = toNumber(sku.required ?? sku.requiredQty)
    const packed = packedBySku[sku.id] ?? 0
    const remaining = Math.max(0, required - packed)
    const overScanned = Math.max(0, packed - required)
    return {
      ...sku,
      packed,
      remaining,
      overScanned,
      status: required > 0 && packed >= required ? 'completed' : 'pending',
    }
  })
}

export function getShipmentQtySummary(skus = []) {
  return skus.reduce((acc, sku) => {
    acc.required += toNumber(sku.required)
    acc.packed += toNumber(sku.packed)
    acc.remaining += Math.max(0, toNumber(sku.remaining))
    acc.overScanned += Math.max(0, toNumber(sku.overScanned))
    return acc
  }, { required: 0, packed: 0, remaining: 0, overScanned: 0 })
}
