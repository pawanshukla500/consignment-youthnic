/**
 * Quick checks for consignment workflow pending-action labels.
 */
const assert = require('assert');
const {
  enrichWorkflowFields,
  getPendingActionLabel,
  canConfirmStage,
} = require('../utils/consignmentWorkflow');

{
  const c = {
    id: 'NEW-1',
    status: 'pending',
    shipmentStatus: 'Planned',
    totalPackedQty: 0,
    totalRequiredQty: 1898,
    stageConfirmations: {},
  };
  const enriched = enrichWorkflowFields(c);
  assert.strictEqual(enriched.pendingAction, 'Packing not started');
  assert.strictEqual(enriched.listPriorityBucket, 'new');
  assert.strictEqual(enriched.currentWorkflowStage, 'packing_completed');
  assert.ok(canConfirmStage(c, 'packing_completed').ok === false);
}

{
  const c = {
    status: 'in_progress',
    shipmentStatus: 'Under Packing',
    totalPackedQty: 40,
    totalRequiredQty: 100,
    stageConfirmations: {},
  };
  assert.strictEqual(getPendingActionLabel(c), 'Finish packing');
  assert.strictEqual(enrichWorkflowFields(c).listPriorityBucket, 'active');
}

{
  const c = {
    status: 'completed',
    shipmentStatus: 'Under Packing',
    totalPackedQty: 100,
    totalRequiredQty: 100,
    stageConfirmations: {},
  };
  assert.strictEqual(getPendingActionLabel(c), 'Confirm packing completed');
  assert.ok(canConfirmStage(c, 'packing_completed').ok);
}

{
  const c = {
    status: 'completed',
    shipmentStatus: 'Ready',
    totalPackedQty: 100,
    totalRequiredQty: 100,
    stageConfirmations: {
      packing_completed: { confirmedAt: '2026-07-01T00:00:00.000Z' },
    },
  };
  assert.strictEqual(getPendingActionLabel(c), 'Ready for invoice creation');
}

{
  const c = {
    status: 'pending',
    totalPackedQty: 0,
    totalRequiredQty: 162,
  };
  // Must never claim packing is completed when nothing is packed
  assert.notStrictEqual(enrichWorkflowFields(c).pendingAction, 'Packing completed');
}

console.log('Workflow pending-action tests passed.');
