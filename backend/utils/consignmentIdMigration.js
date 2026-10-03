const { firestoreHelpers, now } = require('./helpers');
const { pgEnabled, getPool } = require('../config/database');
const {
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
} = require('./resolveConsignment');

const RELATED_COLLECTIONS = [
  'skus',
  'boxes',
  'videos',
  'documents',
  'scan_events',
  'productivity_events',
  'packing_sync_jobs',
  'shipment_documents',
];

async function reassignConsignmentId(oldId, newId, userId, extra = {}) {
  const trimmedNew = String(newId || '').trim();
  if (!trimmedNew || trimmedNew === oldId) {
    return { ok: false, error: 'New consignment ID is required and must differ from the current ID.' };
  }

  const existing = await firestoreHelpers.getDocument('consignments', oldId);
  if (!existing) return { ok: false, error: 'Consignment not found.' };

  const conflict = await findConsignmentIdentityConflict({
    keys: [trimmedNew],
    excludeId: oldId,
  });
  if (conflict) {
    return { ok: false, error: formatIdentityConflictError(conflict) };
  }

  const updatedConsignment = {
    ...existing,
    ...(extra.fields || {}),
    id: trimmedNew,
    pendingExternalId: extra.fields && Object.prototype.hasOwnProperty.call(extra.fields, 'pendingExternalId')
      ? extra.fields.pendingExternalId
      : false,
    updatedAt: now(),
    updatedBy: userId,
  };

  await firestoreHelpers.setDocument('consignments', trimmedNew, updatedConsignment);
  await firestoreHelpers.deleteDocument('consignments', oldId);

  for (const collection of RELATED_COLLECTIONS) {
    const records = await firestoreHelpers.queryCollection(collection, 'consignmentId', '==', oldId);
    for (const record of records) {
      if (!record?.id) continue;
      await firestoreHelpers.setDocument(collection, record.id, {
        ...record,
        consignmentId: trimmedNew,
        updatedAt: now(),
      });
    }
  }

  const packingDraft = await firestoreHelpers.getDocument('packing_drafts', oldId);
  if (packingDraft) {
    await firestoreHelpers.setDocument('packing_drafts', trimmedNew, {
      ...packingDraft,
      consignmentId: trimmedNew,
      updatedAt: now(),
    });
    await firestoreHelpers.deleteDocument('packing_drafts', oldId);
  }

  if (pgEnabled()) {
    try {
      await getPool().query('DELETE FROM consignments WHERE id = $1', [oldId]);
    } catch (error) {
      console.warn('[Consignments] old consignment index row cleanup failed:', error.message);
    }
  }

  return { ok: true, consignment: updatedConsignment, oldId, newId: trimmedNew };
}

module.exports = {
  reassignConsignmentId,
};
