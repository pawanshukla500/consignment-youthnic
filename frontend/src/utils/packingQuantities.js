function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function clonePackingBoxItems(items = []) {
  return (items || []).map((item) => ({ ...item }))
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

// `serverBoxCount` is captured once when the shipment loads, so it stays 0 for a
// station that packs offline. Reporting the higher of the two keeps the header
// truthful without letting a stale server value hide locally packed boxes.
export function resolveBoxCount(boxes = {}, serverBoxCount = 0) {
  const live = Object.keys(boxes || {}).filter((boxNo) => (boxes[boxNo] || []).length > 0).length
  return Math.max(Math.max(0, Math.trunc(toNumber(serverBoxCount))), live)
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
