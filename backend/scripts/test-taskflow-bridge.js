/**
 * Offline unit checks for TaskFlow bridge mapping (no network).
 * Run: node backend/scripts/test-taskflow-bridge.js
 */
const assert = require('assert');
const {
  EVENT_TO_TARGET_POSITION,
  targetPositionForEvent,
  maxTargetFromStages,
  getTaskflowStatus,
} = require('../utils/taskflowBridge');

function run() {
  assert.strictEqual(targetPositionForEvent('created'), 1);
  assert.strictEqual(targetPositionForEvent('packing_completed'), 2);
  assert.strictEqual(targetPositionForEvent('ready_for_invoice'), 2);
  assert.strictEqual(targetPositionForEvent('invoice_created'), 3);
  assert.strictEqual(targetPositionForEvent('ready_for_dispatch'), 3);
  assert.strictEqual(targetPositionForEvent('dispatched'), 4);
  assert.strictEqual(targetPositionForEvent('inward_completed'), 5);
  assert.strictEqual(targetPositionForEvent('unknown'), null);

  assert.strictEqual(maxTargetFromStages(['packing_completed', 'ready_for_invoice']), 2);
  assert.strictEqual(maxTargetFromStages(['invoice_created', 'ready_for_dispatch']), 3);
  assert.strictEqual(maxTargetFromStages(['packing_completed', 'dispatched']), 4);
  assert.strictEqual(maxTargetFromStages(['inward_completed']), 5);
  assert.strictEqual(maxTargetFromStages([]), null);

  assert.ok(EVENT_TO_TARGET_POSITION.created === 1);
  const status = getTaskflowStatus();
  assert.strictEqual(typeof status.enabled, 'boolean');
  assert.strictEqual(typeof status.configured, 'boolean');
  assert.ok(status.eventMap.dispatched === 4);

  console.log('OK: TaskFlow bridge mapping tests passed');
}

run();
