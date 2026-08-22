/**
 * Push box-wise packing data back into the Consignment Master sheet.
 *
 * Writes two columns only, matching the format the operations team maintains
 * by hand:
 *
 *   I  Box wise Qty   "42,8,10,7"
 *   J  Box number     "10,11,12,20"
 *
 * The two lists are positionally aligned and sorted by ascending box number,
 * comma-separated with no spaces. A SKU with nothing packed gets both cells
 * blanked, so the sheet always mirrors the app.
 *
 * Rows are located by column M (internal consignment id) = the consignment's
 * Internal Shipment No., then by column B (FNSKU / marketplace barcode).
 * Writes go to fixed cells, so re-running a push is idempotent — which is what
 * makes the daily sweep safe on multi-instance Cloud Run.
 */

const {
  getSheetsClient,
  escapeSheetName,
  withRetry,
  formatGoogleSheetsApiError,
  getSheetsCredentialStatus,
} = require('./googleSheetsInventory');
const {
  getSheetId,
  getSheetName,
  normalizeShipmentKey,
  invalidateConsignmentSheetCache,
} = require('./consignmentSheet');

const QTY_COLUMN = 'I';
const BOX_COLUMN = 'J';

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function barcodeKey(value) {
  return clean(value).toLowerCase();
}

/** Box numbers sort numerically when numeric, lexically otherwise. */
function compareBoxNo(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * { "10": 42, "11": 8, "20": 7 } → { qty: '42,8,7', boxes: '10,11,20' }
 * Zero and negative quantities are dropped; a SKU with nothing packed yields
 * two empty strings, which clears the cells.
 */
function formatBoxQtys(boxQtys = {}) {
  const entries = Object.entries(boxQtys || {})
    .map(([boxNo, qty]) => [clean(boxNo), Number(qty)])
    .filter(([boxNo, qty]) => boxNo && Number.isFinite(qty) && qty > 0)
    .sort((a, b) => compareBoxNo(a[0], b[0]));

  return {
    qty: entries.map(([, qty]) => String(qty)).join(','),
    boxes: entries.map(([boxNo]) => boxNo).join(','),
  };
}

/**
 * Pure planner — unit-testable without Google APIs.
 *
 * Pairs packing-report rows with sheet rows and returns the cell writes plus a
 * reconciliation of what could not be matched in either direction.
 */
function buildPushPlan({ internalShipmentNo, reportRows = [], sheetRows = [] }) {
  const shipmentKey = normalizeShipmentKey(internalShipmentNo);
  const updates = [];
  const unmatchedSkus = [];
  const duplicateSheetRows = [];
  let cleared = 0;
  let written = 0;

  if (!shipmentKey) {
    return { updates, unmatchedSkus, duplicateSheetRows, cleared, written, shipmentRowCount: 0 };
  }

  // Sheet rows belonging to this shipment, indexed by barcode. A barcode that
  // appears twice for one shipment is ambiguous: it is reported and skipped
  // rather than guessed at.
  const byBarcode = new Map();
  const seenTwice = new Set();
  let shipmentRowCount = 0;

  for (const row of sheetRows) {
    if (normalizeShipmentKey(row.internalShipmentNo) !== shipmentKey) continue;
    shipmentRowCount++;
    const key = barcodeKey(row.marketplaceBarcode);
    if (!key) continue;
    if (byBarcode.has(key)) {
      seenTwice.add(key);
      continue;
    }
    byBarcode.set(key, row);
  }

  for (const key of seenTwice) {
    byBarcode.delete(key);
    duplicateSheetRows.push(key);
  }

  for (const reportRow of reportRows) {
    const key = barcodeKey(reportRow.marketplaceBarcode || reportRow.barcode);
    const sheetRow = key ? byBarcode.get(key) : null;
    if (!sheetRow) {
      unmatchedSkus.push({
        marketplaceBarcode: clean(reportRow.marketplaceBarcode || reportRow.barcode),
        internalSku: clean(reportRow.internalSku),
        reason: duplicateSheetRows.includes(key) ? 'duplicate_sheet_row' : 'no_sheet_row',
      });
      continue;
    }

    const { qty, boxes } = formatBoxQtys(reportRow.boxQtys);
    if (qty) written++;
    else cleared++;

    updates.push({
      rowNumber: sheetRow.rowNumber,
      marketplaceBarcode: sheetRow.marketplaceBarcode,
      qty,
      boxes,
    });
  }

  updates.sort((a, b) => a.rowNumber - b.rowNumber);
  return { updates, unmatchedSkus, duplicateSheetRows, cleared, written, shipmentRowCount };
}

/**
 * Fingerprint of the packing state actually written. The daily sweep uses it to
 * skip consignments whose boxes have not changed since the last push.
 */
function buildPushFingerprint(updates = []) {
  return updates
    .map((u) => `${u.rowNumber}:${u.boxes}:${u.qty}`)
    .join('|');
}

/** Read columns B, I, J and M with row numbers. Never served from cache. */
async function readSheetRowsForPush(sheets) {
  const spreadsheetId = getSheetId();
  const tab = escapeSheetName(getSheetName());

  const response = await withRetry(
    () =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [`'${tab}'!B:B`, `'${tab}'!M:M`],
        majorDimension: 'ROWS',
      }),
    { retries: 2, delayMs: 1000, label: 'consignment sheet push read' }
  );

  const ranges = response?.data?.valueRanges || [];
  const barcodes = ranges[0]?.values || [];
  const shipments = ranges[1]?.values || [];
  const total = Math.max(barcodes.length, shipments.length);

  const rows = [];
  for (let i = 0; i < total; i++) {
    const marketplaceBarcode = clean((barcodes[i] || [])[0]);
    const internalShipmentNo = clean((shipments[i] || [])[0]);
    if (!marketplaceBarcode || !internalShipmentNo) continue;
    rows.push({ rowNumber: i + 1, marketplaceBarcode, internalShipmentNo });
  }
  return rows;
}

/**
 * Confirm the rows we are about to write still hold the barcode and shipment we
 * matched. Without this, a row inserted between read and write would send
 * quantities to the wrong SKU.
 */
function verifyTargets(updates, freshRows, internalShipmentNo) {
  const byRowNumber = new Map(freshRows.map((row) => [row.rowNumber, row]));
  const shipmentKey = normalizeShipmentKey(internalShipmentNo);
  const safe = [];
  const shifted = [];

  for (const update of updates) {
    const row = byRowNumber.get(update.rowNumber);
    if (
      row &&
      barcodeKey(row.marketplaceBarcode) === barcodeKey(update.marketplaceBarcode) &&
      normalizeShipmentKey(row.internalShipmentNo) === shipmentKey
    ) {
      safe.push(update);
    } else {
      shifted.push(update);
    }
  }
  return { safe, shifted };
}

/**
 * Push one consignment's packing report to the sheet.
 * Returns a result object; operational failures are reported, not thrown.
 */
async function pushPackingToSheet({ internalShipmentNo, reportRows = [], dryRun = false }) {
  const shipment = clean(internalShipmentNo);
  if (!shipment) {
    return { ok: false, reason: 'missing_shipment_no', error: 'Consignment has no Internal Shipment No.' };
  }

  let sheets;
  let sheetRows;
  try {
    sheets = await getSheetsClient();
    sheetRows = await readSheetRowsForPush(sheets);
  } catch (err) {
    const status = getSheetsCredentialStatus();
    const message = formatGoogleSheetsApiError(err, {
      spreadsheetId: getSheetId(),
      clientEmail: status.sheetsClientEmail,
    });
    console.error('[ConsignmentSheetPush] Read failed:', message);
    return { ok: false, reason: 'sheet_unavailable', error: message };
  }

  const plan = buildPushPlan({ internalShipmentNo: shipment, reportRows, sheetRows });

  if (plan.shipmentRowCount === 0) {
    return {
      ok: false,
      reason: 'shipment_not_in_sheet',
      error: `No rows in the sheet carry internal consignment id "${shipment}".`,
      ...summarize(plan),
    };
  }

  if (plan.updates.length === 0) {
    return { ok: true, reason: 'nothing_to_write', updated: 0, ...summarize(plan), fingerprint: '' };
  }

  const fingerprint = buildPushFingerprint(plan.updates);
  if (dryRun) {
    return { ok: true, dryRun: true, updated: 0, planned: plan.updates.length, fingerprint, ...summarize(plan) };
  }

  // Re-read immediately before writing so an inserted or deleted row cannot
  // redirect a write to the wrong SKU.
  let freshRows;
  try {
    freshRows = await readSheetRowsForPush(sheets);
  } catch (err) {
    return { ok: false, reason: 'sheet_unavailable', error: formatGoogleSheetsApiError(err, { spreadsheetId: getSheetId() }) };
  }

  const { safe, shifted } = verifyTargets(plan.updates, freshRows, shipment);
  if (safe.length === 0) {
    return {
      ok: false,
      reason: 'rows_moved',
      error: 'Sheet rows moved while pushing. Nothing was written — try again.',
      ...summarize(plan),
    };
  }

  const tab = escapeSheetName(getSheetName());
  const data = safe.map((update) => ({
    range: `'${tab}'!${QTY_COLUMN}${update.rowNumber}:${BOX_COLUMN}${update.rowNumber}`,
    values: [[update.qty, update.boxes]],
  }));

  try {
    await withRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: getSheetId(),
          requestBody: { valueInputOption: 'RAW', data },
        }),
      { retries: 2, delayMs: 1000, label: 'consignment sheet push write' }
    );
  } catch (err) {
    const status = getSheetsCredentialStatus();
    const message = formatGoogleSheetsApiError(err, {
      spreadsheetId: getSheetId(),
      clientEmail: status.sheetsClientEmail,
    });
    console.error('[ConsignmentSheetPush] Write failed:', message);
    return { ok: false, reason: 'write_failed', error: message, ...summarize(plan) };
  }

  // The read cache now holds pre-push values for these rows.
  invalidateConsignmentSheetCache();

  return {
    ok: true,
    updated: safe.length,
    skippedMovedRows: shifted.length,
    fingerprint,
    ...summarize(plan),
  };
}

function summarize(plan) {
  return {
    written: plan.written,
    cleared: plan.cleared,
    shipmentRowCount: plan.shipmentRowCount,
    unmatchedSkus: plan.unmatchedSkus,
    duplicateSheetRows: plan.duplicateSheetRows,
  };
}

module.exports = {
  QTY_COLUMN,
  BOX_COLUMN,
  formatBoxQtys,
  buildPushPlan,
  buildPushFingerprint,
  verifyTargets,
  readSheetRowsForPush,
  pushPackingToSheet,
};
