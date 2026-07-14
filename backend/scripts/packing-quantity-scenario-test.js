const assert = require('assert');
const { rebuildSessionSkuTotalsFromBoxes } = require('../utils/packingQuantities');

function canScan(session, skuId, qty = 1) {
  rebuildSessionSkuTotalsFromBoxes(session);
  const sku = session.skus.find((row) => row.id === skuId);
  if (!sku) return { ok: false, reason: 'not_found' };
  if (sku.packed + qty > sku.required) {
    return { ok: false, reason: 'over_limit', packed: sku.packed, required: sku.required, remaining: sku.remaining };
  }
  return { ok: true };
}

function scan(session, boxNo, skuId, qty) {
  const check = canScan(session, skuId, qty);
  assert.strictEqual(check.ok, true, `scan ${qty} in box ${boxNo} should be accepted`);
  const items = session.boxes[boxNo] || [];
  const existing = items.find((item) => item.skuId === skuId);
  if (existing) existing.qty += qty;
  else items.push({ skuId, qty, internalSku: 'SKU1' });
  session.boxes[boxNo] = items;
  rebuildSessionSkuTotalsFromBoxes(session);
}

const session = {
  skus: [{ id: 'sku-1', internalSku: 'SKU1', required: 10, packed: 0, remaining: 10, status: 'pending' }],
  boxes: {},
};

scan(session, '1', 'sku-1', 4);
assert.strictEqual(session.skus[0].packed, 4);
assert.strictEqual(session.skus[0].remaining, 6);

scan(session, '2', 'sku-1', 4);
assert.strictEqual(session.skus[0].packed, 8);
assert.strictEqual(session.skus[0].remaining, 2);

scan(session, '3', 'sku-1', 2);
assert.strictEqual(session.skus[0].packed, 10);
assert.strictEqual(session.skus[0].remaining, 0);
assert.strictEqual(session.skus[0].status, 'completed');

const rejected = canScan(session, 'sku-1', 1);
assert.deepStrictEqual(rejected, {
  ok: false,
  reason: 'over_limit',
  packed: 10,
  required: 10,
  remaining: 0,
});

console.log('Packing quantity scenario passed: 4 + 4 + 2 accepted; 11th unit rejected.');
