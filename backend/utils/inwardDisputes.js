/**
 * Inward discrepancy disputes.
 *
 * When inward tracking is confirmed and the marketplace-confirmed inward qty
 * does not match what was shipped (short or excess), the consignment must not
 * auto-archive. Instead it opens a tracked dispute: shipped/inward/disputed
 * qty, a marketplace Ticket / Case ID, and — once genuinely resolved — a
 * resolution type + mandatory remark. Only when every dispute on a
 * consignment is resolved can it move to Archive.
 *
 * These are pure functions operating on a consignment's `inwardDisputes`
 * array — no I/O here. Routes own persistence, notifications, and audit log.
 */

const { generateId, now } = require('./helpers');

const DISPUTE_RESOLUTION_TYPES = Object.freeze({
  our_mistake: 'Our Mistake / Scanning Error',
  reimbursement_received: 'Reimbursement Received',
  marketplace_resolved: 'Marketplace Issue Resolved',
  external_issue: 'External / Outside Issue',
  inventory_adjusted: 'Inventory Found / Adjusted',
  other: 'Other',
});

function isValidResolutionType(type) {
  return Object.prototype.hasOwnProperty.call(DISPUTE_RESOLUTION_TYPES, String(type || ''));
}

function getAllDisputes(consignment) {
  return Array.isArray(consignment?.inwardDisputes) ? consignment.inwardDisputes : [];
}

function getOpenDisputes(consignment) {
  return getAllDisputes(consignment).filter((d) => d?.status === 'open');
}

function hasOpenDispute(consignment) {
  return getOpenDisputes(consignment).length > 0;
}

/**
 * Build a new open dispute from an inward-tracking variance. Caller (workflow
 * confirm-stage) supplies the already-computed shipped/inward qty and the
 * variance/dispute text the operator entered.
 */
function buildOpenDispute({ shippedQty, inwardQty, reason, disputeDetails, user }) {
  const shipped = Number(shippedQty) || 0;
  const inward = Number(inwardQty) || 0;
  const disputedQty = Math.abs(shipped - inward);
  const raisedAt = now();
  return {
    id: generateId(),
    status: 'open',
    shippedQty: shipped,
    inwardQty: inward,
    disputedQty,
    varianceType: inward < shipped ? 'short' : 'excess',
    reason: String(reason || '').trim() || null,
    disputeDetails: String(disputeDetails || '').trim() || null,
    raisedAt,
    raisedByUserId: user?.id || null,
    raisedByName: user?.name || user?.email || null,
    ticketId: null,
    ticketRaisedAt: null,
    ticketRaisedByUserId: null,
    ticketRaisedByName: null,
    lastReminderSentAt: null,
    reminderCount: 0,
    resolution: null,
  };
}

/**
 * Record (or update) the marketplace Ticket / Case ID against an open dispute.
 * Returns { ok, disputes } or { ok: false, error, code }.
 */
function recordDisputeTicket(consignment, disputeId, { ticketId, user } = {}) {
  const trimmed = String(ticketId || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Ticket / Case ID is required.', code: 'TICKET_ID_REQUIRED' };
  }
  const disputes = getAllDisputes(consignment);
  const idx = disputes.findIndex((d) => d.id === disputeId);
  if (idx < 0) {
    return { ok: false, error: 'Dispute not found.', code: 'DISPUTE_NOT_FOUND' };
  }
  if (disputes[idx].status !== 'open') {
    return { ok: false, error: 'Dispute is already resolved.', code: 'DISPUTE_ALREADY_RESOLVED' };
  }
  const next = [...disputes];
  next[idx] = {
    ...next[idx],
    ticketId: trimmed,
    ticketRaisedAt: now(),
    ticketRaisedByUserId: user?.id || null,
    ticketRaisedByName: user?.name || user?.email || null,
  };
  return { ok: true, disputes: next, dispute: next[idx] };
}

/**
 * Resolve an open dispute. resolutionType must be one of
 * DISPUTE_RESOLUTION_TYPES; remark is mandatory for every type (not just
 * "Other") — it is the audit trail for how the discrepancy was closed out.
 * Returns { ok, disputes, dispute, allResolved } or { ok:false, error, code }.
 */
function resolveDispute(consignment, disputeId, { resolutionType, remark, user } = {}) {
  if (!isValidResolutionType(resolutionType)) {
    return {
      ok: false,
      error: 'A valid resolution type is required.',
      code: 'RESOLUTION_TYPE_REQUIRED',
      validTypes: DISPUTE_RESOLUTION_TYPES,
    };
  }
  const trimmedRemark = String(remark || '').trim();
  if (!trimmedRemark) {
    return {
      ok: false,
      error: 'A remark explaining how the issue was resolved is required.',
      code: 'RESOLUTION_REMARK_REQUIRED',
    };
  }
  const disputes = getAllDisputes(consignment);
  const idx = disputes.findIndex((d) => d.id === disputeId);
  if (idx < 0) {
    return { ok: false, error: 'Dispute not found.', code: 'DISPUTE_NOT_FOUND' };
  }
  if (disputes[idx].status !== 'open') {
    return { ok: false, error: 'Dispute is already resolved.', code: 'DISPUTE_ALREADY_RESOLVED' };
  }
  const resolvedAt = now();
  const next = [...disputes];
  next[idx] = {
    ...next[idx],
    status: 'resolved',
    resolution: {
      type: resolutionType,
      remark: trimmedRemark,
      resolvedAt,
      resolvedByUserId: user?.id || null,
      resolvedByName: user?.name || user?.email || null,
    },
  };
  const allResolved = next.every((d) => d.status !== 'open');
  return { ok: true, disputes: next, dispute: next[idx], allResolved };
}

module.exports = {
  DISPUTE_RESOLUTION_TYPES,
  isValidResolutionType,
  getAllDisputes,
  getOpenDisputes,
  hasOpenDispute,
  buildOpenDispute,
  recordDisputeTicket,
  resolveDispute,
};
