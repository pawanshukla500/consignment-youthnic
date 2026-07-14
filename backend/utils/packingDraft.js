/**
 * Durable packing-session drafts — scans survive backend restarts.
 * Draft writes are debounced during high-frequency scanning; flush before save-box/finish.
 */
const { firestoreHelpers, now } = require('./helpers');
const { rebuildSessionSkuTotalsFromBoxes } = require('./packingQuantities');

const draftTimers = new Map();

async function loadDraft(consignmentId) {
  if (!consignmentId) return null;
  return firestoreHelpers.getDocument('packing_drafts', consignmentId);
}

async function saveDraft(consignmentId, session, userId, options = {}) {
  if (!consignmentId || !session) return;
  // Persist box/SKU state + scan ids only. Full scanResults payloads grow O(n) per
  // scan and are reconstructible from scan_events for idempotency after restart.
  await firestoreHelpers.setDocument('packing_drafts', consignmentId, {
    consignmentId,
    boxes: session.boxes || {},
    skus: (session.skus || []).map((s) => ({
      id: s.id,
      packed: s.packed,
      remaining: s.remaining,
      status: s.status,
    })),
    processedScanIds: session.processedScanIds || [],
    updatedAt: now(),
    userId: userId || '',
  }, options.client ? { client: options.client } : undefined);
}

const DRAFT_DEBOUNCE_MS = 450;

/** Debounced draft save during rapid scanning — call flushDraftSave before save-box/finish. */
function scheduleDraftSave(consignmentId, session, userId) {
  if (!consignmentId || !session) return;
  const pending = draftTimers.get(consignmentId);
  if (pending?.timer) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    draftTimers.delete(consignmentId);
    saveDraft(consignmentId, session, userId).catch((e) => {
      console.warn('[PackingDraft] debounced save failed:', e.message);
    });
  }, DRAFT_DEBOUNCE_MS);
  draftTimers.set(consignmentId, { timer, session, userId });
}

/** Immediately persist draft (call before save-box / finish / session end). */
async function flushDraftSave(consignmentId, session, userId, options = {}) {
  const pending = draftTimers.get(consignmentId);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    draftTimers.delete(consignmentId);
    session = pending.session || session;
    userId = pending.userId || userId;
  }
  await saveDraft(consignmentId, session, userId, options);
}

async function clearDraft(consignmentId) {
  if (!consignmentId) return;
  const pending = draftTimers.get(consignmentId);
  if (pending?.timer) {
    clearTimeout(pending.timer);
    draftTimers.delete(consignmentId);
  }
  try {
    await firestoreHelpers.deleteDocument('packing_drafts', consignmentId);
  } catch (e) {
    console.warn('[PackingDraft] clear failed:', e.message);
  }
}

/** Merge a persisted draft into the in-memory session (unsaved box work).
 *  Never overwrite a saved box that was updated after the draft (e.g. quantity removal). */
function applyDraftToSession(session, draft) {
  if (!draft) return session;
  if (draft.boxes) {
    const draftAt = draft.updatedAt ? new Date(draft.updatedAt).getTime() : 0;
    if (!session.boxUpdatedAt) session.boxUpdatedAt = {};
    for (const [boxNo, items] of Object.entries(draft.boxes)) {
      if (!items?.length) continue;
      const savedAtRaw = session.boxUpdatedAt[boxNo];
      const savedAt = savedAtRaw ? new Date(savedAtRaw).getTime() : 0;
      // Saved box newer than draft → keep saved (post-removal / edit)
      if (session.boxes[boxNo]?.length && savedAt && draftAt && savedAt > draftAt) {
        continue;
      }
      session.boxes[boxNo] = items;
    }
  }
  rebuildSessionSkuTotalsFromBoxes(session);
  session.processedScanIds = draft.processedScanIds || [];
  session.scanResults = session.scanResults || {};
  return session;
}

module.exports = {
  loadDraft,
  saveDraft,
  scheduleDraftSave,
  flushDraftSave,
  clearDraft,
  applyDraftToSession,
};
