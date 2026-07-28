/**
 * Consignment Packing → TaskFlow Pro bridge.
 *
 * Driven by consignment workflow stages (not packing-station scan data).
 * Packing remains source of truth; TaskFlow gets auto create/advance + assignees.
 */
const {
  isTaskflowEnabled,
  isTaskflowConfigured,
  getConfig,
  findWorkflowByConsignmentId,
  createWorkflowFromTemplate,
  advanceWorkflowThroughPosition,
  upsertFieldValues,
  getWorkflow,
  findProfileByNameAndEmail,
  updateWorkflow,
  patchStageAssignee,
} = require('./taskflowClient');
const { getUserDepartments } = require('./departments');

/** Packing workflow stage → TaskFlow stage position to complete (1-based). */
const EVENT_TO_TARGET_POSITION = {
  created: 1,
  packing_completed: 2,
  ready_for_invoice: 2,
  invoice_created: 3,
  ready_for_dispatch: 3,
  dispatched: 4,
  inward_completed: 5,
};

/** TaskFlow position → packing departments used to auto-pick assignees. */
const POSITION_DEPARTMENTS = {
  1: ['invoice', 'management'], // Consignment Creation
  2: ['packing', 'ground_team'], // Consignment Packing
  3: ['invoice'], // Invoice Creation
  4: ['dispatch', 'ground_team'], // Dispatched / Outward
  5: ['inward'], // Inwarding
};

/** TaskFlow position → packing stage key used for note text. */
const POSITION_TO_PACKING_STAGE = {
  1: 'created',
  2: 'packing_completed',
  3: 'invoice_created',
  4: 'dispatched',
  5: 'inward_completed',
};

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

const recentEvents = new Map();
const retryQueue = [];
let retryTimer = null;
let draining = false;

function eventKey(consignmentId, event) {
  return `${String(consignmentId)}:${String(event)}`;
}

function rememberEvent(key) {
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, Date.now());
  setTimeout(() => recentEvents.delete(key), 15 * 60 * 1000);
  return false;
}

function targetPositionForEvent(event) {
  return EVENT_TO_TARGET_POSITION[event] || null;
}

function maxTargetFromStages(stages = []) {
  let max = 0;
  for (const stage of stages) {
    const pos = targetPositionForEvent(stage);
    if (pos && pos > max) max = pos;
  }
  return max || null;
}

function consignmentNoOf(consignment) {
  return String(
    consignment?.internalShipmentNo
    || consignment?.shipmentNo
    || consignment?.id
    || ''
  ).trim();
}

function buildTitle(consignment) {
  const no = consignmentNoOf(consignment);
  const name = String(consignment?.name || '').trim();
  if (name && name !== no) return `Consignment ${no} — ${name}`.slice(0, 180);
  return `Consignment ${no || consignment?.id || 'unknown'}`.slice(0, 180);
}

function fmtQty(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

function stageConf(consignment, key) {
  return consignment?.stageConfirmations?.[key] || null;
}

/**
 * Full workflow description shown in TaskFlow — updated as stages complete.
 */
function buildWorkflowDescription(consignment) {
  const no = consignmentNoOf(consignment);
  const lines = [
    `Auto-triggered from Consignment Packing workflow for ${no}.`,
    `Consignment ID: ${consignment?.id || '—'}`,
    `Internal shipment: ${consignment?.internalShipmentNo || '—'}`,
    `Marketplace shipment: ${consignment?.shipmentNo || '—'}`,
    '',
    'Workflow steps (from consignment stages):',
  ];

  const createdBy = consignment?.createdByName
    || consignment?.createdByEmail
    || (consignment?.createdBy ? `user ${consignment.createdBy}` : null);
  lines.push(`1) Consignment created${createdBy ? ` by ${createdBy}` : ''}.`);

  const packing = consignment?.packingCompletion || {};
  const packingConf = stageConf(consignment, 'packing_completed');
  if (packingConf?.confirmedAt) {
    const planned = fmtQty(packing.plannedQty ?? consignment?.totalRequiredQty);
    const actual = fmtQty(packing.actualPackedQty ?? consignment?.totalPackedQty);
    const shortQty = fmtQty(packing.shortQty);
    const bits = [
      `Packing completed by ${packingConf.confirmedByName || packing.completedByName || 'team'}`,
    ];
    if (planned) bits.push(`planned qty ${planned}`);
    if (actual) bits.push(`packed qty ${actual}`);
    if (shortQty && Number(shortQty) > 0) bits.push(`short qty ${shortQty}`);
    if (packing.shortReason) bits.push(`reason: ${packing.shortReason}`);
    lines.push(`2) ${bits.join(' · ')}.`);
  } else {
    lines.push('2) Packing completed — pending.');
  }

  const invoice = consignment?.invoice || {};
  const invoiceConf = stageConf(consignment, 'invoice_created');
  if (invoiceConf?.confirmedAt) {
    const invNo = invoice.number || consignment?.forwardInvoiceNo || invoiceConf.details?.invoiceNumber;
    const amount = invoice.amount ?? invoiceConf.details?.invoiceAmount;
    const bits = [
      `Invoice ready / created by ${invoiceConf.confirmedByName || invoice.uploadedByName || 'team'}`,
    ];
    if (invNo) bits.push(`invoice no ${invNo}`);
    if (invoice.date) bits.push(`date ${invoice.date}`);
    if (amount !== undefined && amount !== null && amount !== '') bits.push(`amount ${amount}`);
    lines.push(`3) ${bits.join(' · ')}.`);
  } else {
    lines.push('3) Invoice ready — pending.');
  }

  const dispatch = consignment?.dispatchDetails || {};
  const dispatchConf = stageConf(consignment, 'dispatched');
  if (dispatchConf?.confirmedAt) {
    const docketNo = consignment?.docketNo || dispatch.docketNo || dispatchConf.details?.docketNo;
    const courier = consignment?.docketCompany || dispatch.docketCompany || dispatchConf.details?.docketCompany;
    const qty = fmtQty(dispatch.dispatchedQty ?? consignment?.unitsShipped ?? consignment?.totalPackedQty);
    const boxes = fmtQty(dispatch.boxCount ?? consignment?.boxCount);
    const bits = [
      `Ready to dispatch / dispatched by ${dispatchConf.confirmedByName || dispatch.completedByName || 'team'}`,
    ];
    if (courier) bits.push(`docket company ${courier}`);
    if (docketNo) bits.push(`docket id ${docketNo}`);
    if (qty) bits.push(`dispatched qty ${qty}`);
    if (boxes) bits.push(`boxes ${boxes}`);
    if (consignment?.actualDispatchDate || dispatch.dispatchDate) {
      bits.push(`date ${consignment?.actualDispatchDate || dispatch.dispatchDate}`);
    }
    lines.push(`4) ${bits.join(' · ')}.`);
  } else {
    lines.push('4) Ready to dispatch — pending.');
  }

  const inward = consignment?.inwardDetails || {};
  const inwardConf = stageConf(consignment, 'inward_completed');
  if (inwardConf?.confirmedAt) {
    const inwardQty = fmtQty(
      inward.receivedQty
      ?? consignment?.unitsInwarded
      ?? inwardConf.details?.inwardQty
    );
    const bits = [
      `Inward done by ${inwardConf.confirmedByName || inward.completedByName || 'team'}`,
    ];
    if (inwardQty) bits.push(`inward qty ${inwardQty}`);
    if (consignment?.dateOfInward || inward.inwardDate) {
      bits.push(`date ${consignment?.dateOfInward || inward.inwardDate}`);
    }
    if (inward.inwardVarianceReason || inwardConf.details?.inwardVarianceReason) {
      bits.push(`variance: ${inward.inwardVarianceReason || inwardConf.details.inwardVarianceReason}`);
    }
    lines.push(`5) ${bits.join(' · ')}.`);
  } else {
    lines.push('5) Inward done — pending.');
  }

  if (consignment?.groundTeamName || consignment?.groundTeamEmail) {
    lines.push('');
    lines.push(
      `Assigned packing owner: ${[
        consignment.groundTeamName,
        consignment.groundTeamEmail,
      ].filter(Boolean).join(' · ')}`
    );
  }

  return lines.join('\n').slice(0, 4000);
}

/**
 * Note written onto the TaskFlow stage being completed.
 */
function buildStageNote(consignment, packingStageKey) {
  const no = consignmentNoOf(consignment);
  if (packingStageKey === 'created') {
    return [
      `Consignment created in Packing app.`,
      `Consignment no: ${no}`,
      `ID: ${consignment?.id || '—'}`,
      `Auto-triggered TaskFlow stage 1.`,
    ].join(' ');
  }

  if (packingStageKey === 'packing_completed' || packingStageKey === 'ready_for_invoice') {
    const packing = consignment?.packingCompletion || {};
    const conf = stageConf(consignment, 'packing_completed') || {};
    const planned = fmtQty(packing.plannedQty ?? consignment?.totalRequiredQty);
    const actual = fmtQty(packing.actualPackedQty ?? consignment?.totalPackedQty);
    const shortQty = fmtQty(packing.shortQty);
    return [
      'Packing completed.',
      planned ? `Planned qty: ${planned}.` : null,
      actual ? `Packed qty: ${actual}.` : null,
      shortQty && Number(shortQty) > 0 ? `Short qty: ${shortQty}.` : null,
      packing.shortReason ? `Short reason: ${packing.shortReason}.` : null,
      conf.confirmedByName ? `Confirmed by: ${conf.confirmedByName}.` : null,
      `Consignment: ${no}.`,
    ].filter(Boolean).join(' ');
  }

  if (packingStageKey === 'invoice_created' || packingStageKey === 'ready_for_dispatch') {
    const invoice = consignment?.invoice || {};
    const conf = stageConf(consignment, 'invoice_created') || {};
    const invNo = invoice.number || consignment?.forwardInvoiceNo || conf.details?.invoiceNumber;
    const amount = invoice.amount ?? conf.details?.invoiceAmount;
    return [
      'Invoice ready / created.',
      invNo ? `Invoice no: ${invNo}.` : null,
      invoice.date ? `Invoice date: ${invoice.date}.` : null,
      amount !== undefined && amount !== null && amount !== '' ? `Amount: ${amount}.` : null,
      conf.confirmedByName ? `Confirmed by: ${conf.confirmedByName}.` : null,
      `Consignment: ${no}.`,
    ].filter(Boolean).join(' ');
  }

  if (packingStageKey === 'dispatched') {
    const dispatch = consignment?.dispatchDetails || {};
    const conf = stageConf(consignment, 'dispatched') || {};
    const docketNo = consignment?.docketNo || dispatch.docketNo || conf.details?.docketNo;
    const courier = consignment?.docketCompany || dispatch.docketCompany || conf.details?.docketCompany;
    const qty = fmtQty(dispatch.dispatchedQty ?? consignment?.unitsShipped ?? consignment?.totalPackedQty);
    return [
      'Ready to dispatch / dispatched.',
      courier ? `Docket company: ${courier}.` : null,
      docketNo ? `Docket id: ${docketNo}.` : null,
      qty ? `Dispatched qty: ${qty}.` : null,
      conf.confirmedByName ? `Confirmed by: ${conf.confirmedByName}.` : null,
      `Consignment: ${no}.`,
    ].filter(Boolean).join(' ');
  }

  if (packingStageKey === 'inward_completed') {
    const inward = consignment?.inwardDetails || {};
    const conf = stageConf(consignment, 'inward_completed') || {};
    const inwardQty = fmtQty(inward.receivedQty ?? consignment?.unitsInwarded ?? conf.details?.inwardQty);
    return [
      'Inward done.',
      inwardQty ? `Inward qty: ${inwardQty}.` : null,
      (consignment?.dateOfInward || inward.inwardDate)
        ? `Inward date: ${consignment?.dateOfInward || inward.inwardDate}.`
        : null,
      conf.confirmedByName ? `Confirmed by: ${conf.confirmedByName}.` : null,
      `Consignment: ${no}.`,
    ].filter(Boolean).join(' ');
  }

  return `Auto sync from Packing workflow (${packingStageKey}) for ${no}.`;
}

function noteForTaskflowPosition(consignment, position) {
  const packingStage = POSITION_TO_PACKING_STAGE[Number(position)] || 'created';
  return buildStageNote(consignment, packingStage);
}

async function loadPackingUsers() {
  try {
    const { firestoreHelpers } = require('./helpers');
    const users = await firestoreHelpers.getCollection('users');
    return (users || []).filter((u) => u && u.isActive !== false && u.email);
  } catch (error) {
    console.warn('[TaskFlowBridge] load packing users failed:', error.message);
    return [];
  }
}

/**
 * Match packing-app users to TaskFlow profiles by email (and name when available).
 * Example: Chandan Yadav / dispatches@vbexports.co.in in both systems → same assignee.
 */
async function resolveStageAssignees(consignment) {
  const packingUsers = await loadPackingUsers();
  const assignees = {};
  const matched = [];

  const ground = packingUsers.find((u) => u.id === consignment?.groundTeamUserId) || null;

  for (const [posRaw, deptKeys] of Object.entries(POSITION_DEPARTMENTS)) {
    const position = Number(posRaw);
    const candidates = [];

    if (ground && getUserDepartments(ground).some((d) => deptKeys.includes(d))) {
      candidates.push(ground);
    }
    for (const user of packingUsers) {
      if (ground && user.id === ground.id) continue;
      if (getUserDepartments(user).some((d) => deptKeys.includes(d))) {
        candidates.push(user);
      }
    }

    let profile = null;
    let packingUser = null;
    for (const user of candidates) {
      // Prefer exact email match; name used for logging / soft confirmation.
      // eslint-disable-next-line no-await-in-loop
      const found = await findProfileByNameAndEmail({
        name: user.name,
        email: user.email,
      });
      if (found?.id) {
        profile = found;
        packingUser = user;
        break;
      }
    }

    if (profile?.id) {
      assignees[position] = profile.id;
      matched.push({
        position,
        packingUserId: packingUser?.id || null,
        packingName: packingUser?.name || null,
        packingEmail: packingUser?.email || null,
        taskflowUserId: profile.id,
        taskflowName: profile.name || null,
        taskflowEmail: profile.email || null,
      });
    }
  }

  return { assignees, matched };
}

async function persistTaskflowMeta(consignmentId, patch) {
  if (!consignmentId || !patch) return;
  try {
    const { firestoreHelpers } = require('./helpers');
    const existing = await firestoreHelpers.getDocument('consignments', consignmentId);
    if (!existing) return;
    const prev = existing.taskflow && typeof existing.taskflow === 'object' ? existing.taskflow : {};
    await firestoreHelpers.setDocument('consignments', consignmentId, {
      taskflow: {
        ...prev,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[TaskFlowBridge] persist meta failed:', error.message);
  }
}

function enqueueRetry(job) {
  const attempts = (job.attempts || 0) + 1;
  if (attempts > MAX_RETRIES) {
    console.error('[TaskFlowBridge] giving up after retries:', job.type, job.consignmentId, job.event);
    persistTaskflowMeta(job.consignmentId, {
      lastError: `Gave up after ${MAX_RETRIES} retries: ${job.lastError || 'unknown'}`,
      lastErrorAt: new Date().toISOString(),
    }).catch(() => {});
    return;
  }
  const delay = RETRY_BASE_MS * (2 ** (attempts - 1));
  retryQueue.push({
    ...job,
    attempts,
    runAt: Date.now() + delay,
  });
  scheduleRetryDrain();
}

function scheduleRetryDrain() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    drainRetryQueue().catch((error) => {
      console.warn('[TaskFlowBridge] retry drain error:', error.message);
    });
  }, 1000);
}

async function drainRetryQueue() {
  if (draining) return;
  draining = true;
  try {
    const now = Date.now();
    const ready = [];
    const later = [];
    for (const job of retryQueue.splice(0)) {
      if (job.runAt <= now) ready.push(job);
      else later.push(job);
    }
    retryQueue.push(...later);
    for (const job of ready) {
      try {
        if (job.type === 'created') {
          await syncConsignmentCreated(job.consignment, { force: true, fromRetry: true });
        } else if (job.type === 'stages') {
          await syncConsignmentStages(job.consignment, job.stages, {
            force: true,
            fromRetry: true,
            note: job.note,
          });
        }
      } catch (error) {
        enqueueRetry({ ...job, lastError: error.message });
      }
    }
  } finally {
    draining = false;
    if (retryQueue.length) scheduleRetryDrain();
  }
}

async function ensureWorkflow(consignment) {
  const consignmentId = consignment?.id;
  if (!consignmentId) throw new Error('consignment.id required');

  const existingId = consignment?.taskflow?.workflowId;
  if (existingId) {
    const wf = await getWorkflow(existingId);
    if (wf) return { workflow: wf, created: false, matchedAssignees: [] };
  }

  const found = await findWorkflowByConsignmentId(consignmentId);
  if (found) {
    await persistTaskflowMeta(consignmentId, {
      workflowId: found.id,
      trackingNumber: found.tracking_number || null,
      lastError: null,
    });
    return { workflow: found, created: false, matchedAssignees: [] };
  }

  const no = consignmentNoOf(consignment);
  const { assignees, matched } = await resolveStageAssignees(consignment);
  const description = buildWorkflowDescription(consignment);

  const created = await createWorkflowFromTemplate({
    title: buildTitle(consignment),
    description,
    consignmentId,
    consignmentNo: no,
    stageAssignees: assignees,
  });

  await persistTaskflowMeta(consignmentId, {
    workflowId: created.id,
    trackingNumber: created.tracking_number || null,
    assigneeMatches: matched,
    lastError: null,
  });

  return { workflow: created, created: true, matchedAssignees: matched };
}

async function refreshWorkflowDescription(workflowId, consignment) {
  try {
    await updateWorkflow(workflowId, {
      description: buildWorkflowDescription(consignment),
    });
  } catch (error) {
    console.warn('[TaskFlowBridge] description update failed:', error.message);
  }
}

/**
 * Re-match packing users → TaskFlow assignees on open stages (e.g. after ground-team assign).
 */
async function refreshAssigneesForConsignment(consignment) {
  if (!isTaskflowEnabled() || !consignment?.id) return { skipped: true };
  try {
    const workflowId = consignment?.taskflow?.workflowId;
    let wf = workflowId ? await getWorkflow(workflowId) : null;
    if (!wf) wf = await findWorkflowByConsignmentId(consignment.id);
    if (!wf) return { skipped: true, reason: 'no_workflow' };

    const { assignees, matched } = await resolveStageAssignees(consignment);
    for (const stage of wf.stages || []) {
      if (stage.is_terminal || stage.status === 'completed') continue;
      const assigneeId = assignees[Number(stage.position)];
      if (!assigneeId) continue;
      // eslint-disable-next-line no-await-in-loop
      await patchStageAssignee(stage.id, assigneeId);
    }
    await refreshWorkflowDescription(wf.id, consignment);
    await persistTaskflowMeta(consignment.id, {
      workflowId: wf.id,
      trackingNumber: wf.tracking_number || null,
      assigneeMatches: matched,
      lastSyncedEvent: 'refresh-assignees',
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return { ok: true, workflowId: wf.id, matched };
  } catch (error) {
    console.warn('[TaskFlowBridge] refresh assignees failed:', error.message);
    return { ok: false, error: error.message };
  }
}

function notifyTaskflowAssigneesRefresh(consignment) {
  if (!isTaskflowEnabled()) return;
  setImmediate(() => {
    refreshAssigneesForConsignment(consignment).catch(() => {});
  });
}

/**
 * New consignment → create TaskFlow run and complete stage 1 (Creation).
 */
async function syncConsignmentCreated(consignment, options = {}) {
  if (!isTaskflowEnabled()) {
    return { skipped: true, reason: 'disabled_or_unconfigured' };
  }
  if (!consignment?.id) return { skipped: true, reason: 'missing_id' };

  const key = eventKey(consignment.id, 'created');
  if (!options.force && rememberEvent(key)) {
    return { skipped: true, reason: 'duplicate_event' };
  }

  try {
    const { workflow: wf, matchedAssignees } = await ensureWorkflow(consignment);
    const advanced = await advanceWorkflowThroughPosition(wf.id, 1, {
      note: buildStageNote(consignment, 'created'),
      noteForPosition: (pos) => noteForTaskflowPosition(consignment, pos),
    });
    await refreshWorkflowDescription(advanced.workflow?.id || wf.id, consignment);
    await persistTaskflowMeta(consignment.id, {
      workflowId: advanced.workflow?.id || wf.id,
      trackingNumber: advanced.workflow?.tracking_number || wf.tracking_number || null,
      syncedThroughPosition: 1,
      lastSyncedEvent: 'created',
      lastSyncedAt: new Date().toISOString(),
      assigneeMatches: matchedAssignees?.length ? matchedAssignees : undefined,
      lastError: null,
    });
    return { ok: true, workflowId: wf.id, advanced, matchedAssignees };
  } catch (error) {
    console.error('[TaskFlowBridge] create sync failed:', error.message);
    await persistTaskflowMeta(consignment.id, {
      lastError: error.message,
      lastErrorAt: new Date().toISOString(),
    });
    if (!options.fromRetry) {
      enqueueRetry({ type: 'created', consignment, consignmentId: consignment.id, lastError: error.message });
    }
    throw error;
  }
}

/**
 * Stage confirmations → advance TaskFlow through mapped positions.
 */
async function syncConsignmentStages(consignment, stages = [], options = {}) {
  if (!isTaskflowEnabled()) {
    return { skipped: true, reason: 'disabled_or_unconfigured' };
  }
  if (!consignment?.id) return { skipped: true, reason: 'missing_id' };

  const list = (Array.isArray(stages) ? stages : [stages]).filter(Boolean);
  const target = maxTargetFromStages(list);
  if (!target) {
    return { skipped: true, reason: 'unmapped_stages', stages: list };
  }

  const primaryEvent = list.includes('inward_completed')
    ? 'inward_completed'
    : list.includes('dispatched')
      ? 'dispatched'
      : list.includes('invoice_created') || list.includes('ready_for_dispatch')
        ? (list.includes('invoice_created') ? 'invoice_created' : 'ready_for_dispatch')
        : list.includes('packing_completed') || list.includes('ready_for_invoice')
          ? (list.includes('packing_completed') ? 'packing_completed' : 'ready_for_invoice')
          : list[0];

  const key = eventKey(consignment.id, primaryEvent);
  if (!options.force && rememberEvent(key)) {
    return { skipped: true, reason: 'duplicate_event' };
  }

  const alreadyThrough = Number(consignment?.taskflow?.syncedThroughPosition) || 0;
  if (!options.force && alreadyThrough >= target) {
    return { skipped: true, reason: 'already_synced_through', target };
  }

  try {
    const { workflow: wf } = await ensureWorkflow(consignment);
    const advanced = await advanceWorkflowThroughPosition(wf.id, target, {
      note: options.note || buildStageNote(consignment, primaryEvent),
      noteForPosition: (pos) => noteForTaskflowPosition(consignment, pos),
    });
    await refreshWorkflowDescription(advanced.workflow?.id || wf.id, consignment);
    await persistTaskflowMeta(consignment.id, {
      workflowId: advanced.workflow?.id || wf.id,
      trackingNumber: advanced.workflow?.tracking_number || wf.tracking_number || null,
      syncedThroughPosition: Math.max(alreadyThrough, target),
      lastSyncedEvent: primaryEvent,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return { ok: true, workflowId: wf.id, target, advanced };
  } catch (error) {
    console.error('[TaskFlowBridge] stage sync failed:', error.message);
    await persistTaskflowMeta(consignment.id, {
      lastError: error.message,
      lastErrorAt: new Date().toISOString(),
    });
    if (!options.fromRetry) {
      enqueueRetry({
        type: 'stages',
        consignment,
        consignmentId: consignment.id,
        stages: list,
        note: options.note,
        lastError: error.message,
      });
    }
    throw error;
  }
}

function notifyTaskflowCreated(consignment) {
  if (!isTaskflowEnabled()) return;
  setImmediate(() => {
    syncConsignmentCreated(consignment).catch(() => {});
  });
}

function notifyTaskflowStages(consignment, stages, options = {}) {
  if (!isTaskflowEnabled()) return;
  setImmediate(() => {
    syncConsignmentStages(consignment, stages, options).catch(() => {});
  });
}

async function syncConsignmentIdChange(oldId, newConsignment) {
  if (!isTaskflowEnabled() || !newConsignment?.id) return { skipped: true };
  try {
    let wf = null;
    const existingId = newConsignment?.taskflow?.workflowId;
    if (existingId) {
      wf = await getWorkflow(existingId);
    }
    if (!wf && oldId) {
      wf = await findWorkflowByConsignmentId(oldId);
    }
    if (!wf) {
      wf = await findWorkflowByConsignmentId(newConsignment.id);
    }
    if (!wf) {
      return syncConsignmentCreated(newConsignment, { force: true });
    }

    await upsertFieldValues(wf.id, [
      { field_key: 'consignment_id', label: 'Consignment ID', value: newConsignment.id },
      {
        field_key: 'consignment_no',
        label: 'Consignment No',
        value: consignmentNoOf(newConsignment),
      },
      {
        field_key: 'reference_id',
        label: 'Reference / Consignment No',
        value: consignmentNoOf(newConsignment),
      },
    ]);
    await refreshWorkflowDescription(wf.id, newConsignment);
    await persistTaskflowMeta(newConsignment.id, {
      workflowId: wf.id,
      trackingNumber: wf.tracking_number || null,
      lastSyncedEvent: 'reassign-id',
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return { ok: true, workflowId: wf.id };
  } catch (error) {
    console.warn('[TaskFlowBridge] reassign sync failed:', error.message);
    return { ok: false, error: error.message };
  }
}

async function resyncConsignmentToTaskflow(consignment) {
  if (!isTaskflowConfigured()) {
    return { ok: false, error: 'TaskFlow is not configured' };
  }
  if (!consignment?.id) return { ok: false, error: 'Consignment required' };

  const confirmed = [];
  const sc = consignment.stageConfirmations || {};
  for (const stage of Object.keys(EVENT_TO_TARGET_POSITION)) {
    if (stage === 'created') continue;
    if (sc[stage]?.confirmedAt) confirmed.push(stage);
  }

  const createdResult = await syncConsignmentCreated(consignment, { force: true });
  let stagesResult = null;
  if (confirmed.length) {
    stagesResult = await syncConsignmentStages(consignment, confirmed, {
      force: true,
      note: 'Admin resync from consignment workflow stages',
    });
  }

  return {
    ok: true,
    createdResult,
    stagesResult,
    confirmedStages: confirmed,
    descriptionPreview: buildWorkflowDescription(consignment),
    config: {
      enabled: isTaskflowEnabled(),
      templateId: getConfig().templateId,
      urlConfigured: Boolean(getConfig().url),
    },
  };
}

function getTaskflowStatus() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    configured: cfg.configured,
    templateId: cfg.templateId || null,
    url: cfg.url ? cfg.url.replace(/^(https?:\/\/[^/]+).*/, '$1') : null,
    raisedByConfigured: Boolean(cfg.raisedBy),
    mcpPatConfigured: Boolean(cfg.mcpPat),
    retryQueueLength: retryQueue.length,
    eventMap: { ...EVENT_TO_TARGET_POSITION },
    positionDepartments: { ...POSITION_DEPARTMENTS },
  };
}

module.exports = {
  EVENT_TO_TARGET_POSITION,
  POSITION_DEPARTMENTS,
  targetPositionForEvent,
  maxTargetFromStages,
  buildWorkflowDescription,
  buildStageNote,
  notifyTaskflowCreated,
  notifyTaskflowStages,
  notifyTaskflowAssigneesRefresh,
  syncConsignmentCreated,
  syncConsignmentStages,
  syncConsignmentIdChange,
  refreshAssigneesForConsignment,
  resyncConsignmentToTaskflow,
  getTaskflowStatus,
  isTaskflowEnabled,
  isTaskflowConfigured,
};
