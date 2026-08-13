/**
 * Post-packing quantity adjustments (removals / history).
 * Original box pack records stay intact; live box.items.qty reflect final quantities.
 */

const { generateId, now, addAuditLog, firestoreHelpers } = require('./helpers');
const { rebuildSessionSkuTotalsFromBoxes } = require('./packingQuantities');
const { getQuantityReductionUpdates } = require('./shipmentStatus');
const { emitConsignmentChange } = require('./syncBus');
const { getPool, pgEnabled } = require('../config/database');
const { upsertDocument } = require('./packingPersistence');

const COLLECTION = 'packing_adjustments';

const REMOVAL_REASONS = [
  { value: 'stock_issue', label: 'Stock issue' },
  { value: 'quality', label: 'Quality problem' },
  { value: 'cancellation', label: 'Cancellation' },
  { value: 'damage', label: 'Damage' },
  { value: 'invoice_change', label: 'Invoice change' },
  { value: 'warehouse_instruction', label: 'Warehouse instruction' },
  { value: 'other', label: 'Other operational reason' },
];

function isInvoiceGenerated(consignment) {
  if (!consignment) return false;
  if (String(consignment.forwardInvoiceNo || '').trim()) return true;
  return Boolean(consignment.stageConfirmations?.invoice_created?.confirmedAt);
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function listAdjustmentsForConsignment(consignmentId) {
  const rows = await firestoreHelpers.queryCollection(COLLECTION, 'consignmentId', '==', consignmentId);
  return (rows || []).filter(Boolean).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

async function listAdjustmentsForBox(consignmentId, boxNo) {
  const all = await listAdjustmentsForConsignment(consignmentId);
  const box = String(boxNo);
  return all.filter((row) => String(row.boxNo) === box);
}

async function findByClientRequestId(consignmentId, clientRequestId) {
  if (!clientRequestId) return null;
  const all = await listAdjustmentsForConsignment(consignmentId);
  return all.find((row) => String(row.clientRequestId || '') === String(clientRequestId)) || null;
}

function summarizeBoxHistory(box, adjustments = []) {
  const currentTotal = (box?.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const completed = adjustments.filter((a) => a.status === 'completed');
  const removedLater = completed
    .filter((a) => a.actionType === 'remove' || (a.actionType === 'edit' && Number(a.difference) < 0))
    .reduce((sum, a) => sum + (Number(a.quantity) || Math.abs(Number(a.difference) || 0)), 0);
  const addedLater = completed
    .filter((a) => a.actionType === 'add' || (a.actionType === 'edit' && Number(a.difference) > 0))
    .reduce((sum, a) => sum + (Number(a.quantity) || Math.abs(Number(a.difference) || 0)), 0);
  const originallyPacked = Number(box?.originalTotalQty);
  const original = Number.isFinite(originallyPacked) && originallyPacked > 0
    ? originallyPacked
    : Math.max(0, currentTotal - addedLater + removedLater);

  const omsStatuses = completed.map((a) => a.omsAdjustmentStatus).filter(Boolean);
  let omsAdjustment = 'Pending';
  if (omsStatuses.length && omsStatuses.every((s) => s === 'completed')) omsAdjustment = 'Completed';
  else if (omsStatuses.some((s) => s === 'pending')) omsAdjustment = 'Pending';

  return {
    boxNo: String(box?.boxNo || ''),
    originallyPacked: original,
    addedLater,
    removedLater,
    finalQuantity: currentTotal,
    originalPackingVideosAvailable: true,
    removalVideosAvailable: completed.some((a) => a.videoId),
    omsAdjustment,
    entries: adjustments.map((a) => ({
      id: a.id,
      skuId: a.skuId,
      internalSku: a.internalSku,
      marketplaceSku: a.marketplaceSku,
      barcode: a.barcode,
      quantity: a.quantity,
      actionType: a.actionType,
      reason: a.reason,
      reasonLabel: a.reasonLabel,
      remarks: a.remarks,
      userId: a.removedBy || a.userId,
      userName: a.removedByName || a.userName,
      at: a.completedAt || a.createdAt,
      videoId: a.videoId || null,
      status: a.status,
      approvalStatus: a.approvalStatus || 'not_required',
      omsAdjustmentStatus: a.omsAdjustmentStatus || 'pending',
      originalPackedQty: a.originalPackedQty,
      finalQty: a.finalQty,
    })),
  };
}

async function createPendingRemoval({
  consignment,
  box,
  skuId,
  quantity,
  reason,
  remarks,
  user,
  clientRequestId,
}) {
  const removeQty = parsePositiveInt(quantity);
  if (!removeQty) {
    const error = new Error('Quantity to remove must be a positive whole number');
    error.statusCode = 400;
    error.code = 'INVALID_REMOVAL_QTY';
    throw error;
  }

  const reasonMeta = REMOVAL_REASONS.find((r) => r.value === reason);
  if (!reasonMeta) {
    const error = new Error('A valid removal reason is required');
    error.statusCode = 400;
    error.code = 'INVALID_REMOVAL_REASON';
    throw error;
  }

  if (reasonMeta.value === 'other' && !String(remarks || '').trim()) {
    const error = new Error('Remarks are required when reason is Other');
    error.statusCode = 400;
    error.code = 'REMARKS_REQUIRED';
    throw error;
  }

  if (clientRequestId) {
    const existing = await findByClientRequestId(consignment.id, clientRequestId);
    if (existing) return { adjustment: existing, deduped: true };
  }

  const item = (box.items || []).find((i) => String(i.skuId) === String(skuId));
  if (!item) {
    const error = new Error('Selected SKU is not packed in this box');
    error.statusCode = 400;
    error.code = 'SKU_NOT_IN_BOX';
    throw error;
  }

  const originalPackedQty = Number(item.qty) || 0;
  if (removeQty > originalPackedQty) {
    const error = new Error(`Cannot remove ${removeQty}; only ${originalPackedQty} packed for this SKU in the box`);
    error.statusCode = 400;
    error.code = 'REMOVAL_EXCEEDS_PACKED';
    throw error;
  }

  const invoiceAlreadyGenerated = isInvoiceGenerated(consignment);
  const timestamp = now();
  const adjustment = {
    id: generateId(),
    consignmentId: consignment.id,
    internalShipmentNo: consignment.internalShipmentNo || consignment.id,
    boxNo: String(box.boxNo),
    boxId: box.id,
    skuId: item.skuId,
    internalSku: item.internalSku || '',
    marketplaceSku: item.marketplaceSku || '',
    barcode: item.barcode || item.marketplaceBarcode || '',
    actionType: 'remove',
    originalPackedQty,
    quantity: removeQty,
    finalQty: originalPackedQty - removeQty,
    reason: reasonMeta.value,
    reasonLabel: reasonMeta.label,
    remarks: String(remarks || '').trim(),
    status: 'pending_video',
    videoId: null,
    videoStatus: 'required',
    removedBy: user.id,
    removedByName: user.name || user.email || '',
    removedAt: null,
    completedAt: null,
    approvalStatus: invoiceAlreadyGenerated ? 'required' : 'not_required',
    invoiceAlreadyGenerated,
    invoiceCorrectionRequired: invoiceAlreadyGenerated,
    omsAdjustmentStatus: 'pending',
    clientRequestId: clientRequestId || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await firestoreHelpers.setDocument(COLLECTION, adjustment.id, adjustment);
  await addAuditLog('quantity_removal_pending', 'packing_adjustment', adjustment.id, user.id, {
    consignmentId: consignment.id,
    boxNo: adjustment.boxNo,
    skuId: adjustment.skuId,
    quantity: removeQty,
    reason: reasonMeta.value,
  });

  return { adjustment, deduped: false };
}

async function attachRemovalVideo(adjustmentId, { videoId, userId }) {
  const adjustment = await firestoreHelpers.getDocument(COLLECTION, adjustmentId);
  if (!adjustment) {
    const error = new Error('Removal transaction not found');
    error.statusCode = 404;
    throw error;
  }
  if (adjustment.status === 'completed') {
    return adjustment;
  }
  if (!videoId) {
    const error = new Error('Removal video is required');
    error.statusCode = 400;
    error.code = 'REMOVAL_VIDEO_REQUIRED';
    throw error;
  }

  const updated = {
    ...adjustment,
    videoId,
    videoStatus: 'uploaded',
    status: 'pending_finalize',
    updatedAt: now(),
  };
  await firestoreHelpers.setDocument(COLLECTION, adjustmentId, {
    videoId,
    videoStatus: 'uploaded',
    status: 'pending_finalize',
    updatedAt: updated.updatedAt,
  });
  await addAuditLog('quantity_removal_video_attached', 'packing_adjustment', adjustmentId, userId, {
    videoId,
  });
  return updated;
}

async function finalizeRemoval(adjustmentId, { user, session } = {}) {
  const adjustment = await firestoreHelpers.getDocument(COLLECTION, adjustmentId);
  if (!adjustment) {
    const error = new Error('Removal transaction not found');
    error.statusCode = 404;
    throw error;
  }
  if (adjustment.status === 'completed') {
    return { adjustment, alreadyCompleted: true };
  }
  if (!adjustment.videoId || adjustment.videoStatus !== 'uploaded') {
    const error = new Error('Removal video must upload successfully before confirming');
    error.statusCode = 409;
    error.code = 'REMOVAL_VIDEO_PENDING';
    throw error;
  }

  const consignment = await firestoreHelpers.getDocument('consignments', adjustment.consignmentId);
  if (!consignment) {
    const error = new Error('Consignment not found');
    error.statusCode = 404;
    throw error;
  }

  const boxId = adjustment.boxId || `${adjustment.consignmentId}_box_${adjustment.boxNo}`;
  const box = await firestoreHelpers.getDocument('boxes', boxId);
  if (!box) {
    const error = new Error('Box not found');
    error.statusCode = 404;
    throw error;
  }

  const items = (box.items || []).map((item) => ({ ...item }));
  const itemIndex = items.findIndex((i) => String(i.skuId) === String(adjustment.skuId));
  if (itemIndex < 0) {
    const error = new Error('Selected SKU is no longer in this box');
    error.statusCode = 409;
    error.code = 'SKU_NOT_IN_BOX';
    throw error;
  }

  const currentQty = Number(items[itemIndex].qty) || 0;
  const removeQty = Number(adjustment.quantity) || 0;
  if (removeQty > currentQty) {
    const error = new Error(`Cannot remove ${removeQty}; only ${currentQty} remaining in the box`);
    error.statusCode = 409;
    error.code = 'REMOVAL_EXCEEDS_PACKED';
    throw error;
  }

  const finalQty = currentQty - removeQty;
  if (finalQty <= 0) items.splice(itemIndex, 1);
  else items[itemIndex] = { ...items[itemIndex], qty: finalQty };

  const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const timestamp = now();
  const originalTotalQty = Number(box.originalTotalQty) > 0
    ? Number(box.originalTotalQty)
    : (Number(box.totalQty) || currentQty);

  const boxUpdate = {
    items,
    totalQty,
    originalTotalQty,
    removedTotalQty: (Number(box.removedTotalQty) || 0) + removeQty,
    updatedAt: timestamp,
  };
  await firestoreHelpers.setDocument('boxes', boxId, boxUpdate);

  // Rebuild SKU packed totals from all boxes (boxIds + query — avoid missing boxes)
  const allBoxesRaw = await loadAllBoxesForConsignment(consignment);
  const validBoxes = allBoxesRaw.map((b) => (b.id === boxId ? { ...b, ...boxUpdate } : b));

  const packedBySku = {};
  for (const b of validBoxes) {
    for (const item of b.items || []) {
      if (!item.skuId) continue;
      if (!packedBySku[item.skuId]) packedBySku[item.skuId] = {};
      packedBySku[item.skuId][b.boxNo] = (packedBySku[item.skuId][b.boxNo] || 0) + (Number(item.qty) || 0);
    }
  }

  const skuIds = consignment.skuIds || [];
  const skus = (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean);
  for (const sku of skus) {
    const boxQuantities = packedBySku[sku.id] || {};
    const packed = Object.values(boxQuantities).reduce((a, b) => a + b, 0);
    const required = Number(sku.requiredQty) || 0;
    const status = required > 0 && packed >= required ? 'completed' : 'pending';
    const inwardQty = Number(sku.inwardQty) || 0;
    const { computeInwardStatus, computeQuantityDifference } = require('./inwardSku');
    await firestoreHelpers.setDocument('skus', sku.id, {
      packedQty: packed,
      boxQuantities,
      status,
      ...(sku.inwardQty != null || inwardQty > 0 ? {
        quantityDifference: computeQuantityDifference(packed, inwardQty),
        inwardStatus: computeInwardStatus(packed, inwardQty),
      } : {}),
      updatedAt: timestamp,
    });
    sku.packedQty = packed;
    sku.status = status;
  }

  const totalPackedQty = skus.reduce((sum, s) => sum + (Number(s.packedQty) || 0), 0);
  const totalRequiredQty = skus.reduce((sum, s) => sum + (Number(s.requiredQty) || 0), 0);
  const allCompleted = skus.length > 0 && skus.every((s) => s.status === 'completed');
  const statusUpdates = getQuantityReductionUpdates(consignment, allCompleted) || {
    status: allCompleted ? 'completed' : 'in_progress',
    updatedAt: timestamp,
  };

  const invoiceAlreadyGenerated = isInvoiceGenerated(consignment) || adjustment.invoiceAlreadyGenerated;
  const consignmentUpdate = {
    totalPackedQty,
    totalRequiredQty,
    ...statusUpdates,
    updatedAt: timestamp,
  };

  if (invoiceAlreadyGenerated) {
    consignmentUpdate.quantityRemovalNeedsInvoiceCorrection = true;
    consignmentUpdate.invoiceQtyMismatch = true;
    consignmentUpdate.dispatchBlockedForInvoiceMismatch = true;
    consignmentUpdate.quantityRemovalFlaggedAt = timestamp;
    consignmentUpdate.omsGuruQtyRemoved = false;
  } else {
    consignmentUpdate.omsGuruQtyRemoved = false;
  }

  await firestoreHelpers.setDocument('consignments', adjustment.consignmentId, consignmentUpdate);

  const completedAdjustment = {
    ...adjustment,
    status: 'completed',
    originalPackedQty: currentQty,
    finalQty,
    completedAt: timestamp,
    removedAt: timestamp,
    invoiceAlreadyGenerated,
    invoiceCorrectionRequired: invoiceAlreadyGenerated,
    approvalStatus: invoiceAlreadyGenerated ? 'required' : 'not_required',
    omsAdjustmentStatus: 'pending',
    updatedAt: timestamp,
  };
  await firestoreHelpers.setDocument(COLLECTION, adjustmentId, {
    status: 'completed',
    originalPackedQty: currentQty,
    finalQty,
    completedAt: timestamp,
    removedAt: timestamp,
    invoiceAlreadyGenerated,
    invoiceCorrectionRequired: invoiceAlreadyGenerated,
    approvalStatus: completedAdjustment.approvalStatus,
    omsAdjustmentStatus: 'pending',
    updatedAt: timestamp,
  });

  await addAuditLog('quantity_removal_completed', 'packing_adjustment', adjustmentId, user?.id || adjustment.removedBy, {
    consignmentId: adjustment.consignmentId,
    boxNo: adjustment.boxNo,
    skuId: adjustment.skuId,
    quantity: removeQty,
    finalQty,
    invoiceCorrectionRequired: invoiceAlreadyGenerated,
  });

  // Keep in-memory packing session in sync when present
  if (session?.boxes) {
    session.boxes[String(adjustment.boxNo)] = items.map((item) => ({ ...item }));
    if (Array.isArray(session.skus)) {
      for (const sku of session.skus) {
        const persisted = skus.find((s) => s.id === sku.id);
        if (!persisted) continue;
        sku.packed = persisted.packedQty;
        sku.remaining = Math.max(0, (sku.required || 0) - persisted.packedQty);
        sku.status = persisted.status;
      }
      rebuildSessionSkuTotalsFromBoxes(session);
    }
  }

  emitConsignmentChange({
    id: adjustment.consignmentId,
    totalPackedQty,
    totalRequiredQty,
    status: consignmentUpdate.status,
    shipmentStatus: consignmentUpdate.shipmentStatus,
    updatedAt: timestamp,
    realtimeType: 'quantity_removal',
    quantityRemovalNeedsInvoiceCorrection: Boolean(consignmentUpdate.quantityRemovalNeedsInvoiceCorrection),
  });

  return {
    adjustment: completedAdjustment,
    alreadyCompleted: false,
    consignment: { ...consignment, ...consignmentUpdate },
    box: { ...box, ...boxUpdate },
    invoiceWarning: invoiceAlreadyGenerated
      ? 'The invoice has already been generated for this consignment. Quantity removal will require invoice correction or approval.'
      : null,
  };
}

/**
 * Authorized box-wise quantity edit (history preserved via packing_adjustments).
 */
async function applyBoxQuantityEdit({
  consignment,
  box,
  skuId,
  newQuantity,
  reason,
  remarks,
  user,
}) {
  const nextQty = Number(newQuantity);
  if (!Number.isInteger(nextQty) || nextQty < 0) {
    const error = new Error('Updated quantity must be a non-negative whole number');
    error.statusCode = 400;
    error.code = 'INVALID_EDIT_QTY';
    throw error;
  }
  if (!String(reason || '').trim()) {
    const error = new Error('A reason is required for quantity edits');
    error.statusCode = 400;
    error.code = 'EDIT_REASON_REQUIRED';
    throw error;
  }

  const items = (box.items || []).map((item) => ({ ...item }));
  const itemIndex = items.findIndex((i) => String(i.skuId) === String(skuId));
  if (itemIndex < 0 && nextQty === 0) {
    const error = new Error('SKU is not packed in this box');
    error.statusCode = 400;
    error.code = 'SKU_NOT_IN_BOX';
    throw error;
  }

  let previousQty = 0;
  let itemMeta = { skuId };
  if (itemIndex >= 0) {
    previousQty = Number(items[itemIndex].qty) || 0;
    itemMeta = items[itemIndex];
  } else {
    const error = new Error('SKU is not packed in this box — cannot add new SKUs via edit');
    error.statusCode = 400;
    error.code = 'SKU_NOT_IN_BOX';
    throw error;
  }

  const difference = nextQty - previousQty;
  if (difference === 0) {
    const error = new Error('Updated quantity is the same as the current quantity');
    error.statusCode = 400;
    throw error;
  }

  if (nextQty <= 0) items.splice(itemIndex, 1);
  else items[itemIndex] = { ...items[itemIndex], qty: nextQty };

  const timestamp = now();
  const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const originalTotalQty = Number(box.originalTotalQty) > 0
    ? Number(box.originalTotalQty)
    : (Number(box.totalQty) || previousQty);

  const boxId = box.id || `${consignment.id}_box_${box.boxNo}`;
  const boxUpdate = {
    items,
    totalQty,
    originalTotalQty,
    removedTotalQty: difference < 0
      ? (Number(box.removedTotalQty) || 0) + Math.abs(difference)
      : (Number(box.removedTotalQty) || 0),
    updatedAt: timestamp,
  };
  await firestoreHelpers.setDocument('boxes', boxId, boxUpdate);

  const allBoxesRaw = await loadAllBoxesForConsignment(consignment);
  const validBoxes = allBoxesRaw.map((b) => (b.id === boxId ? { ...b, ...boxUpdate } : b));

  const packedBySku = {};
  for (const b of validBoxes) {
    for (const item of b.items || []) {
      if (!item.skuId) continue;
      if (!packedBySku[item.skuId]) packedBySku[item.skuId] = {};
      packedBySku[item.skuId][b.boxNo] = (packedBySku[item.skuId][b.boxNo] || 0) + (Number(item.qty) || 0);
    }
  }

  const skuIds = consignment.skuIds || [];
  const skus = (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean);
  for (const sku of skus) {
    const boxQuantities = packedBySku[sku.id] || {};
    const packed = Object.values(boxQuantities).reduce((a, b) => a + b, 0);
    const required = Number(sku.requiredQty) || 0;
    const status = required > 0 && packed >= required ? 'completed' : 'pending';
    await firestoreHelpers.setDocument('skus', sku.id, {
      packedQty: packed,
      boxQuantities,
      status,
      // Recompute inward status vs new packed qty without wiping inward qty
      ...(sku.inwardQty != null ? {
        quantityDifference: (Number(sku.inwardQty) || 0) - packed,
        inwardStatus: require('./inwardSku').computeInwardStatus(packed, sku.inwardQty),
      } : {}),
      updatedAt: timestamp,
    });
    sku.packedQty = packed;
    sku.status = status;
  }

  const totalPackedQty = skus.reduce((sum, s) => sum + (Number(s.packedQty) || 0), 0);
  const totalRequiredQty = skus.reduce((sum, s) => sum + (Number(s.requiredQty) || 0), 0);
  const allCompleted = skus.length > 0 && skus.every((s) => s.status === 'completed');
  const statusUpdates = getQuantityReductionUpdates(consignment, allCompleted) || {
    status: allCompleted ? 'completed' : 'in_progress',
    updatedAt: timestamp,
  };

  const invoiceAlreadyGenerated = isInvoiceGenerated(consignment);
  const consignmentUpdate = {
    totalPackedQty,
    totalRequiredQty,
    ...statusUpdates,
    updatedAt: timestamp,
  };
  if (invoiceAlreadyGenerated && difference !== 0) {
    consignmentUpdate.quantityRemovalNeedsInvoiceCorrection = true;
    consignmentUpdate.invoiceQtyMismatch = true;
    consignmentUpdate.dispatchBlockedForInvoiceMismatch = true;
  }

  await firestoreHelpers.setDocument('consignments', consignment.id, consignmentUpdate);

  const actionType = difference < 0 ? 'remove' : 'add';
  const adjustment = {
    id: generateId(),
    consignmentId: consignment.id,
    internalShipmentNo: consignment.internalShipmentNo || consignment.id,
    boxNo: String(box.boxNo),
    boxId,
    skuId: itemMeta.skuId,
    internalSku: itemMeta.internalSku || '',
    marketplaceSku: itemMeta.marketplaceSku || '',
    barcode: itemMeta.barcode || itemMeta.marketplaceBarcode || '',
    actionType: 'edit',
    editAction: actionType,
    originalPackedQty: previousQty,
    previousQuantity: previousQty,
    quantity: Math.abs(difference),
    updatedQuantity: nextQty,
    finalQty: nextQty,
    difference,
    reason: String(reason).trim(),
    reasonLabel: String(reason).trim(),
    remarks: String(remarks || '').trim(),
    status: 'completed',
    videoId: null,
    videoStatus: 'not_required',
    removedBy: user.id,
    removedByName: user.name || user.email || '',
    userId: user.id,
    userName: user.name || user.email || '',
    removedAt: timestamp,
    completedAt: timestamp,
    approvalStatus: invoiceAlreadyGenerated ? 'required' : 'not_required',
    invoiceAlreadyGenerated,
    invoiceCorrectionRequired: invoiceAlreadyGenerated,
    omsAdjustmentStatus: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await firestoreHelpers.setDocument(COLLECTION, adjustment.id, adjustment);
  await addAuditLog('box_quantity_edit', 'packing_adjustment', adjustment.id, user.id, {
    consignmentId: consignment.id,
    boxNo: adjustment.boxNo,
    skuId: adjustment.skuId,
    previousQuantity: previousQty,
    updatedQuantity: nextQty,
    difference,
    reason: adjustment.reason,
  });

  emitConsignmentChange({
    id: consignment.id,
    totalPackedQty,
    totalRequiredQty,
    status: consignmentUpdate.status,
    shipmentStatus: consignmentUpdate.shipmentStatus,
    updatedAt: timestamp,
    realtimeType: 'box_quantity_edit',
  });

  return {
    adjustment,
    box: { ...box, ...boxUpdate },
    consignment: { ...consignment, ...consignmentUpdate },
    invoiceWarning: invoiceAlreadyGenerated
      ? 'The invoice has already been generated for this consignment. Quantity change will require invoice correction or approval.'
      : null,
  };
}

function enrichSkusWithAdjustments(skus = [], adjustments = []) {
  const completed = (adjustments || []).filter((a) => a.status === 'completed');
  const removedBySku = {};
  const addedBySku = {};
  for (const adj of completed) {
    if (adj.actionType === 'remove' || (adj.actionType === 'edit' && (Number(adj.difference) < 0 || adj.editAction === 'remove'))) {
      removedBySku[adj.skuId] = (removedBySku[adj.skuId] || 0) + (Number(adj.quantity) || Math.abs(Number(adj.difference) || 0));
    }
    if (adj.actionType === 'add' || (adj.actionType === 'edit' && (Number(adj.difference) > 0 || adj.editAction === 'add'))) {
      addedBySku[adj.skuId] = (addedBySku[adj.skuId] || 0) + (Number(adj.quantity) || Math.abs(Number(adj.difference) || 0));
    }
  }
  return skus.map((sku) => {
    const postPackRemovedQty = removedBySku[sku.id] || 0;
    const postPackAddedQty = addedBySku[sku.id] || 0;
    const packedQty = Number(sku.packedQty) || 0;
    const originallyPackedQty = packedQty + postPackRemovedQty - postPackAddedQty;
    return {
      ...sku,
      packedQty,
      postPackRemovedQty,
      postPackAddedQty,
      originallyPackedQty: Math.max(0, originallyPackedQty),
      finalPackedQty: packedQty,
    };
  });
}

/** Recompute SKU packedQty + consignment total from physical box items (source of truth). */
function recomputePackedFromBoxes(skus = [], boxes = []) {
  const packedBySku = {};
  for (const box of boxes || []) {
    for (const item of box.items || []) {
      if (!item.skuId) continue;
      if (!packedBySku[item.skuId]) packedBySku[item.skuId] = {};
      const boxNo = String(box.boxNo || box.box_no || '');
      packedBySku[item.skuId][boxNo] = (packedBySku[item.skuId][boxNo] || 0) + (Number(item.qty) || 0);
    }
  }

  let totalPackedQty = 0;
  const nextSkus = (skus || []).map((sku) => {
    const boxQuantities = packedBySku[sku.id] || {};
    const packedQty = Object.values(boxQuantities).reduce((a, b) => a + b, 0);
    totalPackedQty += packedQty;
    const required = Number(sku.requiredQty) || 0;
    return {
      ...sku,
      packedQty,
      boxQuantities,
      status: required > 0 && packedQty >= required ? 'completed' : (packedQty > 0 ? 'pending' : (sku.status || 'pending')),
      finalPackedQty: packedQty,
    };
  });

  return { skus: nextSkus, totalPackedQty };
}

/**
 * Correct a mis-scanned box number — e.g. a SKU barcode got scanned into the
 * "box no" field instead of a plain digit, so the box saved (items, weight,
 * video) under a bogus number like "120045947" instead of "4".
 *
 * Renames the box's identity in one Postgres transaction: the box row itself,
 * its entry in consignment.boxIds, and every video / scan_event /
 * packing_adjustment that points at it. Nothing is left half-renamed — the
 * whole thing commits or nothing changes. Boxes/Videos/Packing Report/Weight
 * Ledger all read from the same GET /:id response, so a single successful
 * rename is enough for the correction to show up everywhere.
 */
async function renameBoxNo({ consignmentId, oldBoxNo, newBoxNo, reason, remarks, user }) {
  if (!pgEnabled()) {
    const error = new Error('Postgres is required to rename a box.');
    error.statusCode = 503;
    error.code = 'DATASTORE_UNAVAILABLE';
    throw error;
  }

  const from = String(oldBoxNo ?? '').trim();
  const to = String(newBoxNo ?? '').trim();
  if (!/^\d+$/.test(to)) {
    const error = new Error('Box number must contain digits only (e.g. 4)');
    error.statusCode = 400;
    error.code = 'INVALID_BOX_NO';
    throw error;
  }
  if (to === from) {
    const error = new Error('New box number is the same as the current one');
    error.statusCode = 400;
    error.code = 'BOX_NO_UNCHANGED';
    throw error;
  }
  if (!String(reason || '').trim()) {
    const error = new Error('A reason is required to rename a box');
    error.statusCode = 400;
    error.code = 'RENAME_REASON_REQUIRED';
    throw error;
  }

  const oldBoxId = `${consignmentId}_box_${from}`;
  const newBoxId = `${consignmentId}_box_${to}`;
  const timestamp = now();
  const client = await getPool().connect();

  let renamedBox;
  let updatedConsignment;
  let videosUpdated = 0;
  let scanEventsUpdated = 0;
  let adjustmentsUpdated = 0;

  try {
    await client.query('BEGIN');

    const { rows: consignmentRows } = await client.query(
      `SELECT data FROM documents WHERE collection = 'consignments' AND id = $1 FOR UPDATE`,
      [consignmentId]
    );
    if (!consignmentRows.length) {
      const error = new Error('Consignment not found');
      error.statusCode = 404;
      throw error;
    }
    const consignment = consignmentRows[0].data;

    const { rows: oldBoxRows } = await client.query(
      `SELECT data FROM documents WHERE collection = 'boxes' AND id = $1 FOR UPDATE`,
      [oldBoxId]
    );
    if (!oldBoxRows.length) {
      const error = new Error(`Box ${from} not found`);
      error.statusCode = 404;
      throw error;
    }
    const oldBox = oldBoxRows[0].data;

    const { rows: collisionRows } = await client.query(
      `SELECT id FROM documents
       WHERE collection = 'boxes'
         AND (id = $1 OR (data->>'consignmentId' = $2 AND data->>'boxNo' = $3))
       FOR UPDATE`,
      [newBoxId, consignmentId, to]
    );
    if (collisionRows.length) {
      const error = new Error(`Box ${to} already exists on this consignment — rename to a free box number.`);
      error.statusCode = 409;
      error.code = 'BOX_NO_TAKEN';
      throw error;
    }

    renamedBox = {
      ...oldBox,
      id: newBoxId,
      boxNo: to,
      renamedFrom: from,
      renamedAt: timestamp,
      renamedBy: user?.id || null,
      updatedAt: timestamp,
    };
    await upsertDocument(client, 'boxes', newBoxId, renamedBox);
    await client.query(`DELETE FROM documents WHERE collection = 'boxes' AND id = $1`, [oldBoxId]);

    const existingBoxIds = Array.isArray(consignment.boxIds) ? consignment.boxIds : [];
    const nextBoxIds = existingBoxIds.includes(oldBoxId)
      ? existingBoxIds.map((bid) => (bid === oldBoxId ? newBoxId : bid))
      : Array.from(new Set([...existingBoxIds, newBoxId]));
    updatedConsignment = await upsertDocument(client, 'consignments', consignmentId, {
      boxIds: Array.from(new Set(nextBoxIds)),
      updatedAt: timestamp,
    });

    // Videos carry both boxId and boxNo — relink whichever matches.
    const { rows: videoRows } = await client.query(
      `SELECT id FROM documents
       WHERE collection = 'videos' AND data->>'consignmentId' = $1
         AND (data->>'boxId' = $2 OR data->>'boxNo' = $3)
       FOR UPDATE`,
      [consignmentId, oldBoxId, from]
    );
    for (const row of videoRows) {
      await upsertDocument(client, 'videos', row.id, { boxId: newBoxId, boxNo: to, updatedAt: timestamp });
    }
    videosUpdated = videoRows.length;

    // Scan events only carry boxNo (no boxId field on that document shape).
    const { rows: scanRows } = await client.query(
      `SELECT id FROM documents
       WHERE collection = 'scan_events' AND data->>'consignmentId' = $1 AND data->>'boxNo' = $2
       FOR UPDATE`,
      [consignmentId, from]
    );
    for (const row of scanRows) {
      await upsertDocument(client, 'scan_events', row.id, { boxNo: to, updatedAt: timestamp });
    }
    scanEventsUpdated = scanRows.length;

    // Keep any prior quantity-edit / removal history attached to the corrected box.
    const { rows: adjustmentRows } = await client.query(
      `SELECT id FROM documents
       WHERE collection = 'packing_adjustments' AND data->>'consignmentId' = $1
         AND (data->>'boxId' = $2 OR data->>'boxNo' = $3)
       FOR UPDATE`,
      [consignmentId, oldBoxId, from]
    );
    for (const row of adjustmentRows) {
      await upsertDocument(client, 'packing_adjustments', row.id, { boxId: newBoxId, boxNo: to, updatedAt: timestamp });
    }
    adjustmentsUpdated = adjustmentRows.length;

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (!error.statusCode) {
      const wrapped = new Error('Durable datastore unavailable while trying to rename this box.');
      wrapped.statusCode = 503;
      wrapped.code = 'DATASTORE_UNAVAILABLE';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  } finally {
    client.release();
  }

  await addAuditLog('box_renumbered', 'box', newBoxId, user?.id || null, {
    consignmentId,
    oldBoxNo: from,
    newBoxNo: to,
    reason: String(reason).trim(),
    remarks: String(remarks || '').trim(),
    videosUpdated,
    scanEventsUpdated,
    adjustmentsUpdated,
  });

  emitConsignmentChange({
    id: consignmentId,
    updatedAt: timestamp,
    realtimeType: 'box_renumbered',
  });

  return {
    box: renamedBox,
    consignment: updatedConsignment,
    oldBoxNo: from,
    newBoxNo: to,
    videosUpdated,
    scanEventsUpdated,
    adjustmentsUpdated,
  };
}

async function loadAllBoxesForConsignment(consignment) {
  const byId = new Map();
  const boxIds = consignment?.boxIds || [];
  if (boxIds.length) {
    const docs = await firestoreHelpers.batchGetDocuments('boxes', boxIds);
    docs.filter(Boolean).forEach((box) => byId.set(box.id, box));
  }
  const queried = await firestoreHelpers.queryCollection('boxes', 'consignmentId', '==', consignment.id);
  queried.filter(Boolean).forEach((box) => byId.set(box.id, box));
  return Array.from(byId.values());
}

module.exports = {
  COLLECTION,
  REMOVAL_REASONS,
  isInvoiceGenerated,
  listAdjustmentsForConsignment,
  listAdjustmentsForBox,
  findByClientRequestId,
  summarizeBoxHistory,
  createPendingRemoval,
  attachRemovalVideo,
  finalizeRemoval,
  applyBoxQuantityEdit,
  renameBoxNo,
  enrichSkusWithAdjustments,
  recomputePackedFromBoxes,
  loadAllBoxesForConsignment,
};
