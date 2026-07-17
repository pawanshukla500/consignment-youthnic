/**
 * Automated consignment workflow: short pack, invoice gate, dispatch, inward archive, departments.
 */
const assert = require('assert');
const {
  applyStageConfirmation,
  canConfirmStage,
  enrichWorkflowFields,
  canArchiveConsignment,
  getPendingActionLabel,
} = require('../utils/consignmentWorkflow');
const {
  userCanConfirmStage,
  NEXT_ASSIGNMENT_DEPARTMENT,
  normalizeDepartment,
} = require('../utils/departments');

const baseUser = { id: 'u1', name: 'Packer', email: 'p@test.com', role: 'user', department: 'packing' };
const invoiceUser = { id: 'u2', name: 'Invoice', email: 'i@test.com', role: 'user', department: 'invoice' };
const dispatchUser = { id: 'u3', name: 'Dispatch', email: 'd@test.com', role: 'user', department: 'dispatch' };
const inwardUser = { id: 'u4', name: 'Inward', email: 'n@test.com', role: 'user', department: 'inward' };

function packingDoneShort() {
  return {
    id: 'C-SHORT',
    status: 'in_progress',
    shipmentStatus: 'Under Packing',
    totalRequiredQty: 1000,
    totalPackedQty: 800,
    stageConfirmations: {},
  };
}

// --- Department gates ---
assert.strictEqual(normalizeDepartment('Invoice Creation Team'), null);
assert.strictEqual(normalizeDepartment('invoice_team'), 'invoice');
assert.ok(userCanConfirmStage(baseUser, 'packing_completed'));
assert.ok(!userCanConfirmStage(baseUser, 'invoice_created'));
assert.ok(userCanConfirmStage(invoiceUser, 'invoice_created'));
assert.ok(userCanConfirmStage({ role: 'admin' }, 'dispatched'));

// --- Short packing blocked without reason ---
{
  const c = packingDoneShort();
  const blocked = canConfirmStage(c, 'packing_completed', {});
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.code, 'PACKING_INCOMPLETE');

  const noReason = canConfirmStage(c, 'packing_completed', { allowShortPack: true });
  assert.strictEqual(noReason.ok, false);
  assert.strictEqual(noReason.code, 'SHORT_REASON_REQUIRED');

  const ok = applyStageConfirmation(c, 'packing_completed', baseUser, null, {
    allowShortPack: true,
    shortReason: 'Stock shortage at warehouse',
    actualPackedQty: 800,
  });
  assert.ok(ok.ok);
  assert.strictEqual(ok.updates.packingCompletion.shortQty, 200);
  assert.strictEqual(ok.updates.packingCompletion.actualPackedQty, 800);
  assert.ok(ok.updates.stageConfirmations.ready_for_invoice.confirmedAt, 'auto ready_for_invoice');
  assert.strictEqual(ok.assignDepartment, 'invoice');
  assert.strictEqual(NEXT_ASSIGNMENT_DEPARTMENT.packing_completed, 'invoice');
}

// --- Invoice requires document ---
{
  let c = {
    ...packingDoneShort(),
    status: 'completed',
    stageConfirmations: {
      packing_completed: { confirmedAt: '2026-07-01T00:00:00.000Z' },
      ready_for_invoice: { confirmedAt: '2026-07-01T00:00:00.000Z' },
    },
  };
  assert.strictEqual(getPendingActionLabel(c), 'Upload invoice & mark invoice completed');

  const missingDoc = canConfirmStage(c, 'invoice_created', { invoiceNumber: 'INV-1' });
  assert.strictEqual(missingDoc.ok, false);
  assert.strictEqual(missingDoc.code, 'INVOICE_DOCUMENT_REQUIRED');

  const inv = applyStageConfirmation(c, 'invoice_created', invoiceUser, null, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-07-02',
    invoiceAmount: 1200,
    invoiceDocumentId: 'doc-inv-1',
  });
  assert.ok(inv.ok);
  assert.strictEqual(inv.updates.forwardInvoiceNo, 'INV-1');
  assert.ok(inv.updates.stageConfirmations.ready_for_dispatch.confirmedAt);
  assert.strictEqual(inv.updates.shipmentStatus, 'Ready');
  assert.strictEqual(inv.assignDepartment, 'dispatch');
  c = { ...c, ...inv.updates };
  assert.strictEqual(enrichWorkflowFields(c).listPriorityBucket, 'ready_for_dispatch');
}

// --- Dispatch requires docket + courier ---
{
  const c = {
    id: 'C-D',
    status: 'completed',
    shipmentStatus: 'Ready',
    totalPackedQty: 800,
    totalRequiredQty: 1000,
    stageConfirmations: {
      packing_completed: { confirmedAt: 't' },
      ready_for_invoice: { confirmedAt: 't' },
      invoice_created: { confirmedAt: 't' },
      ready_for_dispatch: { confirmedAt: 't' },
    },
  };
  assert.strictEqual(canConfirmStage(c, 'dispatched', {}).code, 'DOCKET_REQUIRED');
  assert.strictEqual(
    canConfirmStage(c, 'dispatched', { docketNo: 'DK-1' }).code,
    'COURIER_REQUIRED'
  );
  const d = applyStageConfirmation(c, 'dispatched', dispatchUser, null, {
    docketNo: 'DK-1',
    docketCompany: 'Delhivery',
    dispatchedQty: 800,
    boxCount: 10,
  });
  assert.ok(d.ok);
  assert.strictEqual(d.updates.shipmentStatus, 'In Transit');
  assert.strictEqual(d.assignDepartment, 'inward');
}

// --- Inward completes → archive ---
{
  const c = {
    id: 'C-I',
    status: 'completed',
    shipmentStatus: 'In Transit',
    totalPackedQty: 800,
    dispatchDetails: { dispatchedQty: 800 },
    stageConfirmations: {
      packing_completed: { confirmedAt: 't' },
      ready_for_invoice: { confirmedAt: 't' },
      invoice_created: { confirmedAt: 't' },
      ready_for_dispatch: { confirmedAt: 't' },
      dispatched: { confirmedAt: 't' },
    },
  };
  const mismatch = canConfirmStage(c, 'inward_completed', { inwardQty: 750 });
  assert.strictEqual(mismatch.code, 'INWARD_VARIANCE_REASON_REQUIRED');

  const done = applyStageConfirmation(c, 'inward_completed', inwardUser, null, {
    inwardQty: 800,
    inwardDate: '2026-07-10',
  });
  assert.ok(done.ok);
  assert.strictEqual(done.updates.operationalStatus, 'archived');
  assert.strictEqual(done.updates.isArchived, true);
  assert.strictEqual(enrichWorkflowFields({ ...c, ...done.updates }).listPriorityBucket, 'archived');
  assert.ok(canArchiveConsignment({ ...c, ...done.updates }).ok === false); // already archived
}

console.log('Workflow automation tests passed.');
