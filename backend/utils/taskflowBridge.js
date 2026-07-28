/**
 * Consignment Packing → TaskFlow Pro bridge.
 *
 * Packing remains source of truth. This module creates/advances TaskFlow runs
 * keyed by consignment id + internalShipmentNo.
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
} = require('./taskflowClient');

/** Packing status / stage → TaskFlow stage position to complete (1-based). */
const EVENT_TO_TARGET_POSITION = {
  created: 1,
  packing_completed: 2,
  ready_for_invoice: 2,
  invoice_created: 3,
  ready_for_dispatch: 3,
  dispatched: 4,
  inward_completed: 5,
};

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

/** In-memory idempotency + retry queue (survives within process lifetime). */
const recentEvents = new Map(); // eventKey → ts
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
    if (wf) return wf;
  }

  const found = await findWorkflowByConsignmentId(consignmentId);
  if (found) {
    await persistTaskflowMeta(consignmentId, {
      workflowId: found.id,
      trackingNumber: found.tracking_number || null,
      lastError: null,
    });
    return found;
  }

  const no = consignmentNoOf(consignment);
  const created = await createWorkflowFromTemplate({
    title: buildTitle(consignment),
    description: `Auto-created from Consignment Packing for ${no}`,
    consignmentId,
    consignmentNo: no,
  });

  await persistTaskflowMeta(consignmentId, {
    workflowId: created.id,
    trackingNumber: created.tracking_number || null,
    lastError: null,
  });

  return created;
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
    const wf = await ensureWorkflow(consignment);
    const advanced = await advanceWorkflowThroughPosition(wf.id, 1, {
      note: 'Auto: consignment created in Packing app',
    });
    await persistTaskflowMeta(consignment.id, {
      workflowId: advanced.workflow?.id || wf.id,
      trackingNumber: advanced.workflow?.tracking_number || wf.tracking_number || null,
      syncedThroughPosition: 1,
      lastSyncedEvent: 'created',
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return { ok: true, workflowId: wf.id, advanced };
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
 * @param {object} consignment
 * @param {string[]} stages — packing stage keys (confirmed + auto)
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

  // Also skip if already synced through this position on the document.
  const alreadyThrough = Number(consignment?.taskflow?.syncedThroughPosition) || 0;
  if (!options.force && alreadyThrough >= target) {
    return { skipped: true, reason: 'already_synced_through', target };
  }

  try {
    const wf = await ensureWorkflow(consignment);
    const advanced = await advanceWorkflowThroughPosition(wf.id, target, {
      note: options.note || `Auto: packing stages [${list.join(', ')}]`,
    });
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

/** Fire-and-forget wrappers for route handlers. */
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
      // No prior run — create under the new id.
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

/**
 * Full resync for admin: ensure workflow exists and advance to match packing stageConfirmations.
 */
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

  // Always ensure create + stage 1.
  const createdResult = await syncConsignmentCreated(consignment, { force: true });
  let stagesResult = null;
  if (confirmed.length) {
    stagesResult = await syncConsignmentStages(consignment, confirmed, { force: true, note: 'Admin resync' });
  }

  return {
    ok: true,
    createdResult,
    stagesResult,
    confirmedStages: confirmed,
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
  };
}

module.exports = {
  EVENT_TO_TARGET_POSITION,
  targetPositionForEvent,
  maxTargetFromStages,
  notifyTaskflowCreated,
  notifyTaskflowStages,
  syncConsignmentCreated,
  syncConsignmentStages,
  syncConsignmentIdChange,
  resyncConsignmentToTaskflow,
  getTaskflowStatus,
  isTaskflowEnabled,
  isTaskflowConfigured,
};
