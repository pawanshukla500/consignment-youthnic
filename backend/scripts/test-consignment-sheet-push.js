/**
 * Consignment Master sheet push tests.
 * Run: node scripts/test-consignment-sheet-push.js
 *
 * Verifies the I/J cell format against real rows from a production shipment,
 * plus row matching, clearing, row-shift protection, and the failure contract.
 * The Google Sheets client is stubbed, so this runs offline.
 */
const assert = require('assert');

const sheetsInventoryPath = require.resolve('../utils/googleSheetsInventory');
const realInventory = require('../utils/googleSheetsInventory');

let batchGetImpl = null;
let batchUpdateImpl = null;
const writes = [];

require.cache[sheetsInventoryPath].exports = {
  ...realInventory,
  getSheetsClient: async () => {
    if (!batchGetImpl) throw new Error('Sheets unavailable (stub)');
    return {
      spreadsheets: {
        values: {
          batchGet: async (args) => batchGetImpl(args),
          batchUpdate: async (args) => {
            writes.push(args);
            return batchUpdateImpl ? batchUpdateImpl(args) : { data: {} };
          },
        },
      },
    };
  },
};

const {
  formatBoxQtys,
  buildPushPlan,
  buildPushFingerprint,
  verifyTargets,
  pushPackingToSheet,
  QTY_COLUMN,
  BOX_COLUMN,
} = require('../utils/consignmentSheetPush');

const SHIPMENT = 'JULY-K1-B4';

const run = async () => {
  // ── Cell format, checked against real rows of shipment JULY-K1-B4 ─────────
  // Sheet row 35: I = "42,8,10,7", J = "10,11,12,20"
  assert.deepStrictEqual(
    formatBoxQtys({ 11: 8, 20: 7, 10: 42, 12: 10 }),
    { qty: '42,8,10,7', boxes: '10,11,12,20' },
    'quantities follow ascending box order, comma-joined without spaces'
  );
  // Sheet row 5: I = "9,8", J = "2,3"
  assert.deepStrictEqual(formatBoxQtys({ 2: 9, 3: 8 }), { qty: '9,8', boxes: '2,3' });
  // Sheet row 22: I = "50,10,51", J = "7,8,18"  (18 must sort after 8, not before)
  assert.deepStrictEqual(
    formatBoxQtys({ 8: 10, 18: 51, 7: 50 }),
    { qty: '50,10,51', boxes: '7,8,18' },
    'box numbers sort numerically, not lexically'
  );
  // Single box, and nothing packed
  assert.deepStrictEqual(formatBoxQtys({ 13: 56 }), { qty: '56', boxes: '13' });
  assert.deepStrictEqual(formatBoxQtys({}), { qty: '', boxes: '' }, 'unpacked SKU clears both cells');
  assert.deepStrictEqual(formatBoxQtys({ 4: 0, 5: -2 }), { qty: '', boxes: '' }, 'zero/negative are dropped');

  // ── Plan building ────────────────────────────────────────────────────────
  const sheetRows = [
    { rowNumber: 2, marketplaceBarcode: 'KALNKASS66148880', internalShipmentNo: SHIPMENT },
    { rowNumber: 3, marketplaceBarcode: 'KALNKASS71056842', internalShipmentNo: SHIPMENT },
    { rowNumber: 4, marketplaceBarcode: 'KALNKASS74790192', internalShipmentNo: SHIPMENT },
    { rowNumber: 5, marketplaceBarcode: 'OTHER-SHIPMENT-SKU', internalShipmentNo: 'JULY-K1-B9' },
  ];
  const reportRows = [
    { marketplaceBarcode: 'KALNKASS71056842', boxQtys: { 2: 21 } },
    { marketplaceBarcode: 'kalnkass74790192', boxQtys: { 1: 11 } },   // case-insensitive match
    { marketplaceBarcode: 'KALNKASS66148880', boxQtys: {} },          // nothing packed → clear
    { marketplaceBarcode: 'NOT-IN-SHEET', internalSku: 'X_2XL', boxQtys: { 1: 5 } },
  ];

  const plan = buildPushPlan({ internalShipmentNo: SHIPMENT, reportRows, sheetRows });
  assert.strictEqual(plan.updates.length, 3);
  assert.strictEqual(plan.written, 2);
  assert.strictEqual(plan.cleared, 1, 'a SKU with no boxes is counted as cleared');
  assert.strictEqual(plan.shipmentRowCount, 3, "only this shipment's rows are considered");
  assert.deepStrictEqual(plan.updates.map((u) => u.rowNumber), [2, 3, 4], 'updates are row-ordered');
  assert.deepStrictEqual(plan.updates[0], { rowNumber: 2, marketplaceBarcode: 'KALNKASS66148880', qty: '', boxes: '' });
  assert.deepStrictEqual(plan.updates[1], { rowNumber: 3, marketplaceBarcode: 'KALNKASS71056842', qty: '21', boxes: '2' });
  assert.strictEqual(plan.unmatchedSkus.length, 1);
  assert.strictEqual(plan.unmatchedSkus[0].marketplaceBarcode, 'NOT-IN-SHEET');
  assert.strictEqual(plan.unmatchedSkus[0].reason, 'no_sheet_row');
  assert.ok(
    !plan.updates.some((u) => u.marketplaceBarcode === 'OTHER-SHIPMENT-SKU'),
    "another shipment's rows are never written"
  );

  // ── A barcode duplicated within one shipment is ambiguous: skip + report ──
  const dupPlan = buildPushPlan({
    internalShipmentNo: SHIPMENT,
    reportRows: [{ marketplaceBarcode: 'DUP', boxQtys: { 1: 5 } }],
    sheetRows: [
      { rowNumber: 2, marketplaceBarcode: 'DUP', internalShipmentNo: SHIPMENT },
      { rowNumber: 9, marketplaceBarcode: 'DUP', internalShipmentNo: SHIPMENT },
    ],
  });
  assert.strictEqual(dupPlan.updates.length, 0, 'ambiguous duplicates are never written');
  assert.strictEqual(dupPlan.duplicateSheetRows.length, 1);
  assert.strictEqual(dupPlan.unmatchedSkus[0].reason, 'duplicate_sheet_row');

  // ── Fingerprint changes only when written values change ──────────────────
  const fpA = buildPushFingerprint(plan.updates);
  assert.strictEqual(fpA, buildPushFingerprint(plan.updates), 'fingerprint is stable');
  const moved = buildPushPlan({
    internalShipmentNo: SHIPMENT,
    reportRows: [{ marketplaceBarcode: 'KALNKASS71056842', boxQtys: { 3: 21 } }],
    sheetRows,
  });
  assert.notStrictEqual(fpA, buildPushFingerprint(moved.updates), 'a box change changes the fingerprint');

  // ── Row-shift protection ─────────────────────────────────────────────────
  const shiftedRows = [
    { rowNumber: 2, marketplaceBarcode: 'KALNKASS66148880', internalShipmentNo: SHIPMENT },
    { rowNumber: 3, marketplaceBarcode: 'SOMETHING-ELSE', internalShipmentNo: SHIPMENT }, // row inserted
    { rowNumber: 4, marketplaceBarcode: 'KALNKASS74790192', internalShipmentNo: SHIPMENT },
  ];
  const verified = verifyTargets(plan.updates, shiftedRows, SHIPMENT);
  assert.strictEqual(verified.safe.length, 2, 'rows whose barcode still matches are written');
  assert.strictEqual(verified.shifted.length, 1, 'the moved row is skipped, not overwritten');
  assert.ok(!verified.safe.some((u) => u.rowNumber === 3));

  // ── End-to-end push against a stubbed sheet ──────────────────────────────
  const liveRows = () => ({
    data: {
      valueRanges: [
        { values: [[''], ['KALNKASS66148880'], ['KALNKASS71056842'], ['KALNKASS74790192']] },
        { values: [[''], [SHIPMENT], [SHIPMENT], [SHIPMENT]] },
      ],
    },
  });
  batchGetImpl = async () => liveRows();
  writes.length = 0;

  const result = await pushPackingToSheet({ internalShipmentNo: SHIPMENT, reportRows });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updated, 3);
  assert.strictEqual(result.cleared, 1);
  assert.strictEqual(result.unmatchedSkus.length, 1);
  assert.strictEqual(writes.length, 1, 'all rows go out in a single batchUpdate');

  const data = writes[0].requestBody.data;
  assert.strictEqual(writes[0].requestBody.valueInputOption, 'RAW', 'values are written literally');
  assert.strictEqual(data.length, 3);
  for (const entry of data) {
    assert.ok(
      new RegExp(`!${QTY_COLUMN}\\d+:${BOX_COLUMN}\\d+$`).test(entry.range),
      `writes only columns ${QTY_COLUMN}:${BOX_COLUMN}, got ${entry.range}`
    );
    assert.strictEqual(entry.values[0].length, 2);
  }
  const row3 = data.find((d) => d.range.endsWith(`${QTY_COLUMN}3:${BOX_COLUMN}3`));
  assert.deepStrictEqual(row3.values, [['21', '2']]);
  const row2 = data.find((d) => d.range.endsWith(`${QTY_COLUMN}2:${BOX_COLUMN}2`));
  assert.deepStrictEqual(row2.values, [['', '']], 'unpacked SKU blanks both cells');

  // ── Dry run writes nothing ───────────────────────────────────────────────
  writes.length = 0;
  const dry = await pushPackingToSheet({ internalShipmentNo: SHIPMENT, reportRows, dryRun: true });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(writes.length, 0, 'dry run never writes');

  // ── Shipment absent from the sheet ───────────────────────────────────────
  writes.length = 0;
  const absent = await pushPackingToSheet({ internalShipmentNo: 'NO-SUCH-SHIPMENT', reportRows });
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.reason, 'shipment_not_in_sheet');
  assert.strictEqual(writes.length, 0);

  // ── Rows moved between read and write: abort rather than corrupt ─────────
  let call = 0;
  batchGetImpl = async () => {
    call++;
    if (call === 1) return liveRows();
    // Second read (the pre-write verification) shows different barcodes
    return {
      data: {
        valueRanges: [
          { values: [[''], ['MOVED-1'], ['MOVED-2'], ['MOVED-3']] },
          { values: [[''], [SHIPMENT], [SHIPMENT], [SHIPMENT]] },
        ],
      },
    };
  };
  writes.length = 0;
  const movedResult = await pushPackingToSheet({ internalShipmentNo: SHIPMENT, reportRows });
  assert.strictEqual(movedResult.ok, false);
  assert.strictEqual(movedResult.reason, 'rows_moved');
  assert.strictEqual(writes.length, 0, 'nothing is written when every target row moved');

  // ── Missing shipment number, and an unreachable sheet ────────────────────
  const noShipment = await pushPackingToSheet({ internalShipmentNo: '  ', reportRows });
  assert.strictEqual(noShipment.ok, false);
  assert.strictEqual(noShipment.reason, 'missing_shipment_no');

  batchGetImpl = null;
  const down = await pushPackingToSheet({ internalShipmentNo: SHIPMENT, reportRows });
  assert.strictEqual(down.ok, false);
  assert.strictEqual(down.reason, 'sheet_unavailable');
  assert.ok(down.error);

  console.log('✅ consignment sheet push tests passed');
};

run().catch((err) => {
  console.error('❌ consignment sheet push tests failed:', err.message);
  process.exit(1);
});
