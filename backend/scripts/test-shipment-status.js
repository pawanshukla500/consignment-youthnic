/**
 * Shipment status reduction tests (ground-team confirmation workflow).
 * Run: node scripts/test-shipment-status.js
 *
 * Ready is NOT auto-set when packing qty completes — ground team must confirm
 * packing_completed then ready_for_dispatch before Ready logistics.
 */
const assert = require('assert');
const {
  getSaveBoxUpdates,
  getQuantityReductionUpdates,
  getPackingFinishUpdates,
  getPackingLoadUpdates,
} = require('../utils/shipmentStatus');

const incomplete = getQuantityReductionUpdates(
  { status: 'completed', shipmentStatus: 'Ready' },
  false
);
assert.ok(incomplete);
assert.strictEqual(incomplete.status, 'in_progress');
assert.strictEqual(incomplete.shipmentStatus, 'Under Packing');

const complete = getQuantityReductionUpdates(
  { status: 'in_progress', shipmentStatus: 'Under Packing' },
  true
);
assert.ok(complete);
assert.strictEqual(complete.status, 'completed');
// Packing qty complete must NOT jump to Ready without workflow confirmation
assert.strictEqual(complete.shipmentStatus, 'Under Packing');

const saveComplete = getSaveBoxUpdates(
  { status: 'in_progress', shipmentStatus: 'Under Packing' },
  true
);
assert.strictEqual(saveComplete.status, 'completed');
assert.ok(
  saveComplete.shipmentStatus == null || saveComplete.shipmentStatus === 'Under Packing',
  'save-box complete must not auto-set Ready'
);

const finishIncomplete = getPackingFinishUpdates(
  { status: 'completed', shipmentStatus: 'Ready' },
  false
);
assert.strictEqual(finishIncomplete.status, 'in_progress');
assert.strictEqual(finishIncomplete.shipmentStatus, 'Under Packing');

const load = getPackingLoadUpdates({ status: 'pending', shipmentStatus: 'Planned' });
assert.strictEqual(load.status, 'in_progress');
assert.strictEqual(load.shipmentStatus, 'Under Packing');

// With ready_for_dispatch confirmed, quantity-complete may leave Ready alone
const readyConfirmed = getQuantityReductionUpdates(
  {
    status: 'in_progress',
    shipmentStatus: 'Ready',
    stageConfirmations: {
      ready_for_dispatch: { confirmedAt: '2026-07-01T00:00:00.000Z' },
    },
  },
  true
);
assert.strictEqual(readyConfirmed.status, 'completed');
assert.ok(
  readyConfirmed.shipmentStatus == null || readyConfirmed.shipmentStatus === 'Ready',
  'confirmed ready_for_dispatch consignments can remain Ready'
);

console.log('M4 shipment status tests passed.');
