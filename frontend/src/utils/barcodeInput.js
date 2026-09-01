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

/**
 * Exactly-once submission gate for one populated input generation.
 *
 * This deliberately does not use timing or barcode-value debouncing. A new
 * input event always permits another submission, including the same barcode.
 * Duplicate Enter/CR/LF/TAB and keydown+form-submit paths share one generation.
 */
export function createScannerInputGuard() {
  let inputGeneration = 0
  let submittedGeneration = -1

  return {
    noteInput() {
      inputGeneration += 1
    },
    consumeSubmission(value) {
      if (!normalizeBarcodeInput(value)) return false
      if (submittedGeneration === inputGeneration) return false
      submittedGeneration = inputGeneration
      return true
    },
    reset() {
      inputGeneration += 1
      submittedGeneration = -1
    },
  }
}
