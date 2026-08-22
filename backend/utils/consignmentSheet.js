/**
 * Consignment Master sheet lookup.
 *
 * Fills the "SKU Items" table of the Create Consignment modal from a fixed
 * Google Sheet, keyed by Internal Shipment No.
 *
 * Layout (tab `Consignment_Master`, fixed column letters — header row, if any,
 * is ignored automatically because it can never match a real shipment number):
 *
 *   B → Marketplace Barcode (FNSKU / FSN / ASIN)
 *   C → Marketplace SKU
 *   D → Internal SKU (OMS SKU)
 *   F → Qty
 *   M → Internal Shipment No.  ← match key
 *
 * Barcode *type* is deliberately not read from the sheet; `skuIdentity`
 * infers it from the selected marketplace at create time, exactly as the
 * CSV import path already does.
 */

const {
  getSheetsClient,
  escapeSheetName,
  withRetry,
  parseQuantityCell,
  formatGoogleSheetsApiError,
  getSheetsCredentialStatus,
} = require('./googleSheetsInventory');

const DEFAULT_SHEET_ID = '1Kdcju2J9N4Y53hmvhiBGzDUab-m87FqPm2jJdJQ088U';
const DEFAULT_SHEET_NAME = 'Consignment_Master';

// Whole-tab cache. ~10K rows x 6 columns is small; a short TTL keeps a burst of
// lookups (pasting several shipment numbers in a row) down to one API call.
const CACHE_TTL_MS = Number(process.env.CONSIGNMENT_SHEET_CACHE_TTL_MS || 60_000);
const MAX_ROWS_PER_SHIPMENT = 500;

const cache = { rows: null, expiresAt: 0, sourceKey: null };

function getSheetId() {
  return String(process.env.CONSIGNMENT_SHEET_ID || DEFAULT_SHEET_ID).trim();
}

function getSheetName() {
  return String(process.env.CONSIGNMENT_SHEET_NAME || DEFAULT_SHEET_NAME).trim();
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

/** Match key: trimmed, case-insensitive, internal whitespace collapsed. */
function normalizeShipmentKey(value) {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure parser — unit-testable without Google APIs.
 * `skuValues` are rows of B:F, `shipmentValues` rows of M:M; both ranges are
 * unbounded from row 1, so index i refers to the same spreadsheet row.
 */
function parseConsignmentSheetValues(skuValues = [], shipmentValues = []) {
  const rows = [];
  const total = Math.max(skuValues.length, shipmentValues.length);

  for (let i = 0; i < total; i++) {
    const skuRow = skuValues[i] || [];
    const shipmentRow = shipmentValues[i] || [];

    const internalShipmentNo = clean(shipmentRow[0]);
    const marketplaceBarcode = clean(skuRow[0]); // B
    if (!internalShipmentNo || !marketplaceBarcode) continue;

    const qty = parseQuantityCell(skuRow[4]); // F

    rows.push({
      rowNumber: i + 1,
      internalShipmentNo,
      shipmentKey: normalizeShipmentKey(internalShipmentNo),
      marketplaceBarcode,
      marketplaceSku: clean(skuRow[1]) || marketplaceBarcode, // C
      internalSku: clean(skuRow[2]), // D
      requiredQty: qty.ok ? qty.value : 0,
    });
  }

  return rows;
}

/**
 * Collapse the rows of one shipment into SKU items for the create form.
 * Duplicate barcodes inside a shipment are merged with summed quantities.
 */
function buildSkuItems(rows = []) {
  const merged = new Map();

  for (const row of rows) {
    const key = row.marketplaceBarcode.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.requiredQty += row.requiredQty;
      if (!existing.marketplaceSku) existing.marketplaceSku = row.marketplaceSku;
      if (!existing.internalSku) existing.internalSku = row.internalSku;
      existing.mergedRows += 1;
      continue;
    }
    merged.set(key, {
      marketplaceBarcode: row.marketplaceBarcode,
      marketplaceBarcodeType: '', // inferred from the marketplace at create time
      marketplaceSku: row.marketplaceSku,
      internalSku: row.internalSku,
      requiredQty: row.requiredQty,
      mergedRows: 1,
    });
  }

  return [...merged.values()].map(({ mergedRows, ...sku }) => ({
    ...sku,
    requiredQty: String(sku.requiredQty),
  }));
}

async function readConsignmentSheetRows({ force = false } = {}) {
  const spreadsheetId = getSheetId();
  const sheetName = getSheetName();
  const sourceKey = `${spreadsheetId}::${sheetName}`;

  if (!force && cache.rows && cache.sourceKey === sourceKey && Date.now() < cache.expiresAt) {
    return { rows: cache.rows, cached: true };
  }

  const sheets = await getSheetsClient();
  const tab = escapeSheetName(sheetName);

  const response = await withRetry(
    () =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [`'${tab}'!B:F`, `'${tab}'!M:M`],
        majorDimension: 'ROWS',
      }),
    { retries: 2, delayMs: 1000, label: 'consignment sheet batchGet' }
  );

  const ranges = response?.data?.valueRanges || [];
  const rows = parseConsignmentSheetValues(ranges[0]?.values || [], ranges[1]?.values || []);

  cache.rows = rows;
  cache.sourceKey = sourceKey;
  cache.expiresAt = Date.now() + CACHE_TTL_MS;

  return { rows, cached: false };
}

function invalidateConsignmentSheetCache() {
  cache.rows = null;
  cache.expiresAt = 0;
  cache.sourceKey = null;
}

/**
 * Look up SKU items for one Internal Shipment No.
 * Never throws for operational problems — the caller shows a soft note and the
 * operator keeps entering SKUs by hand.
 */
async function lookupShipmentSkus(internalShipmentNo, { force = false, debug = false } = {}) {
  const requested = clean(internalShipmentNo);
  const key = normalizeShipmentKey(requested);

  if (!key) {
    return { found: false, internalShipmentNo: requested, skus: [], rowCount: 0, reason: 'empty_query' };
  }

  let rows;
  let cached = false;
  try {
    ({ rows, cached } = await readConsignmentSheetRows({ force }));
  } catch (err) {
    const status = getSheetsCredentialStatus();
    const message = formatGoogleSheetsApiError(err, {
      spreadsheetId: getSheetId(),
      clientEmail: status.sheetsClientEmail,
    });
    console.error('[ConsignmentSheet] Lookup failed:', message);
    return {
      found: false,
      internalShipmentNo: requested,
      skus: [],
      rowCount: 0,
      reason: 'sheet_unavailable',
      error: message,
    };
  }

  const matches = rows.filter((row) => row.shipmentKey === key);
  if (matches.length === 0) {
    return {
      found: false,
      internalShipmentNo: requested,
      skus: [],
      rowCount: 0,
      reason: 'not_found',
      cached,
      ...(debug ? { debug: buildDebugInfo(rows) } : {}),
    };
  }

  const capped = matches.slice(0, MAX_ROWS_PER_SHIPMENT);
  const skus = buildSkuItems(capped);

  return {
    found: true,
    // Echo the sheet's own spelling so the operator sees what actually matched.
    internalShipmentNo: capped[0].internalShipmentNo,
    skus,
    rowCount: matches.length,
    truncated: matches.length > capped.length,
    cached,
    ...(debug ? { debug: buildDebugInfo(rows, capped) } : {}),
  };
}

function buildDebugInfo(rows = [], matched = []) {
  return {
    spreadsheetId: getSheetId(),
    sheetName: getSheetName(),
    totalUsableRows: rows.length,
    sampleRows: rows.slice(0, 5),
    matchedRows: matched.slice(0, 5),
  };
}

module.exports = {
  DEFAULT_SHEET_ID,
  DEFAULT_SHEET_NAME,
  MAX_ROWS_PER_SHIPMENT,
  getSheetId,
  getSheetName,
  normalizeShipmentKey,
  parseConsignmentSheetValues,
  buildSkuItems,
  readConsignmentSheetRows,
  invalidateConsignmentSheetCache,
  lookupShipmentSkus,
};
