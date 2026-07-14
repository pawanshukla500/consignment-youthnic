function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function unique(values) {
  return Array.from(new Set(values.map(clean).filter(Boolean)));
}

function inferBarcodeType(marketplaceName = '') {
  const name = normalizeKey(marketplaceName);
  if (name.includes('amazon')) return 'FNSKU/ASIN';
  if (name.includes('flipkart')) return 'FSN';
  return '';
}

function getMarketplaceBarcode(raw = {}) {
  return clean(
    raw.marketplaceBarcode ||
    raw.skuBarcode ||
    raw.scanBarcode ||
    raw.barcode ||
    raw.marketplaceSku
  );
}

function getMarketplaceBarcodeType(raw = {}, marketplaceName = '') {
  return clean(
    raw.marketplaceBarcodeType ||
    raw.barcodeType ||
    raw.skuBarcodeType ||
    inferBarcodeType(marketplaceName)
  );
}

function normalizeSkuInput(raw = {}, options = {}) {
  const marketplaceBarcode = getMarketplaceBarcode(raw);
  const marketplaceSku = clean(raw.marketplaceSku || marketplaceBarcode);
  const internalSku = clean(raw.internalSku || raw.name);
  const marketplaceBarcodeType = getMarketplaceBarcodeType(raw, options.marketplaceName);

  return {
    marketplaceId: clean(raw.marketplaceId || options.marketplaceId),
    marketplaceBarcode,
    marketplaceBarcodeType,
    // Legacy aliases kept so existing pages, reports, and exports remain compatible.
    barcode: marketplaceBarcode,
    marketplaceSku,
    internalSku,
    name: clean(raw.name || internalSku || marketplaceSku || marketplaceBarcode),
  };
}

function getScanKeys(sku = {}) {
  return unique([
    sku.marketplaceBarcode,
    sku.skuBarcode,
    sku.scanBarcode,
    sku.barcode,
    sku.marketplaceSku,
  ]);
}

function findSkuByScanBarcode(skuMap = {}, barcode = '') {
  const key = clean(barcode);
  if (!key) return null;
  if (skuMap[key]) return skuMap[key];
  const lower = normalizeKey(key);
  for (const [mapKey, sku] of Object.entries(skuMap)) {
    if (normalizeKey(mapKey) === lower) return sku;
  }
  return null;
}

module.exports = {
  clean,
  getMarketplaceBarcode,
  getMarketplaceBarcodeType,
  getScanKeys,
  findSkuByScanBarcode,
  inferBarcodeType,
  normalizeSkuInput,
};
