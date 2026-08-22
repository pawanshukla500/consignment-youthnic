/**
 * Box document integrity tests.
 * Run: node scripts/test-box-document-integrity.js
 *
 * Covers two defects found while investigating a consignment that showed
 * saved boxes on the detail tab but 0 boxes / 0 packed on the packing report:
 *
 *  1. A box number must never be derived from the box document id. Doing so
 *     turned a malformed box document into a box called "ABC_box_1", which the
 *     packing report displayed and the Google Sheet push would have written
 *     into the Box number column.
 *  2. A box document written by the video path must carry consignmentId and
 *     boxNo, otherwise it is invisible to the consignmentId lookup and the
 *     documents→boxes sync trigger rejects it (boxes.consignment_id is NOT NULL
 *     and a foreign key, so its 'UNKNOWN' fallback aborts the whole write).
 */
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { buildPackingReport } = require('../routes/consignments');
const { buildVideoBoxDocument, buildBoxId } = require('../utils/boxDocuments');

const consignment = { id: 'TEST12345', internalShipmentNo: 'TEST12345', totalRequiredQty: 30, totalPackedQty: 25 };
const skus = [
  { id: 'sku-1', marketplaceBarcode: 'X001', internalSku: 'A_2XL', requiredQty: 10, packedQty: 10, status: 'completed' },
  { id: 'sku-2', marketplaceBarcode: 'X002', internalSku: 'B_2XL', requiredQty: 20, packedQty: 15, status: 'pending' },
];

// A well-formed box, and a malformed one of the shape the video path used to create.
const goodBox = {
  id: 'TEST12345_box_1',
  consignmentId: 'TEST12345',
  boxNo: '1',
  items: [{ skuId: 'sku-1', qty: 10 }, { skuId: 'sku-2', qty: 15 }],
};
const malformedBox = {
  id: 'TEST12345_box_2',
  videoStatus: 'metadata_saved',
  videoId: 'vid-2',
  // no consignmentId, no boxNo, no items
};

const report = buildPackingReport(consignment, skus, [goodBox, malformedBox], []);

// ── The malformed box is excluded, not renamed after its document id ────────
assert.strictEqual(report.summary.boxCount, 1, 'only the well-formed box is counted');
assert.deepStrictEqual(report.boxes.map((b) => b.boxNo), ['1']);
assert.ok(
  !report.boxes.some((b) => b.boxNo.includes('_box_')),
  'a document id must never surface as a box number'
);

const flagged = report.integrityIssues.filter((i) => i.type === 'box_missing_number');
assert.strictEqual(flagged.length, 1, 'the malformed box is reported, not silently dropped');
assert.strictEqual(flagged[0].boxId, 'TEST12345_box_2');

// ── Real packing data still reports correctly ───────────────────────────────
assert.strictEqual(report.summary.totalPacked, 25);
assert.strictEqual(report.summary.totalRequired, 30);
const row1 = report.rows.find((r) => r.marketplaceBarcode === 'X001');
assert.deepStrictEqual(row1.boxQtys, { 1: 10 }, 'box quantities are keyed by the real box number');

// ── A box with a number but no items is a real, empty box: keep counting it ──
const emptyBoxReport = buildPackingReport(
  consignment,
  skus,
  [{ id: 'TEST12345_box_3', consignmentId: 'TEST12345', boxNo: '3', items: [] }],
  []
);
assert.strictEqual(emptyBoxReport.summary.boxCount, 1, 'an empty but numbered box still counts');
assert.strictEqual(emptyBoxReport.summary.totalPacked, 0);

// ── The video path must write consignmentId and boxNo on the box document ───
const videoBox = buildVideoBoxDocument({
  consignmentId: 'TEST12345',
  boxNo: 4,
  videoId: 'vid-4',
  at: '2026-08-22T10:00:00.000Z',
});
assert.strictEqual(videoBox.consignmentId, 'TEST12345', 'video box writes carry the consignment id');
assert.strictEqual(videoBox.boxNo, '4', 'video box writes carry the box number, as a string');
assert.strictEqual(videoBox.videoStatus, 'metadata_saved');
assert.strictEqual(videoBox.videoId, 'vid-4');
assert.strictEqual(buildBoxId('TEST12345', 4), 'TEST12345_box_4');

// The payload must survive the report path: a box built this way, once its
// contents are saved, is well-formed enough to be counted.
const videoBoxReport = buildPackingReport(
  consignment,
  skus,
  [{ id: buildBoxId('TEST12345', 4), ...videoBox, items: [] }],
  []
);
assert.strictEqual(videoBoxReport.summary.boxCount, 1, 'a video-created box is a countable box');
assert.deepStrictEqual(videoBoxReport.boxes.map((b) => b.boxNo), ['4']);
assert.strictEqual(
  videoBoxReport.integrityIssues.filter((i) => i.type === 'box_missing_number').length,
  0,
  'a video-created box is never flagged as malformed'
);

console.log('✅ box document integrity tests passed');
