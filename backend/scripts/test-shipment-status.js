/**
 * M4 shipment status reduction tests.
 * Run: node scripts/test-shipment-status.js
 */
const assert = require('assert');
const {
  getSaveBoxUpdates,
  getQuantityReductionUpdates,
  getPackingFinishUpdates,
} = require('../utils/shipmentStatus');

const base = { status: 'completed', shipmentStatus: 'Ready' };

const incomplete = getQuantityReductionUpdates(base, false);
assert.ok(incomplete);
assert.strictEqual(incomplete.status, 'in_progress');
assert.strictEqual(incomplete.shipmentStatus, 'Under Packing');

const complete = getQuantityReductionUpdates({ status: 'in_progress', shipmentStatus: 'Under Packing' }, true);
assert.ok(complete);
assert.strictEqual(complete.status, 'completed');
assert.strictEqual(complete.shipmentStatus, 'Ready');

const saveComplete = getSaveBoxUpdates({ status: 'in_progress', shipmentStatus: 'Under Packing' }, true);
assert.strictEqual(saveComplete.status, 'completed');
assert.strictEqual(saveComplete.shipmentStatus, 'Ready');

const finishIncomplete = getPackingFinishUpdates({ status: 'completed', shipmentStatus: 'Ready' }, false);
assert.strictEqual(finishIncomplete.status, 'in_progress');
assert.strictEqual(finishIncomplete.shipmentStatus, 'Under Packing');

console.log('M4 shipment status tests passed.');
