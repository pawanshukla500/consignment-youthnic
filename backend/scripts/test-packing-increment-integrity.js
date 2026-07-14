/**
 * H2/H3 packing increment integrity tests (pure logic + helper contracts).
 * Run: node scripts/test-packing-increment-integrity.js
 */
const assert = require('assert');
const { rebuildSessionSkuTotalsFromBoxes } = require('../utils/packingQuantities');

// Simulate: live scans update session only; authoritative totals come from saved boxes.
function authoritativePackedFromSavedBoxes(savedBoxes) {
  const totals = {};
  for (const box of savedBoxes) {
    for (const item of box.items || []) {
      const id = item.skuId;
      totals[id] = (totals[id] || 0) + (Number(item.qty) || 0);
    }
  }
  return totals;
}

const session = {
  skus: [{ id: 'sku-1', internalSku: 'SKU1', required: 10, packed: 0, remaining: 10, status: 'pending' }],
  boxes: {},
};

// Live scan into unsaved box
session.boxes['1'] = [{ skuId: 'sku-1', qty: 3 }];
rebuildSessionSkuTotalsFromBoxes(session);
assert.strictEqual(session.skus[0].packed, 3, 'session live packed');

// Authoritative DB totals still empty until save-box
const authBeforeSave = authoritativePackedFromSavedBoxes([]);
assert.strictEqual(authBeforeSave['sku-1'] || 0, 0, 'authoritative packed before save must be 0');

// After save-box, authoritative matches saved boxes only
const saved = [{ items: [{ skuId: 'sku-1', qty: 3 }] }];
const authAfterSave = authoritativePackedFromSavedBoxes(saved);
assert.strictEqual(authAfterSave['sku-1'], 3);

// Abandon unsaved box: session may still show 3, but DB authoritative stays 0
assert.strictEqual(authoritativePackedFromSavedBoxes([])['sku-1'] || 0, 0);

// Duplicate scan_id cache behavior
const processed = new Set();
function acceptScan(scanId) {
  if (processed.has(scanId)) return { duplicate: true };
  processed.add(scanId);
  return { duplicate: false };
}
assert.deepStrictEqual(acceptScan('s1'), { duplicate: false });
assert.deepStrictEqual(acceptScan('s1'), { duplicate: true });

console.log('H2/H3 packing increment integrity tests passed.');
