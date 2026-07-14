const { firestoreHelpers, now } = require('./helpers');

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

async function reassignConsignmentId(oldId, newId, userId) {
  const trimmedNew = String(newId || '').trim();
  if (!trimmedNew || trimmedNew === oldId) {
    return { ok: false, error: 'New consignment ID is required and must differ from the current ID.' };
  }

  const existing = await firestoreHelpers.getDocument('consignments', oldId);
  if (!existing) return { ok: false, error: 'Consignment not found.' };

  const conflict = await firestoreHelpers.getDocument('consignments', trimmedNew);
  if (conflict) return { ok: false, error: 'Target consignment ID already exists.' };

  const updatedConsignment = {
    ...existing,
    id: trimmedNew,
    pendingExternalId: false,
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

  return { ok: true, consignment: updatedConsignment, oldId, newId: trimmedNew };
}

module.exports = {
  reassignConsignmentId,
};
