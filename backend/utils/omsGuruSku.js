const { format } = require('@fast-csv/format');
const { parseString } = require('@fast-csv/parse');

const TEMPLATE_HEADERS = [
  'Consignment ID',
  'Barcode',
  'Marketplace SKU',
  'Internal SKU (OMS)',
  'Required Qty',
  'Packed Qty',
  'OMSGuru Removed Qty',
  'Balance Qty',
  'Remarks',
];

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function computeBalanceQty(requiredQty, omsGuruRemovedQty) {
  return Math.max(0, toNumber(requiredQty) - toNumber(omsGuruRemovedQty));
}

function computeOmsGuruStatus(requiredQty, omsGuruRemovedQty) {
  const required = toNumber(requiredQty);
  const removed = toNumber(omsGuruRemovedQty);
  if (removed <= 0) return 'Pending';
  if (required > 0 && removed >= required) return 'Completed';
  if (removed > 0) return 'Partial';
  return 'Pending';
}

function hasPackedMismatch(packedQty, omsGuruRemovedQty) {
  return toNumber(packedQty) !== toNumber(omsGuruRemovedQty);
}

function enrichSkuOmsGuru(sku) {
  const requiredQty = toNumber(sku.requiredQty);
  const packedQty = toNumber(sku.packedQty);
  const omsGuruRemovedQty = toNumber(sku.omsGuruRemovedQty);
  const balanceQty = computeBalanceQty(requiredQty, omsGuruRemovedQty);
  return {
    ...sku,
    omsGuruRemovedQty,
    omsGuruRemarks: sku.omsGuruRemarks || '',
    balanceQty,
    omsGuruStatus: computeOmsGuruStatus(requiredQty, omsGuruRemovedQty),
    packedOmsMismatch: hasPackedMismatch(packedQty, omsGuruRemovedQty),
  };
}

function summarizeOmsGuruSkus(skus = []) {
  const enriched = skus.map(enrichSkuOmsGuru);
  const totalRequiredQty = enriched.reduce((sum, s) => sum + toNumber(s.requiredQty), 0);
  const totalPackedQty = enriched.reduce((sum, s) => sum + toNumber(s.packedQty), 0);
  const totalOmsGuruRemovedQty = enriched.reduce((sum, s) => sum + toNumber(s.omsGuruRemovedQty), 0);
  const totalBalanceQty = enriched.reduce((sum, s) => sum + toNumber(s.balanceQty), 0);
  const removalCompletionPct = totalRequiredQty > 0
    ? Math.min(100, Math.round((totalOmsGuruRemovedQty / totalRequiredQty) * 100))
    : 0;
  const mismatchCount = enriched.filter((s) => s.packedOmsMismatch).length;
  return {
    skus: enriched,
    totalRequiredQty,
    totalPackedQty,
    totalOmsGuruRemovedQty,
    totalBalanceQty,
    removalCompletionPct,
    mismatchCount,
  };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function buildOmsGuruTemplateCsv(consignmentId, skus = []) {
  const rows = skus.map((sku) => {
    const requiredQty = toNumber(sku.requiredQty);
    const packedQty = toNumber(sku.packedQty);
    const removedQty = toNumber(sku.omsGuruRemovedQty);
    return [
      consignmentId,
      sku.barcode || sku.marketplaceBarcode || '',
      sku.marketplaceSku || '',
      sku.internalSku || '',
      requiredQty,
      packedQty,
      removedQty,
      computeBalanceQty(requiredQty, removedQty),
      sku.omsGuruRemarks || '',
    ];
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = format({ headers: TEMPLATE_HEADERS });
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    rows.forEach((row) => stream.write(row));
    stream.end();
  });
}

function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ()]/g, '');
}

const HEADER_ALIASES = {
  'consignment id': 'consignmentId',
  'shipment id': 'consignmentId',
  barcode: 'barcode',
  'marketplace sku': 'marketplaceSku',
  'internal sku (oms)': 'internalSku',
  'internal sku': 'internalSku',
  'required qty': 'requiredQty',
  'packed qty': 'packedQty',
  'omsguru removed qty': 'omsGuruRemovedQty',
  'oms guru removed qty': 'omsGuruRemovedQty',
  'balance qty': 'balanceQty',
  remarks: 'remarks',
};

function mapCsvRow(rawRow) {
  const mapped = {};
  Object.entries(rawRow).forEach(([key, value]) => {
    const alias = HEADER_ALIASES[normalizeHeader(key)];
    if (alias) mapped[alias] = value;
  });
  return mapped;
}

async function parseOmsGuruCsv(bufferOrText) {
  const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : String(bufferOrText || '');
  return new Promise((resolve, reject) => {
    const rows = [];
    parseString(text, { headers: true, ignoreEmpty: true, trim: true })
      .on('error', reject)
      .on('data', (row) => rows.push(mapCsvRow(row)))
      .on('end', () => resolve(rows));
  });
}

function findSkuForImportRow(skus, row) {
  const internal = normalizeKey(row.internalSku);
  const marketplace = normalizeKey(row.marketplaceSku);
  const barcode = normalizeKey(row.barcode);
  if (!internal && !marketplace && !barcode) return null;

  const exact = skus.find((sku) => {
    const skuInternal = normalizeKey(sku.internalSku);
    const skuMarketplace = normalizeKey(sku.marketplaceSku);
    const skuBarcode = normalizeKey(sku.barcode || sku.marketplaceBarcode);
    if (internal && skuInternal !== internal) return false;
    if (marketplace && skuMarketplace !== marketplace) return false;
    if (barcode && skuBarcode !== barcode) return false;
    return true;
  });
  if (exact) return exact;

  if (internal) {
    return skus.find((sku) => normalizeKey(sku.internalSku) === internal) || null;
  }
  return null;
}

function validateImportRow(consignmentId, row, sku, rowIndex) {
  const errors = [];
  const rowConsignmentId = String(row.consignmentId || consignmentId).trim();
  if (rowConsignmentId && rowConsignmentId !== consignmentId) {
    errors.push(`Row ${rowIndex}: Consignment ID mismatch (${rowConsignmentId})`);
  }
  if (!sku) {
    errors.push(`Row ${rowIndex}: SKU not found (${row.internalSku || row.marketplaceSku || row.barcode || 'unknown'})`);
    return { errors, removedQty: null };
  }

  const removedRaw = row.omsGuruRemovedQty;
  if (removedRaw === '' || removedRaw == null) {
    return { errors, removedQty: null, skip: true };
  }

  const removedQty = parseInt(String(removedRaw).trim(), 10);
  if (Number.isNaN(removedQty) || removedQty < 0) {
    errors.push(`Row ${rowIndex}: OMSGuru Removed Qty must be a non-negative whole number`);
    return { errors, removedQty: null };
  }

  const requiredQty = toNumber(sku.requiredQty);
  if (removedQty > requiredQty) {
    errors.push(`Row ${rowIndex}: OMSGuru Removed Qty (${removedQty}) exceeds Required Qty (${requiredQty})`);
  }

  return { errors, removedQty, remarks: String(row.remarks || '').trim() };
}

module.exports = {
  TEMPLATE_HEADERS,
  toNumber,
  computeBalanceQty,
  computeOmsGuruStatus,
  hasPackedMismatch,
  enrichSkuOmsGuru,
  summarizeOmsGuruSkus,
  buildOmsGuruTemplateCsv,
  parseOmsGuruCsv,
  findSkuForImportRow,
  validateImportRow,
  csvEscape,
};
