/**
 * SKU-level inward quantity tracking (separate from packing / OMS removals).
 */
const { parseString } = require('@fast-csv/parse');

const TEMPLATE_HEADERS = [
  'Consignment ID',
  'Barcode',
  'Marketplace SKU',
  'Internal SKU',
  'Packed Qty',
  'Inward Qty',
  'Inward Date',
  'Remarks',
];

const INWARD_STATUSES = {
  not_inwarded: 'Not inwarded',
  fully_inwarded: 'Fully inwarded',
  partially_inwarded: 'Partially inwarded',
  short_received: 'Short received',
  excess_received: 'Excess received',
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function computeInwardStatus(packedQty, inwardQty) {
  const packed = toNumber(packedQty);
  const inward = toNumber(inwardQty);
  if (inward <= 0) return 'not_inwarded';
  if (packed <= 0 && inward > 0) return 'excess_received';
  if (inward === packed) return 'fully_inwarded';
  if (inward < packed) {
    // Partial vs short: treat any positive under-pack as short when intentional full expected
    return inward > 0 && inward < packed * 0.99 ? 'short_received' : 'partially_inwarded';
  }
  return 'excess_received';
}

function computeQuantityDifference(packedQty, inwardQty) {
  return toNumber(inwardQty) - toNumber(packedQty);
}

function enrichSkuInward(sku) {
  const packedQty = toNumber(sku.packedQty);
  const inwardQty = toNumber(sku.inwardQty);
  const quantityDifference = computeQuantityDifference(packedQty, inwardQty);
  const inwardStatus = sku.inwardStatus || computeInwardStatus(packedQty, inwardQty);
  const mismatch = inwardQty > 0 && quantityDifference !== 0;
  return {
    ...sku,
    packedQty,
    inwardQty,
    quantityDifference,
    inwardStatus,
    inwardStatusLabel: INWARD_STATUSES[inwardStatus] || inwardStatus,
    inwardUploadRef: sku.inwardUploadRef || sku.inwardUploadId || null,
    inwardDate: sku.inwardDate || null,
    inwardRemarks: sku.inwardRemarks || '',
    inwardMismatch: mismatch,
  };
}

function summarizeInwardSkus(skus = []) {
  const enriched = skus.map(enrichSkuInward);
  const totalPackedQty = enriched.reduce((sum, s) => sum + toNumber(s.packedQty), 0);
  const totalInwardQty = enriched.reduce((sum, s) => sum + toNumber(s.inwardQty), 0);
  const mismatchCount = enriched.filter((s) => s.inwardMismatch).length;
  const notInwardedCount = enriched.filter((s) => s.inwardStatus === 'not_inwarded').length;
  const fullyInwardedCount = enriched.filter((s) => s.inwardStatus === 'fully_inwarded').length;
  const shortCount = enriched.filter((s) => s.inwardStatus === 'short_received' || s.inwardStatus === 'partially_inwarded').length;
  const excessCount = enriched.filter((s) => s.inwardStatus === 'excess_received').length;
  return {
    skus: enriched,
    totalPackedQty,
    totalInwardQty,
    totalDifference: totalInwardQty - totalPackedQty,
    mismatchCount,
    notInwardedCount,
    fullyInwardedCount,
    shortCount,
    excessCount,
    hasMismatch: mismatchCount > 0,
  };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildInwardTemplateCsv(consignment, skus = []) {
  const lines = [TEMPLATE_HEADERS.map(csvEscape).join(',')];
  for (const sku of skus) {
    lines.push([
      consignment.id,
      sku.marketplaceBarcode || sku.barcode || '',
      sku.marketplaceSku || '',
      sku.internalSku || '',
      toNumber(sku.packedQty),
      sku.inwardQty != null ? toNumber(sku.inwardQty) : '',
      sku.inwardDate || '',
      sku.inwardRemarks || '',
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseInwardCsv(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    parseString(buffer.toString('utf8'), { headers: true, trim: true, ignoreEmpty: true })
      .on('error', reject)
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows));
  });
}

function findSkuForInwardRow(skus, row) {
  const barcode = normalizeKey(row.Barcode || row.barcode);
  const marketplaceSku = normalizeKey(row['Marketplace SKU'] || row.marketplaceSku);
  const internalSku = normalizeKey(row['Internal SKU'] || row.internalSku);
  return skus.find((sku) => {
    const keys = [
      normalizeKey(sku.marketplaceBarcode),
      normalizeKey(sku.barcode),
      normalizeKey(sku.marketplaceSku),
      normalizeKey(sku.internalSku),
    ].filter(Boolean);
    return (
      (barcode && keys.includes(barcode))
      || (marketplaceSku && keys.includes(marketplaceSku))
      || (internalSku && keys.includes(internalSku))
    );
  });
}

function validateInwardRow(row) {
  const raw = row['Inward Qty'] ?? row.inwardQty;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { skip: true };
  }
  const inwardQty = Number(raw);
  if (!Number.isFinite(inwardQty) || inwardQty < 0 || !Number.isInteger(inwardQty)) {
    return { error: 'Inward Qty must be a non-negative whole number' };
  }
  return {
    inwardQty,
    inwardDate: String(row['Inward Date'] || row.inwardDate || '').trim() || null,
    remarks: String(row.Remarks || row.remarks || '').trim(),
  };
}

module.exports = {
  TEMPLATE_HEADERS,
  INWARD_STATUSES,
  toNumber,
  computeInwardStatus,
  computeQuantityDifference,
  enrichSkuInward,
  summarizeInwardSkus,
  buildInwardTemplateCsv,
  parseInwardCsv,
  findSkuForInwardRow,
  validateInwardRow,
};
