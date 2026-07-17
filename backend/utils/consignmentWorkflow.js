/**
 * Consignment operational workflow: stage gates, TAT, list priority, escalations.
 *
 * Stages (in order — each requires confirmation before the next):
 *   packing_completed → ready_for_invoice → invoice_created →
 *   ready_for_dispatch → dispatched → inward_completed
 *
 * Short packing is allowed when the operator supplies actual packed qty + short reason.
 * Department-based auto-assignment runs after key stage confirmations.
 */

const {
  NEXT_ASSIGNMENT_DEPARTMENT,
  normalizeDepartment,
  departmentLabel,
} = require('./departments');

const STAGE_ORDER = [
  'packing_completed',
  'ready_for_invoice',
  'invoice_created',
  'ready_for_dispatch',
  'dispatched',
  'inward_completed',
];

const STAGE_LABELS = {
  packing_completed: 'Packing completed',
  ready_for_invoice: 'Ready for invoice',
  invoice_created: 'Invoice created',
  ready_for_dispatch: 'Ready for dispatch',
  dispatched: 'Dispatched',
  inward_completed: 'Inward completed',
};

/** Default TAT hours per stage (from assignment / previous confirmation). */
const DEFAULT_TAT_HOURS = {
  packing_completed: 48,
  ready_for_invoice: 24,
  invoice_created: 24,
  ready_for_dispatch: 24,
  dispatched: 48,
  inward_completed: 72,
};

const LIST_BUCKETS = {
  new: 1,
  active: 2,
  packed_pending_invoice: 3,
  ready_for_dispatch: 4,
  shipped: 5,
  inward_pending: 6,
  inwarded: 7,
  archived: 8,
};

function emptyStageConfirmations() {
  return STAGE_ORDER.reduce((acc, key) => {
    acc[key] = {
      confirmedAt: null,
      confirmedByUserId: null,
      confirmedByName: null,
      note: null,
      details: null,
    };
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
        details: raw[key].details || null,
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
  if (consignment?.operationalStatus === 'archived' || consignment?.isArchived) {
    return 'archived';
  }
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

function getPackingTotals(consignment) {
  const planned = Number(consignment?.totalRequiredQty) || 0;
  const packed = Number(consignment?.totalPackedQty) || 0;
  return { planned, packed, short: Math.max(0, planned - packed) };
}

function isPackingPhysicallyDone(consignment) {
  const { planned, packed } = getPackingTotals(consignment);
  return consignment?.status === 'completed' || (planned > 0 && packed >= planned);
}

function hasInvoiceDocument(consignment) {
  if (consignment?.invoiceDocumentId || consignment?.invoice?.documentId) return true;
  const docs = consignment?.documents || consignment?.documentIds || [];
  if (Array.isArray(docs) && docs.some((d) => {
    if (!d) return false;
    if (typeof d === 'string') return false;
    const purpose = String(d.purpose || d.type || d.description || '').toLowerCase();
    return purpose.includes('invoice');
  })) return true;
  return Boolean(consignment?.invoiceUploadedAt && consignment?.invoiceDocumentId);
}

/**
 * Whether confirming `stage` is allowed.
 * packing_completed allows short pack when payload.allowShortPack + shortReason provided.
 */
function canConfirmStage(consignment, stage, payload = {}) {
  if (!STAGE_ORDER.includes(stage)) {
    return { ok: false, error: 'Unknown workflow stage.' };
  }
  if (consignment?.operationalStatus === 'archived' || consignment?.isArchived) {
    return { ok: false, error: 'Archived consignments cannot change workflow stages.', code: 'ARCHIVED' };
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
    const { planned, packed, short } = getPackingTotals(consignment);
    const fullyDone = isPackingPhysicallyDone(consignment);
    const allowShort = Boolean(payload.allowShortPack);
    const shortReason = String(payload.shortReason || payload.reason || '').trim();
    const actualPacked = payload.actualPackedQty != null
      ? Number(payload.actualPackedQty)
      : packed;

    if (packed <= 0 && !(actualPacked > 0)) {
      return {
        ok: false,
        error: 'No packed quantity recorded yet. Pack units before confirming packing completed.',
        code: 'PACKING_EMPTY',
      };
    }

    if (!fullyDone && !allowShort) {
      return {
        ok: false,
        error: 'Packing is short of planned quantity. Confirm short packing with a reason, or finish packing all units.',
        code: 'PACKING_INCOMPLETE',
        plannedQty: planned,
        packedQty: packed,
        shortQty: short,
      };
    }

    if (!fullyDone && allowShort && !shortReason) {
      return {
        ok: false,
        error: 'A reason is required when confirming packing completed with short quantity.',
        code: 'SHORT_REASON_REQUIRED',
        plannedQty: planned,
        packedQty: packed,
        shortQty: short,
      };
    }

    if (actualPacked > planned && planned > 0) {
      return {
        ok: false,
        error: 'Actual packed quantity cannot exceed planned shipment quantity.',
        code: 'PACKED_EXCEEDS_PLANNED',
      };
    }
  }

  if (stage === 'invoice_created') {
    const invoiceNo = String(payload.invoiceNumber || consignment.forwardInvoiceNo || '').trim();
    if (!invoiceNo) {
      return {
        ok: false,
        error: 'Invoice number is required before confirming invoice created.',
        code: 'INVOICE_MISSING',
      };
    }
    const hasDoc = Boolean(payload.invoiceDocumentId) || hasInvoiceDocument({
      ...consignment,
      invoiceDocumentId: payload.invoiceDocumentId || consignment.invoiceDocumentId,
    });
    if (!hasDoc) {
      return {
        ok: false,
        error: 'Upload the invoice document before marking invoice completed.',
        code: 'INVOICE_DOCUMENT_REQUIRED',
      };
    }
  }

  if (stage === 'dispatched') {
    const docketNo = String(payload.docketNo || consignment.docketNo || '').trim();
    const courier = String(payload.docketCompany || consignment.docketCompany || '').trim();
    if (!docketNo) {
      return {
        ok: false,
        error: 'Docket ID is required before marking dispatched.',
        code: 'DOCKET_REQUIRED',
      };
    }
    if (!courier) {
      return {
        ok: false,
        error: 'Courier / transport company is required before marking dispatched.',
        code: 'COURIER_REQUIRED',
      };
    }
  }

  if (stage === 'inward_completed') {
    const dispatchedQty = Number(
      payload.dispatchedQty
      ?? consignment.dispatchDetails?.dispatchedQty
      ?? consignment.totalPackedQty
      ?? 0
    );
    const inwardQty = Number(
      payload.inwardQty
      ?? consignment.inwardDetails?.receivedQty
      ?? consignment.unitsInwarded
      ?? consignment.unitsReceived
      ?? 0
    );
    if (!(inwardQty > 0)) {
      return {
        ok: false,
        error: 'Record inward received quantity before completing inward tracking.',
        code: 'INWARD_QTY_REQUIRED',
      };
    }
    // Allow complete when inward matches dispatched/packed, or operator confirms with variance reason
    if (dispatchedQty > 0 && inwardQty !== dispatchedQty && !String(payload.inwardVarianceReason || '').trim()) {
      return {
        ok: false,
        error: 'Inward quantity differs from dispatched quantity — provide a variance / dispute reason.',
        code: 'INWARD_VARIANCE_REASON_REQUIRED',
        dispatchedQty,
        inwardQty,
      };
    }
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
  if (consignment?.operationalStatus === 'archived' || consignment?.isArchived) {
    return 'archived';
  }
  const ship = consignment.shipmentStatus || 'Planned';
  const pack = consignment.status || 'pending';
  const packingDone = isStageConfirmed(consignment, 'packing_completed') || pack === 'completed';
  const invoiceReady = isStageConfirmed(consignment, 'ready_for_invoice');
  const invoiceDone = isStageConfirmed(consignment, 'invoice_created');
  const readyDispatch = isStageConfirmed(consignment, 'ready_for_dispatch') || ship === 'Ready';
  const dispatched = isStageConfirmed(consignment, 'dispatched')
    || ['In Transit', 'Forwarded'].includes(ship);
  const inwardDone = isStageConfirmed(consignment, 'inward_completed')
    || Boolean(consignment.dateOfInward);

  if (inwardDone || ship === 'Missed') return 'inwarded';
  if (dispatched) return 'inward_pending';
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
    const ea = a.isEscalated ? 0 : 1;
    const eb = b.isEscalated ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const da = a.requiredDispatchDate || a.scheduledDispatchDate || a.appointmentDate || '';
    const db = b.requiredDispatchDate || b.scheduledDispatchDate || b.appointmentDate || '';
    if (da && db && da !== db) return String(da).localeCompare(String(db));
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function buildStageDetails(stage, consignment, payload = {}) {
  if (stage === 'packing_completed') {
    const { planned, packed } = getPackingTotals(consignment);
    const actual = payload.actualPackedQty != null ? Number(payload.actualPackedQty) : packed;
    const shortQty = Math.max(0, planned - actual);
    return {
      plannedQty: planned,
      actualPackedQty: actual,
      shortQty,
      shortReason: shortQty > 0 ? String(payload.shortReason || payload.reason || '').trim() : null,
      allowShortPack: Boolean(payload.allowShortPack) || shortQty > 0,
    };
  }
  if (stage === 'invoice_created') {
    return {
      invoiceNumber: String(payload.invoiceNumber || consignment.forwardInvoiceNo || '').trim(),
      invoiceDate: payload.invoiceDate || null,
      invoiceAmount: payload.invoiceAmount != null ? Number(payload.invoiceAmount) : null,
      invoiceDocumentId: payload.invoiceDocumentId || consignment.invoiceDocumentId || null,
    };
  }
  if (stage === 'dispatched') {
    const packed = Number(consignment.totalPackedQty) || 0;
    return {
      docketNo: String(payload.docketNo || consignment.docketNo || '').trim(),
      docketCompany: String(payload.docketCompany || consignment.docketCompany || '').trim(),
      dispatchDate: payload.dispatchDate || new Date().toISOString().slice(0, 10),
      boxCount: payload.boxCount != null ? Number(payload.boxCount) : (consignment.boxCount || null),
      dispatchedQty: payload.dispatchedQty != null ? Number(payload.dispatchedQty) : packed,
      docketDocumentId: payload.docketDocumentId || null,
    };
  }
  if (stage === 'inward_completed') {
    const dispatchedQty = Number(
      payload.dispatchedQty
      ?? consignment.dispatchDetails?.dispatchedQty
      ?? consignment.totalPackedQty
      ?? 0
    );
    const inwardQty = Number(payload.inwardQty ?? 0);
    return {
      dispatchedQty,
      receivedQty: inwardQty,
      pendingQty: Math.max(0, dispatchedQty - inwardQty),
      varianceQty: inwardQty - dispatchedQty,
      inwardDate: payload.inwardDate || new Date().toISOString().slice(0, 10),
      inwardStatus: inwardQty === dispatchedQty
        ? 'matched'
        : (inwardQty < dispatchedQty ? 'short' : 'excess'),
      varianceReason: String(payload.inwardVarianceReason || '').trim() || null,
      disputeDetails: String(payload.disputeDetails || '').trim() || null,
    };
  }
  return payload.details || null;
}

function applyStageConfirmation(consignment, stage, user, note = null, payload = {}) {
  const gate = canConfirmStage(consignment, stage, payload);
  if (!gate.ok) return { ok: false, ...gate };

  const details = buildStageDetails(stage, consignment, payload);
  const stageConfirmations = normalizeStageConfirmations(consignment.stageConfirmations);
  const confirmedAt = new Date().toISOString();
  stageConfirmations[stage] = {
    confirmedAt,
    confirmedByUserId: user?.id || null,
    confirmedByName: user?.name || user?.email || null,
    note: note || payload.note || null,
    details,
  };

  // Auto-advance machine stages that do not need a separate human click
  const autoStages = [];
  if (stage === 'packing_completed' && !stageConfirmations.ready_for_invoice?.confirmedAt) {
    stageConfirmations.ready_for_invoice = {
      confirmedAt,
      confirmedByUserId: 'system',
      confirmedByName: 'System',
      note: 'Auto-advanced after packing completed — assigned to Invoice Creation Team',
      details: { auto: true },
    };
    autoStages.push('ready_for_invoice');
  }
  if (stage === 'invoice_created' && !stageConfirmations.ready_for_dispatch?.confirmedAt) {
    stageConfirmations.ready_for_dispatch = {
      confirmedAt,
      confirmedByUserId: 'system',
      confirmedByName: 'System',
      note: 'Auto-advanced after invoice completed — ready for dispatch team',
      details: { auto: true },
    };
    autoStages.push('ready_for_dispatch');
  }

  const nextConsignment = { ...consignment, stageConfirmations };
  const updates = {
    stageConfirmations,
    tatDeadlines: refreshTatFromStage(consignment, stage),
    currentWorkflowStage: getCurrentWorkflowStage(nextConsignment),
    pendingAction: getPendingActionLabel(nextConsignment),
    updatedAt: confirmedAt,
    assignedDepartment: null,
  };

  if (stage === 'packing_completed') {
    updates.workflowPackingConfirmedAt = confirmedAt;
    updates.packingCompletion = {
      ...details,
      completedByUserId: user?.id || null,
      completedByName: user?.name || user?.email || null,
      completedAt: confirmedAt,
    };
    if (details.shortQty > 0) {
      updates.status = 'completed'; // operational packing closed for short-dispatch path
    } else if (isPackingPhysicallyDone(consignment)) {
      updates.status = 'completed';
    }
  }

  if (stage === 'invoice_created') {
    updates.forwardInvoiceNo = details.invoiceNumber;
    updates.invoice = {
      number: details.invoiceNumber,
      date: details.invoiceDate,
      amount: details.invoiceAmount,
      documentId: details.invoiceDocumentId,
      uploadedByUserId: user?.id || null,
      uploadedByName: user?.name || user?.email || null,
      uploadedAt: confirmedAt,
    };
    updates.invoiceDocumentId = details.invoiceDocumentId;
    updates.invoiceUploadedAt = confirmedAt;
  }

  if (autoStages.includes('ready_for_dispatch') || stage === 'ready_for_dispatch') {
    updates.shipmentStatus = 'Ready';
  }

  if (stage === 'dispatched') {
    updates.shipmentStatus = 'In Transit';
    updates.docketNo = details.docketNo;
    updates.docketCompany = details.docketCompany;
    updates.actualDispatchDate = details.dispatchDate;
    updates.dispatchDetails = {
      ...details,
      completedByUserId: user?.id || null,
      completedByName: user?.name || user?.email || null,
      completedAt: confirmedAt,
    };
    updates.unitsShipped = details.dispatchedQty;
  }

  if (stage === 'inward_completed') {
    updates.dateOfInward = details.inwardDate;
    updates.unitsInwarded = details.receivedQty;
    updates.unitsReceived = details.receivedQty;
    updates.inwardDetails = {
      ...details,
      completedByUserId: user?.id || null,
      completedByName: user?.name || user?.email || null,
      completedAt: confirmedAt,
    };
    // Auto-archive when inward matches (or variance accepted)
    updates.operationalStatus = 'archived';
    updates.isArchived = true;
    updates.archivedAt = confirmedAt;
    updates.archivedReason = details.inwardStatus === 'matched'
      ? 'Inward quantity verified — moved to archive'
      : 'Inward completed with recorded variance — moved to archive';
  }

  const assignDept = NEXT_ASSIGNMENT_DEPARTMENT[stage];
  if (assignDept) {
    updates.assignedDepartment = assignDept;
    updates.assignedDepartmentLabel = departmentLabel(assignDept);
    updates.departmentAssignedAt = confirmedAt;
  }

  if (consignment.isEscalated) {
    updates.isEscalated = false;
    updates.escalationLevel = 0;
    updates.escalationReason = null;
  }

  // Recompute labels after auto-stages
  const finalSnap = { ...consignment, ...updates, stageConfirmations };
  updates.currentWorkflowStage = getCurrentWorkflowStage(finalSnap);
  updates.pendingAction = getPendingActionLabel(finalSnap);

  return {
    ok: true,
    updates,
    autoStages,
    assignDepartment: assignDept || null,
  };
}

/**
 * Human-readable next action for list / emails.
 */
function getPendingActionLabel(consignment) {
  if (consignment?.operationalStatus === 'archived' || consignment?.isArchived) {
    return null;
  }
  const stage = getCurrentWorkflowStage(consignment);
  if (!stage || stage === 'completed' || stage === 'archived') return null;

  if (stage === 'packing_completed') {
    if (isPackingPhysicallyDone(consignment)) {
      return 'Confirm packing completed';
    }
    const packed = Number(consignment?.totalPackedQty) || 0;
    const status = consignment?.status || 'pending';
    if (status === 'in_progress' || packed > 0) {
      return 'Finish packing (or confirm short packing)';
    }
    return 'Packing not started';
  }

  if (stage === 'invoice_created') return 'Upload invoice & mark invoice completed';
  if (stage === 'dispatched') return 'Enter docket details & mark dispatched';
  if (stage === 'inward_completed') return 'Record inward quantities';

  return STAGE_LABELS[stage] || null;
}

function enrichWorkflowFields(consignment) {
  if (!consignment) return consignment;
  const stageConfirmations = normalizeStageConfirmations(consignment.stageConfirmations);
  const withStages = { ...consignment, stageConfirmations };
  const currentWorkflowStage = getCurrentWorkflowStage(withStages);
  const overdueStages = getOverdueStages(withStages);
  const listPriorityBucket = getListPriorityBucket(withStages);
  const packing = getPackingTotals(withStages);
  return {
    ...consignment,
    stageConfirmations,
    currentWorkflowStage,
    currentWorkflowStageLabel: currentWorkflowStage === 'archived'
      ? 'Archived'
      : (STAGE_LABELS[currentWorkflowStage] || 'Complete'),
    pendingAction: getPendingActionLabel(withStages),
    overdueStages,
    isTatOverdue: overdueStages.length > 0,
    listPriorityBucket,
    listPriorityRank: LIST_BUCKETS[listPriorityBucket],
    isArchived: Boolean(consignment.operationalStatus === 'archived' || consignment.isArchived),
    operationalStatus: consignment.operationalStatus || (consignment.isArchived ? 'archived' : 'active'),
    packingTotals: packing,
    assignedDepartment: consignment.assignedDepartment || null,
    assignedDepartmentLabel: consignment.assignedDepartmentLabel
      || departmentLabel(consignment.assignedDepartment)
      || null,
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
    if (bucket === 'inward_pending' || bucket === 'shipped') dispatched += 1;
    if (bucket === 'inwarded' || bucket === 'archived') inwarded += 1;
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

function canArchiveConsignment(consignment) {
  if (consignment?.operationalStatus === 'archived' || consignment?.isArchived) {
    return { ok: false, error: 'Already archived.', code: 'ALREADY_ARCHIVED' };
  }
  if (isStageConfirmed(consignment, 'inward_completed')) {
    return { ok: true };
  }
  if (consignment?.dateOfInward && isStageConfirmed(consignment, 'dispatched')) {
    return { ok: true, reason: 'legacy_inward_date' };
  }
  return {
    ok: false,
    error: 'Complete inward tracking before archiving.',
    code: 'INWARD_REQUIRED',
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
  getPackingTotals,
  hasInvoiceDocument,
  canArchiveConsignment,
  buildWeeklyReportSummary,
  normalizeDepartment,
};
