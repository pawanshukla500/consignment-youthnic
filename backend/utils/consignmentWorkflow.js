/**
 * Consignment operational workflow: stage gates, TAT, list priority, escalations.
 *
 * Stages (in order — each requires confirmation before the next):
 *   packing_completed → ready_for_invoice → invoice_created → ready_for_dispatch → dispatched
 *
 * Packing station can still pack freely; invoice/dispatch logistics are gated
 * until ground team confirms packing_completed.
 */

const STAGE_ORDER = [
  'packing_completed',
  'ready_for_invoice',
  'invoice_created',
  'ready_for_dispatch',
  'dispatched',
];

const STAGE_LABELS = {
  packing_completed: 'Packing completed',
  ready_for_invoice: 'Ready for invoice creation',
  invoice_created: 'Invoice created',
  ready_for_dispatch: 'Ready for dispatch',
  dispatched: 'Dispatched',
};

/** Default TAT hours per stage (from assignment / previous confirmation). */
const DEFAULT_TAT_HOURS = {
  packing_completed: 48,
  ready_for_invoice: 24,
  invoice_created: 24,
  ready_for_dispatch: 24,
  dispatched: 48,
};

const LIST_BUCKETS = {
  new: 1,
  active: 2,
  packed_pending_invoice: 3,
  ready_for_dispatch: 4,
  shipped: 5,
  inwarded: 6,
};

function emptyStageConfirmations() {
  return STAGE_ORDER.reduce((acc, key) => {
    acc[key] = { confirmedAt: null, confirmedByUserId: null, confirmedByName: null, note: null };
    return acc;
  }, {});
}

function normalizeStageConfirmations(raw) {
  const base = emptyStageConfirmations();
  if (!raw || typeof raw !== 'object') return base;
  for (const key of STAGE_ORDER) {
    if (raw[key] && typeof raw[key] === 'object') {
      base[key] = {
        confirmedAt: raw[key].confirmedAt || null,
        confirmedByUserId: raw[key].confirmedByUserId || null,
        confirmedByName: raw[key].confirmedByName || null,
        note: raw[key].note || null,
      };
    }
  }
  return base;
}

function isStageConfirmed(consignment, stage) {
  const conf = normalizeStageConfirmations(consignment?.stageConfirmations);
  return Boolean(conf[stage]?.confirmedAt);
}

function getCurrentWorkflowStage(consignment) {
  for (const stage of STAGE_ORDER) {
    if (!isStageConfirmed(consignment, stage)) return stage;
  }
  return 'completed';
}

function getPreviousStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx <= 0) return null;
  return STAGE_ORDER[idx - 1];
}

/**
 * Whether confirming `stage` is allowed.
 * packing_completed also requires pack status completed (or all qty packed).
 */
function canConfirmStage(consignment, stage) {
  if (!STAGE_ORDER.includes(stage)) {
    return { ok: false, error: 'Unknown workflow stage.' };
  }
  if (isStageConfirmed(consignment, stage)) {
    return { ok: false, error: 'This stage is already confirmed.' };
  }
  const prev = getPreviousStage(stage);
  if (prev && !isStageConfirmed(consignment, prev)) {
    return {
      ok: false,
      error: `Confirm "${STAGE_LABELS[prev]}" before "${STAGE_LABELS[stage]}".`,
      code: 'STAGE_GATE',
      requiredStage: prev,
    };
  }
  if (stage === 'packing_completed') {
    if (!isPackingPhysicallyDone(consignment)) {
      return {
        ok: false,
        error: 'Packing must be finished (all units packed) before ground team can confirm packing completed.',
        code: 'PACKING_INCOMPLETE',
      };
    }
  }
  if (stage === 'invoice_created' && !String(consignment.forwardInvoiceNo || '').trim()) {
    return {
      ok: false,
      error: 'Enter forward invoice number on the consignment before confirming invoice created.',
      code: 'INVOICE_MISSING',
    };
  }
  return { ok: true };
}

/** Block invoice/dispatch logistics edits until packing_completed is confirmed. */
function canAdvanceLogistics(consignment, nextShipmentStatus) {
  const blocked = new Set(['Ready', 'In Transit', 'Forwarded']);
  if (!blocked.has(nextShipmentStatus)) return { ok: true };
  if (isStageConfirmed(consignment, 'packing_completed')) return { ok: true };
  return {
    ok: false,
    error: 'Ground team must confirm packing completed before invoice / dispatch stages.',
    code: 'GROUND_TEAM_GATE',
  };
}

function buildTatDeadlines(fromIso, hoursMap = DEFAULT_TAT_HOURS) {
  const start = new Date(fromIso || Date.now()).getTime();
  const deadlines = {};
  let cursor = start;
  for (const stage of STAGE_ORDER) {
    const hours = Number(hoursMap[stage]) || DEFAULT_TAT_HOURS[stage];
    cursor += hours * 60 * 60 * 1000;
    deadlines[`${stage}DueAt`] = new Date(cursor).toISOString();
  }
  return deadlines;
}

function refreshTatFromStage(consignment, confirmedStage, hoursMap = DEFAULT_TAT_HOURS) {
  const existing = { ...(consignment.tatDeadlines || {}) };
  const idx = STAGE_ORDER.indexOf(confirmedStage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return existing;
  let cursor = Date.now();
  for (let i = idx + 1; i < STAGE_ORDER.length; i++) {
    const stage = STAGE_ORDER[i];
    const hours = Number(hoursMap[stage]) || DEFAULT_TAT_HOURS[stage];
    cursor += hours * 60 * 60 * 1000;
    existing[`${stage}DueAt`] = new Date(cursor).toISOString();
  }
  return existing;
}

function getOverdueStages(consignment, now = Date.now()) {
  const conf = normalizeStageConfirmations(consignment?.stageConfirmations);
  const deadlines = consignment?.tatDeadlines || {};
  const overdue = [];
  for (const stage of STAGE_ORDER) {
    if (conf[stage]?.confirmedAt) continue;
    const dueAt = deadlines[`${stage}DueAt`];
    if (dueAt && new Date(dueAt).getTime() < now) {
      overdue.push({
        stage,
        label: STAGE_LABELS[stage],
        dueAt,
        overdueMs: now - new Date(dueAt).getTime(),
      });
    }
  }
  return overdue;
}

function getListPriorityBucket(consignment) {
  const ship = consignment.shipmentStatus || 'Planned';
  const pack = consignment.status || 'pending';
  const inwarded = Boolean(consignment.dateOfInward);
  const packingDone = isStageConfirmed(consignment, 'packing_completed') || pack === 'completed';
  const invoiceReady = isStageConfirmed(consignment, 'ready_for_invoice');
  const invoiceDone = isStageConfirmed(consignment, 'invoice_created');
  const readyDispatch = isStageConfirmed(consignment, 'ready_for_dispatch') || ship === 'Ready';
  const dispatched = isStageConfirmed(consignment, 'dispatched')
    || ['In Transit', 'Forwarded'].includes(ship);

  if (inwarded || ship === 'Missed') return 'inwarded';
  if (dispatched) return 'shipped';
  if (readyDispatch && invoiceDone) return 'ready_for_dispatch';
  if (packingDone && (!invoiceDone || invoiceReady)) return 'packed_pending_invoice';
  if (pack === 'in_progress' || ship === 'Under Packing') return 'active';
  if (pack === 'pending' || ship === 'Planned' || ship === 'Scheduled') return 'new';
  return 'active';
}

function getListPriorityRank(consignment) {
  return LIST_BUCKETS[getListPriorityBucket(consignment)] || 99;
}

function sortConsignmentsByWorkflowPriority(items = []) {
  return [...items].sort((a, b) => {
    const ra = getListPriorityRank(a);
    const rb = getListPriorityRank(b);
    if (ra !== rb) return ra - rb;
    // Within bucket: escalated first, then earliest TAT, then dispatch criticality date
    const ea = a.isEscalated ? 0 : 1;
    const eb = b.isEscalated ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const da = a.requiredDispatchDate || a.scheduledDispatchDate || a.appointmentDate || '';
    const db = b.requiredDispatchDate || b.scheduledDispatchDate || b.appointmentDate || '';
    if (da && db && da !== db) return String(da).localeCompare(String(db));
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function applyStageConfirmation(consignment, stage, user, note = null) {
  const gate = canConfirmStage(consignment, stage);
  if (!gate.ok) return { ok: false, ...gate };

  const stageConfirmations = normalizeStageConfirmations(consignment.stageConfirmations);
  stageConfirmations[stage] = {
    confirmedAt: new Date().toISOString(),
    confirmedByUserId: user?.id || null,
    confirmedByName: user?.name || user?.email || null,
    note: note || null,
  };

  const updates = {
    stageConfirmations,
    tatDeadlines: refreshTatFromStage(consignment, stage),
    currentWorkflowStage: getCurrentWorkflowStage({ ...consignment, stageConfirmations }),
    pendingAction: getPendingActionLabel({ ...consignment, stageConfirmations }),
    updatedAt: new Date().toISOString(),
  };

  // Keep shipmentStatus aligned with confirmed logistics stages
  if (stage === 'packing_completed' && !['Ready', 'In Transit', 'Forwarded'].includes(consignment.shipmentStatus)) {
    // Stay Under Packing until ready_for_invoice / invoice — packing done ops-wise
    updates.workflowPackingConfirmedAt = updates.stageConfirmations.packing_completed.confirmedAt;
  }
  if (stage === 'ready_for_dispatch') {
    updates.shipmentStatus = 'Ready';
  }
  if (stage === 'dispatched') {
    updates.shipmentStatus = 'In Transit';
    if (!consignment.actualDispatchDate) {
      updates.actualDispatchDate = new Date().toISOString().slice(0, 10);
    }
  }

  // Clear escalation when progress is made
  if (consignment.isEscalated) {
    updates.isEscalated = false;
    updates.escalationLevel = 0;
    updates.escalationReason = null;
  }

  return { ok: true, updates };
}

function isPackingPhysicallyDone(consignment) {
  const packed = Number(consignment?.totalPackedQty) || 0;
  const required = Number(consignment?.totalRequiredQty) || 0;
  return consignment?.status === 'completed' || (required > 0 && packed >= required);
}

/**
 * Human-readable next action for list / emails.
 * Do not use past-tense stage names when packing has not actually finished —
 * otherwise the consignments tab shows "Packing completed" on brand-new rows.
 */
function getPendingActionLabel(consignment) {
  const stage = getCurrentWorkflowStage(consignment);
  if (!stage || stage === 'completed') return null;

  if (stage === 'packing_completed') {
    if (isPackingPhysicallyDone(consignment)) {
      return 'Confirm packing completed';
    }
    const packed = Number(consignment?.totalPackedQty) || 0;
    const status = consignment?.status || 'pending';
    if (status === 'in_progress' || packed > 0) {
      return 'Finish packing';
    }
    return 'Packing not started';
  }

  return STAGE_LABELS[stage] || null;
}

function enrichWorkflowFields(consignment) {
  if (!consignment) return consignment;
  const stageConfirmations = normalizeStageConfirmations(consignment.stageConfirmations);
  const withStages = { ...consignment, stageConfirmations };
  const currentWorkflowStage = getCurrentWorkflowStage(withStages);
  const overdueStages = getOverdueStages(withStages);
  const listPriorityBucket = getListPriorityBucket(withStages);
  return {
    ...consignment,
    stageConfirmations,
    currentWorkflowStage,
    currentWorkflowStageLabel: STAGE_LABELS[currentWorkflowStage] || 'Complete',
    pendingAction: getPendingActionLabel(withStages),
    overdueStages,
    isTatOverdue: overdueStages.length > 0,
    listPriorityBucket,
    listPriorityRank: LIST_BUCKETS[listPriorityBucket],
    workflowStages: STAGE_ORDER.map((key) => ({
      key,
      label: STAGE_LABELS[key],
      confirmed: Boolean(stageConfirmations[key]?.confirmedAt),
      ...stageConfirmations[key],
      dueAt: consignment.tatDeadlines?.[`${key}DueAt`] || null,
    })),
  };
}

function buildWeeklyReportSummary(consignments = []) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const enriched = consignments.map(enrichWorkflowFields);

  const byUser = {};
  const byMarketplace = {};
  const bump = (map, key, field, name) => {
    if (!key) return;
    if (!map[key]) map[key] = { id: key, name: name || key, created: 0, packed: 0, dispatched: 0, delayed: 0 };
    map[key][field] += 1;
  };

  let created = 0;
  let inProgress = 0;
  let packed = 0;
  let pendingInvoice = 0;
  let dispatched = 0;
  let inwarded = 0;
  let delayed = 0;

  for (const c of enriched) {
    created += 1;

    const bucket = c.listPriorityBucket;
    if (bucket === 'active') inProgress += 1;
    if (bucket === 'packed_pending_invoice') {
      packed += 1;
      pendingInvoice += 1;
    }
    if (bucket === 'ready_for_dispatch') packed += 1;
    if (bucket === 'shipped') dispatched += 1;
    if (bucket === 'inwarded') inwarded += 1;
    if (c.isTatOverdue || c.isEscalated) delayed += 1;

    const assignee = c.groundTeamUserId || c.groundTeamName || 'Unassigned';
    const assigneeName = c.groundTeamName || assignee;
    bump(byUser, assignee, 'created', assigneeName);
    if (isStageConfirmed(c, 'packing_completed')) bump(byUser, assignee, 'packed', assigneeName);
    if (isStageConfirmed(c, 'dispatched')) bump(byUser, assignee, 'dispatched', assigneeName);
    if (c.isTatOverdue) bump(byUser, assignee, 'delayed', assigneeName);

    const mp = c.marketplaceId || c.marketplace?.name || c.warehouse || 'Unassigned';
    const mpName = c.marketplace?.name || c.warehouse || String(mp);
    bump(byMarketplace, mp, 'created', mpName);
    if (isStageConfirmed(c, 'packing_completed')) bump(byMarketplace, mp, 'packed', mpName);
    if (isStageConfirmed(c, 'dispatched')) bump(byMarketplace, mp, 'dispatched', mpName);
    if (c.isTatOverdue) bump(byMarketplace, mp, 'delayed', mpName);
  }

  const weeklyNew = enriched.filter((c) => c.createdAt && new Date(c.createdAt).getTime() >= weekAgo).length;

  return {
    generatedAt: new Date().toISOString(),
    periodDays: 7,
    totals: {
      totalConsignments: created,
      newConsignments: weeklyNew,
      inProgress,
      packed,
      pendingInvoice,
      dispatched,
      inwarded,
      delayed,
    },
    byAssignee: Object.values(byUser).map((row) => ({
      userId: row.id,
      name: enriched.find((c) => c.groundTeamUserId === row.id)?.groundTeamName || row.name,
      packed: row.packed,
      dispatched: row.dispatched,
      delayed: row.delayed,
      created: row.created,
    })),
    byDepartment: Object.values(byMarketplace).map((row) => ({
      departmentId: row.id,
      name: row.name,
      packed: row.packed,
      dispatched: row.dispatched,
      delayed: row.delayed,
      created: row.created,
    })),
    delayedItems: enriched
      .filter((c) => c.isTatOverdue || c.isEscalated)
      .slice(0, 50)
      .map((c) => ({
        id: c.id,
        internalShipmentNo: c.internalShipmentNo,
        groundTeamUserId: c.groundTeamUserId,
        groundTeamName: c.groundTeamName,
        pendingAction: c.pendingAction,
        overdueStages: c.overdueStages,
        isEscalated: c.isEscalated,
        shipmentStatus: c.shipmentStatus,
        status: c.status,
      })),
  };
}

module.exports = {
  STAGE_ORDER,
  STAGE_LABELS,
  DEFAULT_TAT_HOURS,
  LIST_BUCKETS,
  emptyStageConfirmations,
  normalizeStageConfirmations,
  isStageConfirmed,
  getCurrentWorkflowStage,
  canConfirmStage,
  canAdvanceLogistics,
  buildTatDeadlines,
  getOverdueStages,
  getListPriorityBucket,
  getListPriorityRank,
  sortConsignmentsByWorkflowPriority,
  applyStageConfirmation,
  enrichWorkflowFields,
  getPendingActionLabel,
  isPackingPhysicallyDone,
  buildWeeklyReportSummary,
};
