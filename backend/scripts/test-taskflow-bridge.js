/**
 * Offline unit checks for TaskFlow bridge mapping + description builders.
 * Run: node backend/scripts/test-taskflow-bridge.js
 */
const assert = require('assert');
const {
  EVENT_TO_TARGET_POSITION,
  targetPositionForEvent,
  maxTargetFromStages,
  getTaskflowStatus,
  buildWorkflowDescription,
  buildStageNote,
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
  assert.ok(Array.isArray(status.positionDepartments[4]));

  const sample = {
    id: 'CNS-1',
    internalShipmentNo: 'CNS-1',
    totalRequiredQty: 372,
    totalPackedQty: 309,
    packingCompletion: {
      plannedQty: 372,
      actualPackedQty: 309,
      shortQty: 63,
      shortReason: 'short stock',
      completedByName: 'Pawan Shukla',
    },
    stageConfirmations: {
      packing_completed: { confirmedAt: '2026-07-17T19:24:53.000Z', confirmedByName: 'Pawan Shukla' },
      ready_for_invoice: { confirmedAt: '2026-07-17T19:24:53.000Z', confirmedByName: 'System' },
      invoice_created: {
        confirmedAt: '2026-07-20T15:24:58.000Z',
        confirmedByName: 'Aditya Shah',
        details: { invoiceNumber: 'FKSOR/26-27/001' },
      },
      ready_for_dispatch: { confirmedAt: '2026-07-20T15:24:58.000Z', confirmedByName: 'System' },
      dispatched: {
        confirmedAt: '2026-07-28T10:00:00.000Z',
        confirmedByName: 'Chandan Yadav',
        details: { docketNo: 'DKT-9', docketCompany: 'Delhivery' },
      },
      inward_completed: {
        confirmedAt: '2026-07-29T10:00:00.000Z',
        confirmedByName: 'Aditya Shah',
        details: { inwardQty: 309 },
      },
    },
    invoice: { number: 'FKSOR/26-27/001', amount: 12000, date: '2026-07-20' },
    forwardInvoiceNo: 'FKSOR/26-27/001',
    docketNo: 'DKT-9',
    docketCompany: 'Delhivery',
    dispatchDetails: { dispatchedQty: 309, boxCount: 6, docketNo: 'DKT-9', docketCompany: 'Delhivery' },
    unitsInwarded: 309,
    inwardDetails: { receivedQty: 309, inwardDate: '2026-07-29' },
    groundTeamName: 'Chandan Yadav',
    groundTeamEmail: 'dispatches@vbexports.co.in',
  };

  const desc = buildWorkflowDescription(sample);
  assert.ok(desc.includes('Auto-triggered from Consignment Packing'));
  assert.ok(desc.includes('packed qty 309'));
  assert.ok(desc.includes('invoice no FKSOR/26-27/001'));
  assert.ok(desc.includes('docket company Delhivery'));
  assert.ok(desc.includes('docket id DKT-9'));
  assert.ok(desc.includes('inward qty 309'));
  assert.ok(desc.includes('Chandan Yadav'));

  const packingNote = buildStageNote(sample, 'packing_completed');
  assert.ok(packingNote.includes('Packed qty: 309'));
  assert.ok(packingNote.includes('Short qty: 63'));

  const invoiceNote = buildStageNote(sample, 'invoice_created');
  assert.ok(invoiceNote.includes('Invoice no: FKSOR/26-27/001'));

  const dispatchNote = buildStageNote(sample, 'dispatched');
  assert.ok(dispatchNote.includes('Docket company: Delhivery'));
  assert.ok(dispatchNote.includes('Docket id: DKT-9'));

  const inwardNote = buildStageNote(sample, 'inward_completed');
  assert.ok(inwardNote.includes('Inward qty: 309'));

  console.log('OK: TaskFlow bridge mapping + description tests passed');
}

run();
