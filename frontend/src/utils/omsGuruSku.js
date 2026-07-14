export function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function computeBalanceQty(requiredQty, omsGuruRemovedQty) {
  return Math.max(0, toNumber(requiredQty) - toNumber(omsGuruRemovedQty))
}

export function computeOmsGuruStatus(requiredQty, omsGuruRemovedQty) {
  const required = toNumber(requiredQty)
  const removed = toNumber(omsGuruRemovedQty)
  if (removed <= 0) return 'Pending'
  if (required > 0 && removed >= required) return 'Completed'
  if (removed > 0) return 'Partial'
  return 'Pending'
}

export function hasPackedMismatch(packedQty, omsGuruRemovedQty) {
  return toNumber(packedQty) !== toNumber(omsGuruRemovedQty)
}

export function enrichSkuOmsGuru(sku) {
  const requiredQty = toNumber(sku.requiredQty)
  const packedQty = toNumber(sku.packedQty)
  const omsGuruRemovedQty = toNumber(sku.omsGuruRemovedQty)
  const balanceQty = computeBalanceQty(requiredQty, omsGuruRemovedQty)
  return {
    ...sku,
    omsGuruRemovedQty,
    omsGuruRemarks: sku.omsGuruRemarks || '',
    balanceQty,
    omsGuruStatus: computeOmsGuruStatus(requiredQty, omsGuruRemovedQty),
    packedOmsMismatch: hasPackedMismatch(packedQty, omsGuruRemovedQty),
  }
}

export function summarizeOmsGuruSkus(skus = []) {
  const enriched = skus.map(enrichSkuOmsGuru)
  const totalRequiredQty = enriched.reduce((sum, s) => sum + toNumber(s.requiredQty), 0)
  const totalPackedQty = enriched.reduce((sum, s) => sum + toNumber(s.packedQty), 0)
  const totalOmsGuruRemovedQty = enriched.reduce((sum, s) => sum + toNumber(s.omsGuruRemovedQty), 0)
  const totalBalanceQty = enriched.reduce((sum, s) => sum + toNumber(s.balanceQty), 0)
  const removalCompletionPct = totalRequiredQty > 0
    ? Math.min(100, Math.round((totalOmsGuruRemovedQty / totalRequiredQty) * 100))
    : 0
  const mismatchCount = enriched.filter((s) => s.packedOmsMismatch).length
  return {
    skus: enriched,
    totalRequiredQty,
    totalPackedQty,
    totalOmsGuruRemovedQty,
    totalBalanceQty,
    removalCompletionPct,
    mismatchCount,
  }
}

export function omsGuruStatusClass(status) {
  if (status === 'Completed') return 'bg-emerald-100 text-emerald-800'
  if (status === 'Partial') return 'bg-amber-100 text-amber-800'
  return 'bg-slate-100 text-slate-600'
}
