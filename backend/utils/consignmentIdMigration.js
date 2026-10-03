const { firestoreHelpers, now } = require('./helpers');
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

async function reassignConsignmentId(oldId, newId, userId) {
  const trimmedNew = String(newId || '').trim();
  if (!trimmedNew) {
    return { ok: false, error: 'New consignment ID is required.' };
  }

  const existing = await firestoreHelpers.getDocument('consignments', oldId);
  if (!existing) return { ok: false, error: 'Consignment not found.' };

  // Check if trimmedNew is already used as a document ID by another consignment
  const existingWithDocId = trimmedNew !== oldId
    ? await firestoreHelpers.getDocument('consignments', trimmedNew)
    : null;

  if (existingWithDocId && existingWithDocId.id !== oldId) {
    // Another consignment already has this ID as its primary document ID.
    // Instead of failing or colliding with the primary key, we keep this consignment's
    // unique document ID and set its consignmentNo/shipmentNo to the requested ID.
    const updatedConsignment = {
      ...existing,
      consignmentNo: trimmedNew,
      shipmentNo: trimmedNew,
      pendingExternalId: false,
      updatedAt: now(),
      updatedBy: userId,
    };
    await firestoreHelpers.setDocument('consignments', oldId, updatedConsignment);
    return { ok: true, consignment: updatedConsignment, oldId, newId: oldId };
  }

  // If new ID is the same document ID, just ensure consignmentNo is updated
  if (trimmedNew === oldId) {
    const updatedConsignment = {
      ...existing,
      consignmentNo: trimmedNew,
      shipmentNo: trimmedNew,
      pendingExternalId: false,
      updatedAt: now(),
      updatedBy: userId,
    };
    await firestoreHelpers.setDocument('consignments', oldId, updatedConsignment);
    return { ok: true, consignment: updatedConsignment, oldId, newId: oldId };
  }

  const updatedConsignment = {
    ...existing,
    id: trimmedNew,
    consignmentNo: trimmedNew,
    shipmentNo: trimmedNew,
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
