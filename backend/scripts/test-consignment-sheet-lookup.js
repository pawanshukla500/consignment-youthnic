/**
 * Consignment Master sheet lookup tests.
 * Run: node scripts/test-consignment-sheet-lookup.js
 *
 * Covers the pure parser (fixed columns B/C/D/F + M), shipment matching,
 * duplicate merging, and the soft-failure contract the Create Consignment
 * modal depends on. The Google Sheets client is stubbed, so this runs offline.
 */
const assert = require('assert');
const Module = require('module');

// Stub the Sheets client before consignmentSheet.js resolves it.
const sheetsInventoryPath = require.resolve('../utils/googleSheetsInventory');
const realInventory = require('../utils/googleSheetsInventory');

let stubbedBatchGet = null;
let batchGetCalls = 0;

require.cache[sheetsInventoryPath].exports = {
  ...realInventory,
  getSheetsClient: async () => {
    if (!stubbedBatchGet) throw new Error('Sheets unavailable (stub)');
    return {
      spreadsheets: {
        values: {
          batchGet: async (args) => {
            batchGetCalls++;
            return stubbedBatchGet(args);
          },
        },
      },
    };
  },
};

const {
  parseConsignmentSheetValues,
  buildSkuItems,
  normalizeShipmentKey,
  lookupShipmentSkus,
  invalidateConsignmentSheetCache,
  getSheetId,
  getSheetName,
  DEFAULT_SHEET_ID,
  DEFAULT_SHEET_NAME,
} = require('../utils/consignmentSheet');

const run = async () => {
  // ── Fixed source ─────────────────────────────────────────────────────────
  assert.strictEqual(getSheetId(), DEFAULT_SHEET_ID, 'spreadsheet id must default to the fixed sheet');
  assert.strictEqual(getSheetName(), DEFAULT_SHEET_NAME, 'tab must default to Consignment_Master');

  // ── Match key normalization ──────────────────────────────────────────────
  assert.strictEqual(normalizeShipmentKey('  ABC123 '), 'abc123');
  assert.strictEqual(normalizeShipmentKey('abc  123'), 'abc 123');
  assert.strictEqual(normalizeShipmentKey(null), '');

  // ── Parser: columns B,C,D,F from the B:F range; M from the M:M range ──────
  const skuRange = [
    ['Marketplace Barcode', 'Marketplace SKU', 'OMS SKU', 'ignored E', 'Qty'], // header row
    ['X0011', 'MP-1', 'OMS-1', 'e', '10'],
    ['X0022', 'MP-2', 'OMS-2', 'e', '1,200'],
    ['X0011', 'MP-1', 'OMS-1', 'e', '3'],   // duplicate barcode, same shipment
    ['', 'MP-3', 'OMS-3', 'e', '5'],        // no barcode → skipped
    ['X0044', 'MP-4', 'OMS-4', 'e', 'abc'], // unparseable qty → 0
    ['X0055', '', 'OMS-5', 'e', '7'],       // blank marketplace SKU → barcode
    ['X0066', 'MP-6', 'OMS-6', 'e', '9'],   // belongs to another shipment
  ];
  const shipmentRange = [
    ['Internal Shipment No.'],
    ['ABC123'],
    ['ABC123'],
    ['abc123 '],   // case/space variant of the same shipment
    ['ABC123'],
    ['ABC123'],
    ['ABC123'],
    ['ZZZ999'],
  ];

  const rows = parseConsignmentSheetValues(skuRange, shipmentRange);
  // 8 sheet rows − 1 without a barcode. The header row survives parsing and is
  // filtered out by matching instead, which is what keeps the parser
  // independent of the sheet's header text.
  assert.strictEqual(rows.length, 7, 'rows without a barcode are dropped');

  const first = rows.find((r) => r.marketplaceBarcode === 'X0011' && r.requiredQty === 10);
  assert.ok(first, 'first data row parsed');
  assert.strictEqual(first.internalShipmentNo, 'ABC123');
  assert.strictEqual(first.marketplaceSku, 'MP-1');
  assert.strictEqual(first.internalSku, 'OMS-1');
  assert.strictEqual(first.rowNumber, 2, 'row numbers are 1-based sheet rows');

  const thousands = rows.find((r) => r.marketplaceBarcode === 'X0022');
  assert.strictEqual(thousands.requiredQty, 1200, 'comma-formatted quantities parse');

  const badQty = rows.find((r) => r.marketplaceBarcode === 'X0044');
  assert.strictEqual(badQty.requiredQty, 0, 'unparseable quantity falls back to 0');

  const noMpSku = rows.find((r) => r.marketplaceBarcode === 'X0055');
  assert.strictEqual(noMpSku.marketplaceSku, 'X0055', 'blank marketplace SKU falls back to the barcode');

  // ── Ragged rows must not throw ───────────────────────────────────────────
  const ragged = parseConsignmentSheetValues([['X1'], ['X2', 'MP']], [['S1'], ['S1']]);
  assert.strictEqual(ragged.length, 2);
  assert.strictEqual(ragged[0].internalSku, '');
  assert.strictEqual(ragged[0].requiredQty, 0);

  // ── Merge: duplicate barcodes inside one shipment sum their quantities ────
  const matched = rows.filter((r) => r.shipmentKey === 'abc123');
  const skus = buildSkuItems(matched);
  assert.strictEqual(skus.length, 4, 'duplicate barcodes collapse into one row');
  const merged = skus.find((s) => s.marketplaceBarcode === 'X0011');
  assert.strictEqual(merged.requiredQty, '13', '10 + 3 are summed');
  assert.strictEqual(merged.marketplaceBarcodeType, '', 'type is inferred later from the marketplace');
  assert.ok(skus.every((s) => typeof s.requiredQty === 'string'), 'form inputs expect string quantities');
  assert.ok(!skus.some((s) => s.marketplaceBarcode === 'X0066'), 'other shipments never leak in');
  assert.ok(!('mergedRows' in merged), 'internal merge bookkeeping is not exposed');

  // ── Lookup over a stubbed sheet ──────────────────────────────────────────
  stubbedBatchGet = async ({ ranges }) => {
    assert.deepStrictEqual(
      ranges,
      [`'${DEFAULT_SHEET_NAME}'!B:F`, `'${DEFAULT_SHEET_NAME}'!M:M`],
      'reads exactly the two configured ranges'
    );
    return { data: { valueRanges: [{ values: skuRange }, { values: shipmentRange }] } };
  };
  invalidateConsignmentSheetCache();
  batchGetCalls = 0;

  const found = await lookupShipmentSkus('  abc123  ');
  assert.strictEqual(found.found, true);
  assert.strictEqual(found.skus.length, 4);
  assert.strictEqual(found.rowCount, 5, 'rowCount reports matched sheet rows before merging');
  assert.strictEqual(found.internalShipmentNo, 'ABC123', 'echoes the sheet spelling');

  // ── Cache: a second lookup must not re-hit the API ───────────────────────
  const cached = await lookupShipmentSkus('ZZZ999');
  assert.strictEqual(cached.found, true);
  assert.strictEqual(cached.skus.length, 1);
  assert.strictEqual(cached.cached, true);
  assert.strictEqual(batchGetCalls, 1, 'whole-tab cache serves repeat lookups');

  // refresh:true bypasses the cache
  await lookupShipmentSkus('ABC123', { force: true });
  assert.strictEqual(batchGetCalls, 2, 'force refresh re-reads the sheet');

  // ── Unknown shipment: soft miss, never an error ──────────────────────────
  const missing = await lookupShipmentSkus('NOPE-404');
  assert.strictEqual(missing.found, false);
  assert.strictEqual(missing.reason, 'not_found');
  assert.deepStrictEqual(missing.skus, []);
  assert.ok(!missing.error, 'a plain miss is not an error');

  // A header row is never returned for a real shipment number, which is why the
  // parser needs no header detection and tolerates the sheet's other columns
  // being renamed or reordered.
  assert.ok(
    !found.skus.some((s) => s.marketplaceBarcode === 'Marketplace Barcode'),
    'header row never leaks into a shipment match'
  );

  // ── Empty query ──────────────────────────────────────────────────────────
  const empty = await lookupShipmentSkus('   ');
  assert.strictEqual(empty.found, false);
  assert.strictEqual(empty.reason, 'empty_query');

  // ── Sheet down: degrades to manual entry instead of throwing ─────────────
  stubbedBatchGet = null;
  invalidateConsignmentSheetCache();
  const broken = await lookupShipmentSkus('ABC123');
  assert.strictEqual(broken.found, false);
  assert.strictEqual(broken.reason, 'sheet_unavailable');
  assert.ok(broken.error, 'unavailable sheet reports a message the UI can show');
  assert.deepStrictEqual(broken.skus, []);

  console.log('✅ consignment sheet lookup tests passed');
};

run().catch((err) => {
  console.error('❌ consignment sheet lookup tests failed:', err.message);
  process.exit(1);
});
