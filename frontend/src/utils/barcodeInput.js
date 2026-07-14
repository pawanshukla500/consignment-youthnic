const BARCODE_PATTERN = /^[A-Za-z0-9\-_.]{4,64}$/

export function normalizeBarcodeInput(value) {
  return String(value || '').trim()
}

/** Mirrors backend getMarketplaceBarcode / getScanKeys field priority. */
export function getMarketplaceBarcode(sku) {
  return normalizeBarcodeInput(
    sku?.marketplaceBarcode
    || sku?.skuBarcode
    || sku?.scanBarcode
    || sku?.barcode
    || sku?.marketplaceSku
    || ''
  )
}

/** Canonical barcode sent to the packing API (must match backend skuMap keys). */
export function resolveQueueBarcode(sku, scannedInput) {
  const scanned = normalizeBarcodeInput(scannedInput)
  const canonical = getMarketplaceBarcode(sku)
  return canonical || scanned
}

export function barcodeMatchesSku(sku, barcode) {
  const key = normalizeBarcodeInput(barcode).toLowerCase()
  if (!key || !sku) return false
  return [
    sku.marketplaceBarcode,
    sku.skuBarcode,
    sku.scanBarcode,
    sku.barcode,
    sku.marketplaceSku,
    sku.internalSku,
  ]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase() === key)
}

export function isValidBarcode(value) {
  const v = normalizeBarcodeInput(value)
  if (!v || v.length < 4 || v.length > 64) return false
  if (/\s/.test(v)) return false
  return BARCODE_PATTERN.test(v)
}

export function barcodeValidationMessage(value) {
  const v = normalizeBarcodeInput(value)
  if (!v) return 'Scan a barcode'
  if (/\s/.test(v)) return 'Spaces are not allowed — use the barcode scanner'
  if (v.length < 4) return 'Barcode too short — scan the full marketplace barcode'
  if (v.length > 64) return 'Barcode too long'
  if (!BARCODE_PATTERN.test(v)) return 'Invalid barcode characters — scan only, do not type manually'
  return ''
}

/** Detect hardware scanner bursts (very fast key entry ending with Enter). */
export function createScannerInputGuard() {
  let lastKeyAt = 0
  let burstCount = 0

  return {
    noteKeyDown() {
      const now = Date.now()
      burstCount = now - lastKeyAt < 40 ? burstCount + 1 : 0
      lastKeyAt = now
    },
    isLikelyScanner() {
      return burstCount >= 3
    },
    reset() {
      lastKeyAt = 0
      burstCount = 0
    },
  }
}
