const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { generateId, now, addAuditLog, firestoreHelpers } = require('../utils/helpers');
const { enrichConsignment, buildMarketplaceMap, sortByDispatchPriority } = require('../utils/dispatchPlanning');
const { getPool, pgEnabled } = require('../config/database');
const pgHelpers = require('../utils/pgHelpers');
const { emitConsignmentChange } = require('../utils/syncBus');
const {
  syncConsignmentIdChange,
} = require('../utils/taskflowBridge');
const { getSaveBoxUpdates } = require('../utils/shipmentStatus');
const {
  enrichWorkflowFields,
  sortConsignmentsByWorkflowPriority,
  canAdvanceLogistics,
  emptyStageConfirmations,
  buildTatDeadlines,
  canArchiveConsignment,
  isStageConfirmed,
  LIST_BUCKETS,
} = require('../utils/consignmentWorkflow');
const { saveBoxWithPostgresTransaction } = require('../utils/packingPersistence');
const { getMarketplaceBarcode, normalizeSkuInput } = require('../utils/skuIdentity');
const { lookupShipmentSkus } = require('../utils/consignmentSheet');
const { pushPackingToSheet } = require('../utils/consignmentSheetPush');
const { resolveStoragePath, resolvePublicUrl, deleteFile } = require('../utils/storage');
const { requirePermission, requireAnyPermission, DELETE_CONSIGNMENTS } = require('../utils/permissions');
const {
  buildConsignmentId,
  findConsignmentIdentityConflict,
  formatIdentityConflictError,
} = require('../utils/resolveConsignment');
const { reassignConsignmentId } = require('../utils/consignmentIdMigration');
const {
  buildOmsGuruTemplateCsv,
  parseOmsGuruCsv,
  findSkuForImportRow,
  validateImportRow,
  summarizeOmsGuruSkus,
} = require('../utils/omsGuruSku');
const {
  buildInwardTemplateCsv,
  parseInwardCsv,
  findSkuForInwardRow,
  validateInwardRow,
  summarizeInwardSkus,
  computeInwardStatus,
  computeQuantityDifference,
} = require('../utils/inwardSku');
const {
  listAdjustmentsForConsignment,
  listAdjustmentsForBox,
  summarizeBoxHistory,
  enrichSkusWithAdjustments,
  applyBoxQuantityEdit,
  renameBoxNo,
  recomputePackedFromBoxes,
} = require('../utils/packingAdjustments');

const omsGuruUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const ok = file.mimetype === 'text/csv'
      || file.mimetype === 'application/vnd.ms-excel'
      || file.mimetype === 'text/plain'
      || name.endsWith('.csv');
    cb(ok ? null : new Error('Only CSV files are allowed'), ok);
  },
});

const inwardUpload = omsGuruUpload;

async function persistOmsGuruUploadLog(log) {
  if (pgEnabled()) {
    try {
      await getPool().query(
        `INSERT INTO oms_guru_upload_logs
          (id, consignment_id, file_name, uploaded_by, uploaded_by_name, row_count, updated_sku_count, error_count, errors, changes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
        [
          log.id,
          log.consignmentId,
          log.fileName || null,
          log.uploadedBy || null,
          log.uploadedByName || null,
          log.rowCount || 0,
          log.updatedSkuCount || 0,
          log.errorCount || 0,
          JSON.stringify(log.errors || []),
          JSON.stringify(log.changes || []),
        ]
      );
      return;
    } catch (error) {
      console.warn('[OMSGuru] Postgres upload log write failed, using documents fallback:', error.message);
    }
  }
  await firestoreHelpers.setDocument('omsGuruUploadLogs', log.id, log);
}

async function fetchOmsGuruUploadLogs(consignmentId) {
  if (pgEnabled()) {
    try {
      const { rows } = await getPool().query(
        `SELECT id, consignment_id, file_name, uploaded_by, uploaded_by_name,
                row_count, updated_sku_count, error_count, errors, changes, created_at
         FROM oms_guru_upload_logs
         WHERE consignment_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [consignmentId]
      );
      return rows.map((row) => ({
        id: row.id,
        consignmentId: row.consignment_id,
        fileName: row.file_name,
        uploadedBy: row.uploaded_by,
        uploadedByName: row.uploaded_by_name,
        rowCount: row.row_count,
        updatedSkuCount: row.updated_sku_count,
        errorCount: row.error_count,
        errors: row.errors || [],
        changes: row.changes || [],
        createdAt: row.created_at,
      }));
    } catch (error) {
      console.warn('[OMSGuru] Postgres upload log read failed, using documents fallback:', error.message);
    }
  }
  const docs = await firestoreHelpers.queryCollection('omsGuruUploadLogs', 'consignmentId', '==', consignmentId);
  return docs
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
}

// Report helpers live in this route so the UI and exports share one source of truth.
function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  const body = { error: fallbackMessage || error.message };
  if (error.code) body.code = error.code;
  if (error.failures) body.failures = error.failures;
  if (fallbackMessage && error.message) body.message = error.message;
  return res.status(status).json(body);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parsePositiveQty(value) {
  const qty = Number(value);
  return Number.isInteger(qty) && qty > 0 ? qty : null;
}

function cleanKey(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function compareBoxNo(a, b) {
  return cleanKey(a).localeCompare(cleanKey(b), undefined, { numeric: true, sensitivity: 'base' });
}

function indexValue(map, value, row) {
  const key = cleanKey(value);
  if (!key || map.has(key)) return;
  map.set(key, row);
}

function deriveStatus(required, packed) {
  if (packed > required) return 'overpacked';
  if (required > 0 && packed >= required) return 'completed';
  return 'pending';
}

function buildPackingReport(consignment, skus = [], boxes = [], missingBoxIds = []) {
  const generatedAt = now();
  const integrityIssues = [];
  const bySkuId = new Map();
  const byMarketplaceBarcode = new Map();
  const byMarketplaceSku = new Map();
  const byInternalSku = new Map();
  const byBarcode = new Map();

  const rows = (skus || []).filter(Boolean).map((sku) => {
    const row = {
      skuId: sku.id,
      marketplaceBarcode: getMarketplaceBarcode(sku),
      marketplaceBarcodeType: sku.marketplaceBarcodeType || '',
      marketplaceSku: sku.marketplaceSku || getMarketplaceBarcode(sku) || '',
      internalSku: sku.internalSku || sku.name || '',
      barcode: getMarketplaceBarcode(sku),
      required: toNumber(sku.requiredQty),
      packedFromBoxes: 0,
      packed: 0,
      remaining: toNumber(sku.requiredQty),
      boxQtys: {},
      totalInBoxes: 0,
      storedPackedQty: toNumber(sku.packedQty),
      storedStatus: sku.status || '',
      statusFromBoxes: 'pending',
    };
    indexValue(bySkuId, sku.id, row);
    indexValue(byMarketplaceBarcode, row.marketplaceBarcode, row);
    indexValue(byMarketplaceSku, sku.marketplaceSku, row);
    indexValue(byInternalSku, sku.internalSku, row);
    indexValue(byBarcode, sku.barcode, row);
    return row;
  });

  const findRowForItem = (item = {}) => {
    const skuId = cleanKey(item.skuId);
    if (skuId && bySkuId.has(skuId)) return bySkuId.get(skuId);
    const marketplaceBarcode = cleanKey(getMarketplaceBarcode(item));
    if (marketplaceBarcode && byMarketplaceBarcode.has(marketplaceBarcode)) return byMarketplaceBarcode.get(marketplaceBarcode);
    const marketplaceSku = cleanKey(item.marketplaceSku);
    if (marketplaceSku && byMarketplaceSku.has(marketplaceSku)) return byMarketplaceSku.get(marketplaceSku);
    const internalSku = cleanKey(item.internalSku || item.name);
    if (internalSku && byInternalSku.has(internalSku)) return byInternalSku.get(internalSku);
    const barcode = cleanKey(item.barcode);
    if (barcode && byBarcode.has(barcode)) return byBarcode.get(barcode);
    return null;
  };

  const reportBoxes = (boxes || [])
    .filter(Boolean)
    .map((box) => ({
      id: box.id || '',
      boxNo: cleanKey(box.boxNo || box.box_no || box.id),
      totalQty: 0,
      savedTotalQty: box.totalQty === undefined ? null : toNumber(box.totalQty),
      originalTotalQty: box.originalTotalQty === undefined ? null : toNumber(box.originalTotalQty),
      removedTotalQty: toNumber(box.removedTotalQty),
      itemCount: Array.isArray(box.items) ? box.items.length : 0,
      raw: box,
    }))
    .filter((box) => box.boxNo)
    .sort((a, b) => compareBoxNo(a.boxNo, b.boxNo));

  for (const box of reportBoxes) {
    for (const item of box.raw.items || []) {
      const qty = toNumber(item.qty ?? item.quantity);
      if (qty <= 0) {
        integrityIssues.push({
          type: 'invalid_box_item_qty',
          boxId: box.id,
          boxNo: box.boxNo,
          item,
          message: `Box #${box.boxNo} has an item with invalid quantity.`,
        });
        continue;
      }

      box.totalQty += qty;
      const row = findRowForItem(item);
      if (!row) {
        integrityIssues.push({
          type: 'unknown_box_item_sku',
          boxId: box.id,
          boxNo: box.boxNo,
          marketplaceSku: item.marketplaceSku || '',
          internalSku: item.internalSku || item.name || '',
          barcode: item.barcode || '',
          qty,
          message: `Box #${box.boxNo} contains an item that does not match any saved SKU.`,
        });
        continue;
      }

      row.boxQtys[box.boxNo] = (row.boxQtys[box.boxNo] || 0) + qty;
      row.packedFromBoxes += qty;
    }

    if (box.savedTotalQty !== null && box.savedTotalQty !== box.totalQty) {
      integrityIssues.push({
        type: 'box_total_mismatch',
        boxId: box.id,
        boxNo: box.boxNo,
        savedTotalQty: box.savedTotalQty,
        packedFromBoxes: box.totalQty,
        message: `Box #${box.boxNo} saved total does not match its item quantities.`,
      });
    }
  }

  for (const row of rows) {
    row.packed = row.packedFromBoxes;
    row.totalInBoxes = row.packedFromBoxes;
    row.remaining = row.required - row.packedFromBoxes;
    row.statusFromBoxes = deriveStatus(row.required, row.packedFromBoxes);
    row.originalTotalQty = null;
    row.removedTotalQty = null;

    if (row.storedPackedQty !== row.packedFromBoxes) {
      integrityIssues.push({
        type: 'sku_packed_mismatch',
        skuId: row.skuId,
        marketplaceSku: row.marketplaceSku,
        internalSku: row.internalSku,
        storedPackedQty: row.storedPackedQty,
        packedFromBoxes: row.packedFromBoxes,
        message: `${row.internalSku || row.marketplaceSku || row.skuId} stored packed quantity does not match saved boxes.`,
      });
    }

    if (row.storedStatus && row.storedStatus !== row.statusFromBoxes) {
      integrityIssues.push({
        type: 'sku_status_mismatch',
        skuId: row.skuId,
        marketplaceSku: row.marketplaceSku,
        internalSku: row.internalSku,
        storedStatus: row.storedStatus,
        statusFromBoxes: row.statusFromBoxes,
        message: `${row.internalSku || row.marketplaceSku || row.skuId} stored status does not match saved boxes.`,
      });
    }
  }

  for (const boxId of missingBoxIds) {
    integrityIssues.push({
      type: 'missing_box_document',
      boxId,
      message: `Consignment references missing box document ${boxId}.`,
    });
  }

  const totalRequired = rows.reduce((sum, row) => sum + row.required, 0);
  const totalPacked = rows.reduce((sum, row) => sum + row.packedFromBoxes, 0);
  const totalPending = rows.reduce((sum, row) => sum + Math.max(0, row.required - row.packedFromBoxes), 0);

  if (toNumber(consignment.totalRequiredQty) !== totalRequired) {
    integrityIssues.push({
      type: 'consignment_required_mismatch',
      savedTotalRequiredQty: toNumber(consignment.totalRequiredQty),
      calculatedRequiredQty: totalRequired,
      message: 'Consignment required total does not match SKU required quantities.',
    });
  }

  if (toNumber(consignment.totalPackedQty) !== totalPacked) {
    integrityIssues.push({
      type: 'consignment_packed_mismatch',
      savedTotalPackedQty: toNumber(consignment.totalPackedQty),
      packedFromBoxes: totalPacked,
      message: 'Consignment packed total does not match saved box contents.',
    });
  }

  return {
    consignmentId: consignment.id,
    internalShipmentNo: consignment.internalShipmentNo || '',
    shipmentNo: consignment.shipmentNo || '',
    source: 'boxes',
    generatedAt,
    boxes: reportBoxes.map(({ raw, ...box }) => box),
    rows,
    summary: {
      skuCount: rows.length,
      boxCount: reportBoxes.length,
      totalRequired,
      totalPacked,
      totalPending,
      percentComplete: totalRequired > 0 ? Math.round((totalPacked / totalRequired) * 100) : 0,
      packedSkuCount: rows.filter((row) => row.packedFromBoxes > 0).length,
      pendingSkuCount: rows.filter((row) => row.remaining > 0).length,
      completeSkuCount: rows.filter((row) => row.remaining === 0 && row.required > 0).length,
    },
    integrityIssues,
  };
}

async function getSavedBoxesForConsignment(consignmentId, boxIds = []) {
  const byId = new Map();
  const missingBoxIds = [];

  if (boxIds.length) {
    const boxDocs = await firestoreHelpers.batchGetDocuments('boxes', boxIds);
    const foundIds = new Set();
    boxDocs.forEach((box) => {
      if (!box) return;
      byId.set(box.id, box);
      foundIds.add(box.id);
    });
    boxIds.forEach((boxId) => {
      if (!foundIds.has(boxId)) missingBoxIds.push(boxId);
    });
  }

  const queriedBoxes = await firestoreHelpers.queryCollection('boxes', 'consignmentId', '==', consignmentId);
  queriedBoxes.filter(Boolean).forEach((box) => {
    if (box.id) byId.set(box.id, box);
  });

  return { boxes: Array.from(byId.values()), missingBoxIds };
}

function normalizeConfirmationValue(value) {
  return String(value || '').trim().toLowerCase();
}

function getDeletionConfirmationTargets(consignment) {
  return [consignment.id, consignment.name, consignment.internalShipmentNo]
    .map(normalizeConfirmationValue)
    .filter(Boolean);
}

function matchesDeletionConfirmation(consignment, confirmationText) {
  const text = normalizeConfirmationValue(confirmationText);
  if (!text) return false;
  return getDeletionConfirmationTargets(consignment).includes(text);
}

function uniqueRecords(records = []) {
  const byId = new Map();
  records.filter(Boolean).forEach((record) => {
    const id = record.id || record.data?.id;
    if (id) byId.set(id, { ...record, id });
  });
  return Array.from(byId.values());
}

async function collectRecordsForCollection(collectionName, consignmentId, explicitIds = []) {
  const records = [];
  const ids = Array.from(new Set((explicitIds || []).filter(Boolean)));
  if (ids.length) {
    const docs = await firestoreHelpers.batchGetDocuments(collectionName, ids);
    records.push(...docs);
  }

  const queried = await firestoreHelpers.queryCollection(collectionName, 'consignmentId', '==', consignmentId);
  records.push(...queried);
  return uniqueRecords(records);
}

async function collectConsignmentDeletionPlan(consignment) {
  const consignmentId = consignment.id;
  const [skus, boxes, videos, documents, scanEvents, syncJobs, productivity, packingDrafts] = await Promise.all([
    collectRecordsForCollection('skus', consignmentId, consignment.skuIds || []),
    collectRecordsForCollection('boxes', consignmentId, consignment.boxIds || []),
    collectRecordsForCollection('videos', consignmentId, consignment.videoIds || []),
    collectRecordsForCollection('documents', consignmentId, consignment.documentIds || []),
    collectRecordsForCollection('scan_events', consignmentId),
    collectRecordsForCollection('packing_sync_jobs', consignmentId),
    collectRecordsForCollection('productivity', consignmentId),
    collectRecordsForCollection('packing_drafts', consignmentId, [consignmentId]),
  ]);

  return {
    consignment,
    collections: {
      skus,
      boxes,
      videos,
      documents,
      scan_events: scanEvents,
      packing_sync_jobs: syncJobs,
      productivity,
      packing_drafts: packingDrafts,
    },
  };
}

async function deleteStorageRecordsForPlan(plan) {
  const storageRecords = [
    ...plan.collections.videos.map((record) => ({ record, type: 'video' })),
    ...plan.collections.documents.map((record) => ({ record, type: 'document' })),
  ];
  const deleted = [];
  const failures = [];

  for (const { record, type } of storageRecords) {
    const storagePath = resolveStoragePath(record);
    if (!storagePath) {
      if (type === 'video' && resolvePublicUrl(record)) {
        failures.push({ id: record.id, type, reason: 'missing_storage_path' });
      }
      continue;
    }

    try {
      await deleteFile(storagePath, { allowMissing: true, throwOnError: true });
      deleted.push({ id: record.id, type, storagePath });
    } catch (error) {
      failures.push({ id: record.id, type, storagePath, reason: error.message });
    }
  }

  if (failures.length) {
    const error = new Error('Could not delete every related storage file.');
    error.statusCode = 502;
    error.code = 'STORAGE_DELETE_FAILED';
    error.failures = failures;
    throw error;
  }

  return deleted;
}

async function tableExists(client, tableName) {
  const { rows } = await client.query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]);
  return Boolean(rows[0]?.table_name);
}

async function deleteNormalizedConsignmentRows(client, consignmentId) {
  const statements = [
    ['scan_events', 'DELETE FROM scan_events WHERE consignment_id = $1'],
    ['packing_sync_jobs', 'DELETE FROM packing_sync_jobs WHERE consignment_id = $1'],
    ['productivity_events', 'DELETE FROM productivity_events WHERE consignment_id = $1'],
    ['shipment_documents', 'DELETE FROM shipment_documents WHERE consignment_id = $1'],
    ['videos', 'DELETE FROM videos WHERE consignment_id = $1'],
    ['box_items', 'DELETE FROM box_items WHERE consignment_id = $1'],
    ['boxes', 'DELETE FROM boxes WHERE consignment_id = $1'],
    ['skus', 'DELETE FROM skus WHERE consignment_id = $1'],
    ['consignments', 'DELETE FROM consignments WHERE id = $1'],
  ];
  const rowCounts = {};

  for (const [tableName, sql] of statements) {
    if (!(await tableExists(client, tableName))) continue;
    const result = await client.query(sql, [consignmentId]);
    rowCounts[tableName] = result.rowCount;
  }

  return rowCounts;
}

async function deleteConsignmentPlanFromPostgres(plan, userId, storageDeleted) {
  const pool = getPool();
  if (!pool) {
    const error = new Error('Postgres is not configured.');
    error.statusCode = 503;
    error.code = 'DATASTORE_UNAVAILABLE';
    throw error;
  }

  const client = await pool.connect();
  const consignmentId = plan.consignment.id;
  const collectionRowCounts = {};

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT data FROM documents WHERE collection = 'consignments' AND id = $1 FOR UPDATE`,
      [consignmentId]
    );
    if (!rows.length) {
      const error = new Error('Consignment not found');
      error.statusCode = 404;
      throw error;
    }

    for (const collectionName of Object.keys(plan.collections)) {
      const ids = plan.collections[collectionName].map((record) => record.id).filter(Boolean);
      let deletedById = 0;
      if (ids.length) {
        const byId = await client.query(
          'DELETE FROM documents WHERE collection = $1 AND id = ANY($2::text[])',
          [collectionName, ids]
        );
        deletedById = byId.rowCount;
      }

      const byConsignment = await client.query(
        `DELETE FROM documents
         WHERE collection = $1 AND data->>'consignmentId' = $2`,
        [collectionName, consignmentId]
      );
      collectionRowCounts[collectionName] = deletedById + byConsignment.rowCount;
    }

    const consignmentDelete = await client.query(
      "DELETE FROM documents WHERE collection = 'consignments' AND id = $1",
      [consignmentId]
    );
    collectionRowCounts.consignments = consignmentDelete.rowCount;

    const normalizedRowCounts = await deleteNormalizedConsignmentRows(client, consignmentId);
    const auditLog = {
      id: generateId(),
      action: 'delete',
      entityType: 'consignment',
      entityId: consignmentId,
      userId,
      details: {
        internalShipmentNo: plan.consignment.internalShipmentNo || '',
        name: plan.consignment.name || '',
        deletedCollections: collectionRowCounts,
        deletedNormalizedRows: normalizedRowCounts,
        deletedStorageFiles: storageDeleted.length,
      },
      timestamp: now(),
    };

    await client.query(
      `INSERT INTO documents (collection, id, data, updated_at)
       VALUES ('auditLogs', $1, $2::jsonb, now())
       ON CONFLICT (collection, id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [auditLog.id, JSON.stringify(auditLog)]
    );

    await client.query('COMMIT');
    return { collectionRowCounts, normalizedRowCounts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteConsignmentPlanWithHelpers(plan, userId, storageDeleted) {
  await Promise.all(Object.entries(plan.collections).map(([collectionName, records]) => {
    const ids = records.map((record) => record.id).filter(Boolean);
    return ids.length ? firestoreHelpers.batchDelete(collectionName, ids) : Promise.resolve();
  }));
  await firestoreHelpers.deleteDocument('consignments', plan.consignment.id);
  await addAuditLog('delete', 'consignment', plan.consignment.id, userId, {
    internalShipmentNo: plan.consignment.internalShipmentNo || '',
    name: plan.consignment.name || '',
    deletedStorageFiles: storageDeleted.length,
  });
}

function calculateBoxDerivedSkuUpdates(consignment, skus, boxes, missingBoxIds = []) {
  const report = buildPackingReport(consignment, skus, boxes, missingBoxIds);
  const skuUpdates = report.rows
    .filter((row) => row.skuId)
    .map((row) => ['skus', row.skuId, {
      packedQty: row.packedFromBoxes,
      boxQuantities: row.boxQtys,
      status: row.statusFromBoxes,
      updatedAt: now(),
    }]);

  return { report, skuUpdates };
}

async function applyDispatchPlanning(consignment, marketplaceMap) {
  const enriched = enrichConsignment(consignment, marketplaceMap);
  return {
    ...consignment,
    transitDays: enriched.transitDays,
    requiredDispatchDate: enriched.requiredDispatchDate,
    scheduledDispatchDate: enriched.scheduledDispatchDate || consignment.scheduledDispatchDate || '',
    updatedAt: now(),
  };
}

// Get all consignments - datastore-agnostic helper backed by Supabase/Postgres
router.get('/', authenticateToken, requirePermission('consignments', 'view consignments'), async (req, res) => {
  try {
    const {
      status,
      search,
      marketplaceId,
      limit,
      sort,
      page,
      offset: offsetParam,
      includeArchived,
      archivedOnly,
      shortPackOnly,
      workflowBucket,
    } = req.query;
    const pageSize = limit ? Math.min(parseInt(limit) || 50, 200) : 50;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const offset = offsetParam != null ? Math.max(0, parseInt(offsetParam) || 0) : (pageNum - 1) * pageSize;
    const statuses = status ? status.split(',').map(s => s.trim()) : null;
    // Archived consignments stay out of the active ops list unless searching or explicitly requested.
    const wantArchivedOnly = String(archivedOnly || '').toLowerCase() === 'true' || archivedOnly === '1';
    const wantIncludeArchived = wantArchivedOnly
      || Boolean(search && String(search).trim())
      || String(includeArchived || '').toLowerCase() === 'true'
      || includeArchived === '1';
    const wantShortPackOnly = String(shortPackOnly || '').toLowerCase() === 'true' || shortPackOnly === '1';
    // A workflow bucket (new/active/disputed/…) is a derived field computed
    // only after enrichWorkflowFields runs — it can't be pushed into the SQL
    // WHERE clause without duplicating that business logic. So when one is
    // requested we skip the DB-paginated path entirely and fall into the
    // same "fetch everything, filter/sort/paginate in JS" flow already used
    // for the document-store fallback below — that flow enriches BEFORE it
    // computes total/slices the page, so the bucket filter lands before
    // pagination instead of after it.
    const bucketFilter = Object.prototype.hasOwnProperty.call(LIST_BUCKETS, workflowBucket) ? workflowBucket : null;

    let consignments;
    let total;

    if (pgEnabled() && !bucketFilter) {
      try {
        const result = await pgHelpers.queryConsignmentsPaginated({
          statuses,
          marketplaceId: marketplaceId || null,
          search: search || null,
          sort: sort || null,
          offset,
          limit: pageSize,
          includeArchived: wantIncludeArchived,
          archivedOnly: wantArchivedOnly,
          shortPackOnly: wantShortPackOnly,
        });
        consignments = result.items;
        total = result.total;
      } catch (e) {
        console.warn('[Consignments] PG paginated query failed:', e.message);
        consignments = await firestoreHelpers.getCollection('consignments');
        total = null;
      }
    } else {
      consignments = await firestoreHelpers.getCollection('consignments');
      total = null;
    }

    if (total == null) {
      if (statuses?.length) {
        consignments = consignments.filter(c => statuses.includes(c.status));
      }
      if (marketplaceId) consignments = consignments.filter(c => c.marketplaceId === marketplaceId);
      if (search) {
        const s = search.toLowerCase();
        consignments = consignments.filter(c =>
          c.id?.toLowerCase().includes(s) ||
          c.shipmentNo?.toLowerCase().includes(s) ||
          c.internalShipmentNo?.toLowerCase().includes(s) ||
          c.name?.toLowerCase().includes(s) ||
          c.docketNo?.toLowerCase().includes(s) ||
          c.forwardInvoiceNo?.toLowerCase().includes(s) ||
          c.invoice?.number?.toLowerCase().includes(s)
        );
      }
      const isArchivedRow = (c) => c?.operationalStatus === 'archived' || c?.isArchived === true;
      if (wantArchivedOnly) {
        consignments = consignments.filter(isArchivedRow);
      } else if (!wantIncludeArchived) {
        consignments = consignments.filter((c) => !isArchivedRow(c));
      }
      if (wantShortPackOnly) {
        consignments = consignments.filter((c) => {
          const shortFromCompletion = Number(c?.packingCompletion?.shortQty) || 0;
          if (shortFromCompletion > 0) return true;
          const planned = Number(c?.totalRequiredQty) || 0;
          const packed = Number(c?.totalPackedQty) || 0;
          return c?.status === 'completed' && planned > packed;
        });
      }
    }

    const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
    consignments = consignments.map((c) => enrichWorkflowFields(enrichConsignment(c, marketplaceMap), { lean: true }));

    if (bucketFilter) {
      // total is guaranteed null here (see the pgEnabled() && !bucketFilter
      // guard above), so the block below still computes total and slices
      // the page from this bucket-filtered set, not the unfiltered one.
      consignments = consignments.filter((c) => c.listPriorityBucket === bucketFilter);
    }

    if (total == null) {
      if (sort === 'dispatch' || sort === 'appointment' || sort === 'workflow' || !sort) {
        consignments = sortConsignmentsByWorkflowPriority(consignments);
        total = consignments.length;
        consignments = consignments.slice(offset, offset + pageSize);
      } else {
        consignments.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
        total = consignments.length;
        consignments = consignments.slice(offset, offset + pageSize);
      }
    } else {
      // PG path: re-sort current page + full set preference — fetch already paginated;
      // apply workflow sort within returned page for consistent UX.
      consignments = sortConsignmentsByWorkflowPriority(consignments);
    }

    res.json({
      consignments,
      count: consignments.length,
      total,
      page: pageNum,
      pageSize,
      hasMore: offset + consignments.length < total,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Consignment Master sheet lookup: fills the Create Consignment SKU table from
// Google Sheets, keyed by Internal Shipment No. Declared before '/:id' so the
// literal path is not captured as an id. Sheet problems are returned as 200 +
// found:false so the modal degrades to manual entry instead of erroring.
router.get('/sheet-lookup', authenticateToken, requirePermission('consignments', 'look up consignments'), async (req, res) => {
  try {
    const internalShipmentNo = String(req.query.internalShipmentNo || '').trim();
    if (!internalShipmentNo) {
      return res.status(400).json({ error: 'internalShipmentNo is required.' });
    }

    const result = await lookupShipmentSkus(internalShipmentNo, {
      force: req.query.refresh === '1' || req.query.refresh === 'true',
      debug: req.query.debug === '1' || req.query.debug === 'true',
    });

    return res.json(result);
  } catch (error) {
    console.error('Sheet lookup error:', error);
    return res.json({
      found: false,
      internalShipmentNo: String(req.query.internalShipmentNo || '').trim(),
      skus: [],
      rowCount: 0,
      reason: 'sheet_unavailable',
      error: 'Sheet lookup failed. Enter SKUs manually.',
    });
  }
});

// Build the packing report for one consignment (shared by the report endpoint
// and the Google Sheet push).
async function loadPackingReport(consignmentId) {
  const consignment = await firestoreHelpers.getDocument('consignments', consignmentId);
  if (!consignment) return null;

  const skuIds = consignment.skuIds || [];
  const boxIds = consignment.boxIds || [];
  const [skus, boxResult] = await Promise.all([
    skuIds.length ? firestoreHelpers.batchGetDocuments('skus', skuIds) : Promise.resolve([]),
    getSavedBoxesForConsignment(consignmentId, boxIds),
  ]);

  return {
    consignment,
    report: buildPackingReport(consignment, skus.filter(Boolean), boxResult.boxes, boxResult.missingBoxIds),
  };
}

// Push box-wise packing data (sheet columns I and J) to the Consignment Master
// sheet. Writes fixed cells, so re-running is harmless.
router.post('/:id/sheet-push', authenticateToken, requirePermission('consignments', 'push packing data to Google Sheets'), async (req, res) => {
  try {
    const { id } = req.params;
    const loaded = await loadPackingReport(id);
    if (!loaded) return res.status(404).json({ error: 'Consignment not found' });

    const { consignment, report } = loaded;
    const internalShipmentNo = consignment.internalShipmentNo || '';
    if (!internalShipmentNo) {
      return res.status(400).json({ error: 'This consignment has no Internal Shipment No., so no sheet rows can be matched.' });
    }

    const result = await pushPackingToSheet({
      internalShipmentNo,
      reportRows: report.rows || [],
      dryRun: req.query.dryRun === '1' || req.query.dryRun === 'true',
    });

    if (!result.ok) {
      return res.status(result.reason === 'shipment_not_in_sheet' ? 404 : 502).json({
        error: result.error || 'Push to Google Sheet failed.',
        ...result,
      });
    }

    if (!result.dryRun) {
      const pushedAt = now();
      const sheetPush = {
        at: pushedAt,
        by: req.user?.id || '',
        byName: req.user?.name || req.user?.email || '',
        trigger: 'manual',
        updated: result.updated || 0,
        fingerprint: result.fingerprint || '',
      };
      // setDocument shallow-merges (Firestore { merge: true } semantics).
      // updatedAt is deliberately left alone: a push does not change the
      // consignment itself, and the daily sweep treats sheetPush.at < updatedAt
      // as "packing changed since the last push".
      await firestoreHelpers.setDocument('consignments', id, { sheetPush });
      await addAuditLog('sheet_push', 'consignment', id, req.user?.id, {
        internalShipmentNo,
        updated: result.updated || 0,
        cleared: result.cleared || 0,
        unmatched: (result.unmatchedSkus || []).length,
      });
    }

    return res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

// Box-derived packing report. This intentionally does not use sku.packedQty or
// sku.boxQuantities for report numbers; those are checked only for integrity.
router.get('/:id/packing-report', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'view packing reports'), async (req, res) => {
  try {
    const loaded = await loadPackingReport(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Consignment not found' });

    res.json({ report: loaded.report });
  } catch (error) {
    sendError(res, error);
  }
});

// Download prebuilt OMSGuru removal template for a shipment
router.get('/:id/oms-guru/template', authenticateToken, requirePermission('consignments', 'download OMSGuru templates'), async (req, res) => {
  try {
    const { id } = req.params;
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const skuIds = consignment.skuIds || [];
    const skus = skuIds.length
      ? (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean)
      : [];
    const csv = await buildOmsGuruTemplateCsv(id, skus);
    const safeName = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="oms_guru_removed_${safeName}.csv"`);
    res.send(csv);
  } catch (error) {
    sendError(res, error, 'Failed to generate OMSGuru template');
  }
});

// Import OMSGuru removed quantities from CSV
router.post('/:id/oms-guru/import', authenticateToken, requirePermission('consignments', 'update OMSGuru quantities'), omsGuruUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const skuIds = consignment.skuIds || [];
    const skus = skuIds.length
      ? (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean)
      : [];
    if (!skus.length) {
      return res.status(400).json({ error: 'This consignment has no SKUs to update' });
    }

    const rows = await parseOmsGuruCsv(req.file.buffer);
    if (!rows.length) {
      return res.status(400).json({ error: 'CSV file is empty or has no data rows' });
    }

    const allErrors = [];
    const changes = [];
    const updates = new Map();
    const timestamp = now();
    const userName = req.user.name || req.user.email || req.user.id;

    rows.forEach((row, index) => {
      const rowIndex = index + 2;
      const sku = findSkuForImportRow(skus, row);
      const validation = validateImportRow(id, row, sku, rowIndex);
      if (validation.errors.length) {
        allErrors.push(...validation.errors);
        return;
      }
      if (validation.skip || validation.removedQty == null) return;

      const previousRemoved = toNumber(sku.omsGuruRemovedQty);
      const previousRemarks = sku.omsGuruRemarks || '';
      const nextRemarks = validation.remarks ?? previousRemarks;

      if (validation.removedQty === previousRemoved && nextRemarks === previousRemarks) return;

      updates.set(sku.id, {
        ...sku,
        omsGuruRemovedQty: validation.removedQty,
        omsGuruRemarks: nextRemarks,
        omsGuruUpdatedAt: timestamp,
        omsGuruUpdatedBy: userName,
        updatedAt: timestamp,
      });

      changes.push({
        skuId: sku.id,
        internalSku: sku.internalSku || '',
        marketplaceSku: sku.marketplaceSku || '',
        previousRemovedQty: previousRemoved,
        newRemovedQty: validation.removedQty,
        remarks: nextRemarks,
      });
    });

    if (allErrors.length) {
      return res.status(400).json({
        error: 'CSV validation failed',
        errors: allErrors,
        updatedSkuCount: 0,
      });
    }

    if (!updates.size) {
      return res.status(400).json({ error: 'No OMSGuru Removed Qty values were provided to update' });
    }

    await Promise.all(
      Array.from(updates.values()).map((sku) => firestoreHelpers.setDocument('skus', sku.id, sku))
    );

    const updatedSkus = skus.map((sku) => updates.get(sku.id) || sku);
    const omsGuruSummary = summarizeOmsGuruSkus(updatedSkus);

    const logId = generateId();
    const uploadLog = {
      id: logId,
      consignmentId: id,
      fileName: req.file.originalname || 'oms_guru_import.csv',
      uploadedBy: req.user.id,
      uploadedByName: userName,
      rowCount: rows.length,
      updatedSkuCount: updates.size,
      errorCount: 0,
      errors: [],
      changes,
      createdAt: timestamp,
    };
    await persistOmsGuruUploadLog(uploadLog);

    await addAuditLog('import', 'oms_guru_sku', id, req.user.id, {
      fileName: uploadLog.fileName,
      updatedSkuCount: updates.size,
      rowCount: rows.length,
      changes,
    });

    emitConsignmentChange({ id, updatedAt: timestamp });

    res.json({
      ok: true,
      updatedSkuCount: updates.size,
      omsGuruSummary: {
        totalRequiredQty: omsGuruSummary.totalRequiredQty,
        totalPackedQty: omsGuruSummary.totalPackedQty,
        totalOmsGuruRemovedQty: omsGuruSummary.totalOmsGuruRemovedQty,
        totalBalanceQty: omsGuruSummary.totalBalanceQty,
        removalCompletionPct: omsGuruSummary.removalCompletionPct,
        mismatchCount: omsGuruSummary.mismatchCount,
      },
      skus: omsGuruSummary.skus,
    });
  } catch (error) {
    sendError(res, error, 'Failed to import OMSGuru quantities');
  }
});

// Admin-only upload history for OMSGuru imports on a shipment
router.get('/:id/oms-guru/uploads', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const uploads = await fetchOmsGuruUploadLogs(id);
    res.json({ uploads });
  } catch (error) {
    sendError(res, error, 'Failed to load OMSGuru upload history');
  }
});

// Inward template download
router.get('/:id/inward/template', authenticateToken, requirePermission('consignments', 'download inward templates'), async (req, res) => {
  try {
    const { id } = req.params;
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });
    const skuIds = consignment.skuIds || [];
    const skus = skuIds.length
      ? (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean)
      : [];
    const csv = buildInwardTemplateCsv(consignment, skus);
    const safeName = String(id).replace(/[^a-zA-Z0-9_-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inward_${safeName}.csv"`);
    res.send(csv);
  } catch (error) {
    sendError(res, error, 'Failed to generate inward template');
  }
});

// Inward CSV import — never overwrites packed quantities
router.post('/:id/inward/import', authenticateToken, requirePermission('consignments', 'upload inward data'), inwardUpload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'CSV file is required' });
    }
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const skuIds = consignment.skuIds || [];
    const skus = skuIds.length
      ? (await firestoreHelpers.batchGetDocuments('skus', skuIds)).filter(Boolean)
      : [];

    const rows = await parseInwardCsv(req.file.buffer);
    const uploadId = generateId();
    const timestamp = now();
    const errors = [];
    const changes = [];
    let updatedSkuCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const validation = validateInwardRow(row);
      if (validation.skip) continue;
      if (validation.error) {
        errors.push({ row: i + 2, error: validation.error });
        continue;
      }
      const sku = findSkuForInwardRow(skus, row);
      if (!sku) {
        errors.push({ row: i + 2, error: 'SKU not found in this consignment' });
        continue;
      }
      const packedQty = Number(sku.packedQty) || 0;
      const inwardQty = validation.inwardQty;
      const inwardStatus = computeInwardStatus(packedQty, inwardQty);
      const quantityDifference = computeQuantityDifference(packedQty, inwardQty);
      await firestoreHelpers.setDocument('skus', sku.id, {
        inwardQty,
        inwardStatus,
        quantityDifference,
        inwardDate: validation.inwardDate,
        inwardRemarks: validation.remarks,
        inwardUploadRef: uploadId,
        inwardUploadId: uploadId,
        inwardUpdatedAt: timestamp,
        inwardUpdatedBy: req.user.id,
        // packedQty intentionally unchanged
        updatedAt: timestamp,
      });
      sku.inwardQty = inwardQty;
      sku.inwardStatus = inwardStatus;
      sku.quantityDifference = quantityDifference;
      updatedSkuCount += 1;
      changes.push({
        skuId: sku.id,
        internalSku: sku.internalSku,
        packedQty,
        inwardQty,
        quantityDifference,
        inwardStatus,
      });
    }

    const inwardSummary = summarizeInwardSkus(skus);
    await firestoreHelpers.setDocument('consignments', id, {
      inwardMismatch: inwardSummary.hasMismatch,
      inwardLastUploadId: uploadId,
      inwardLastUploadAt: timestamp,
      unitsInwarded: inwardSummary.totalInwardQty,
      dateOfInward: consignment.dateOfInward || timestamp.slice(0, 10),
      updatedAt: timestamp,
    });

    await firestoreHelpers.setDocument('inward_upload_logs', uploadId, {
      id: uploadId,
      consignmentId: id,
      fileName: req.file.originalname,
      uploadedBy: req.user.id,
      uploadedByName: req.user.name || req.user.email,
      rowCount: rows.length,
      updatedSkuCount,
      errorCount: errors.length,
      errors,
      changes,
      createdAt: timestamp,
    });

    await addAuditLog('inward_import', 'consignment', id, req.user.id, {
      uploadId,
      updatedSkuCount,
      errorCount: errors.length,
      mismatchCount: inwardSummary.mismatchCount,
    });

    emitConsignmentChange({
      id,
      inwardMismatch: inwardSummary.hasMismatch,
      unitsInwarded: inwardSummary.totalInwardQty,
      updatedAt: timestamp,
      realtimeType: 'inward_import',
    });

    res.json({
      uploadId,
      updatedSkuCount,
      errorCount: errors.length,
      errors,
      inwardSummary,
      skus: inwardSummary.skus,
    });
  } catch (error) {
    sendError(res, error, 'Failed to import inward data');
  }
});

router.get('/:id/inward/uploads', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const uploads = await firestoreHelpers.queryCollection('inward_upload_logs', 'consignmentId', '==', req.params.id);
    res.json({
      uploads: (uploads || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
    });
  } catch (error) {
    sendError(res, error, 'Failed to load inward upload history');
  }
});

// Box-wise quantity edit (history via packing_adjustments)
router.post('/:id/boxes/:boxNo/edit-quantity', authenticateToken, requirePermission('editBoxQuantities', 'edit box quantities'), async (req, res) => {
  try {
    const { id, boxNo } = req.params;
    const { sku_id: skuId, quantity, reason, remarks } = req.body || {};
    if (!skuId) return res.status(400).json({ error: 'sku_id is required' });

    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const boxId = `${id}_box_${boxNo}`;
    const box = await firestoreHelpers.getDocument('boxes', boxId);
    if (!box) return res.status(404).json({ error: 'Box not found' });

    const result = await applyBoxQuantityEdit({
      consignment,
      box,
      skuId,
      newQuantity: quantity,
      reason,
      remarks,
      user: req.user,
    });

    // Invalidate packing draft/session so totals reflect the edit
    try {
      const { clearDraft } = require('../utils/packingDraft');
      const packingRouter = require('./packing');
      await clearDraft(id);
      if (typeof packingRouter.clearPackingSession === 'function') {
        packingRouter.clearPackingSession(id);
      }
    } catch (invalidateErr) {
      console.warn('[edit-quantity] session invalidate failed:', invalidateErr.message);
    }

    const adjustments = await listAdjustmentsForBox(id, boxNo);
    res.json({
      ...result,
      history: summarizeBoxHistory(result.box, adjustments),
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Correct a mis-scanned box number (e.g. a SKU barcode landed in the box-no
// field instead of a plain digit like "4"). Items, weight, video, and history
// all move to the corrected number — reuses the editBoxQuantities permission
// since this is the same "authorized correction to packed data" trust tier.
router.post('/:id/boxes/:boxNo/rename', authenticateToken, requirePermission('editBoxQuantities', 'rename box numbers'), async (req, res) => {
  try {
    const { id, boxNo } = req.params;
    const { new_box_no: newBoxNo, reason, remarks } = req.body || {};

    const result = await renameBoxNo({
      consignmentId: id,
      oldBoxNo: boxNo,
      newBoxNo,
      reason,
      remarks,
      user: req.user,
    });

    // Invalidate packing draft/session so a resumed session doesn't reopen the old box number
    try {
      const { clearDraft } = require('../utils/packingDraft');
      const packingRouter = require('./packing');
      await clearDraft(id);
      if (typeof packingRouter.clearPackingSession === 'function') {
        packingRouter.clearPackingSession(id);
      }
    } catch (invalidateErr) {
      console.warn('[rename-box] session invalidate failed:', invalidateErr.message);
    }

    // renameBoxNo() already writes the box_renumbered audit log entry.
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

// Get single consignment
router.get('/:id', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'view consignments'), async (req, res) => {
  try {
    const { id } = req.params;
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const fetchRelated = async (ids, collection) => {
      if (!ids?.length) return [];
      return firestoreHelpers.batchGetDocuments(collection, ids);
    };

    const boxesPromise = consignment.boxIds?.length
      ? fetchRelated(consignment.boxIds, 'boxes')
      : firestoreHelpers.queryCollection('boxes', 'consignmentId', '==', id)
    const videosPromise = consignment.videoIds?.length
      ? fetchRelated(consignment.videoIds, 'videos')
      : firestoreHelpers.queryCollection('videos', 'consignmentId', '==', id)
    const documentsPromise = consignment.documentIds?.length
      ? fetchRelated(consignment.documentIds, 'documents')
      : firestoreHelpers.queryCollection('documents', 'consignmentId', '==', id)

    const [skus, boxesRaw, videosRaw, documentsRaw, marketplace, adjustments] = await Promise.all([
      fetchRelated(consignment.skuIds, 'skus'),
      boxesPromise,
      videosPromise,
      documentsPromise,
      consignment.marketplaceId ? firestoreHelpers.getDocument('marketplaces', consignment.marketplaceId) : null,
      listAdjustmentsForConsignment(id),
    ]);

    const uniqueById = (records = []) => {
      const byId = new Map();
      records.filter(Boolean).forEach((record) => {
        const recordId = record.id || record.data?.id;
        if (recordId) byId.set(recordId, { ...record, id: recordId });
      });
      return Array.from(byId.values());
    };

    const boxes = uniqueById(boxesRaw || []).sort((a, b) => {
      const aNo = String(a.boxNo || a.box_no || '');
      const bNo = String(b.boxNo || b.box_no || '');
      return aNo.localeCompare(bNo, undefined, { numeric: true });
    });

    const videos = uniqueById(videosRaw || []);
    const documents = uniqueById(documentsRaw || []);

    // playUrl is a local API path — no remote signed-URL round trips on detail load
    const enrichedVideos = videos.map((v) => ({
      ...v,
      type: 'video',
      storageProvider: v.storageProvider || 'r2',
      playUrl: v.id ? `/api/uploads/stream/${encodeURIComponent(v.id)}?type=video` : null,
      url: v.url || null,
    }));
    const enrichedDocuments = documents.map((d) => ({
      ...d,
      type: 'document',
      storageProvider: d.storageProvider || 'r2',
      playUrl: d.id ? `/api/uploads/stream/${encodeURIComponent(d.id)}?type=document` : null,
      url: d.url || null,
    }));

    const postgresSupport = pgEnabled();

    const marketplaceMap = marketplace ? { [marketplace.id]: marketplace } : {};
    const enriched = enrichWorkflowFields(enrichConsignment(consignment, marketplaceMap));
    const isArchived = Boolean(enriched.isArchived || enriched.operationalStatus === 'archived');
    const validSkus = (skus || []).filter(Boolean);

    // Boxes are the source of truth for packed qty (reflects removals/edits)
    const fromBoxes = recomputePackedFromBoxes(validSkus, boxes);
    const skusAligned = fromBoxes.skus.map((sku) => {
      const stored = validSkus.find((s) => s.id === sku.id) || {};
      return {
        ...stored,
        ...sku,
        inwardQty: stored.inwardQty,
        inwardStatus: stored.inwardStatus,
        inwardDate: stored.inwardDate,
        inwardRemarks: stored.inwardRemarks,
        inwardUploadRef: stored.inwardUploadRef,
        quantityDifference: stored.inwardQty != null
          ? (Number(stored.inwardQty) || 0) - (Number(sku.packedQty) || 0)
          : stored.quantityDifference,
      };
    });
    const skusWithAdjustments = enrichSkusWithAdjustments(skusAligned, adjustments);
    const omsGuruSummary = summarizeOmsGuruSkus(skusWithAdjustments);
    const inwardSummary = summarizeInwardSkus(omsGuruSummary.skus);

    // Heal stale consignment.totalPackedQty if it drifted from box contents
    if (Number(enriched.totalPackedQty) !== fromBoxes.totalPackedQty) {
      enriched.totalPackedQty = fromBoxes.totalPackedQty;
      firestoreHelpers.setDocument('consignments', id, {
        totalPackedQty: fromBoxes.totalPackedQty,
        updatedAt: now(),
      }).catch(() => {});
    }

    const boxesWithHistory = boxes.map((box) => {
      const boxAdjustments = adjustments.filter((a) => String(a.boxNo) === String(box.boxNo));
      const itemTotal = (box.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
      return {
        ...box,
        totalQty: itemTotal,
        history: summarizeBoxHistory({ ...box, totalQty: itemTotal }, boxAdjustments),
        adjustments: boxAdjustments,
      };
    });

    res.json({
      consignment: {
        ...enriched,
        totalPackedQty: fromBoxes.totalPackedQty,
        skus: inwardSummary.skus,
        boxes: boxesWithHistory,
        videos: enrichedVideos,
        documents: enrichedDocuments,
        marketplace,
        isArchived,
        pgEnabled: postgresSupport,
        packingAdjustments: adjustments,
        omsGuruSummary: {
          totalRequiredQty: omsGuruSummary.totalRequiredQty,
          totalPackedQty: fromBoxes.totalPackedQty,
          totalOmsGuruRemovedQty: omsGuruSummary.totalOmsGuruRemovedQty,
          totalBalanceQty: omsGuruSummary.totalBalanceQty,
          removalCompletionPct: omsGuruSummary.removalCompletionPct,
          mismatchCount: omsGuruSummary.mismatchCount,
        },
        inwardSummary: {
          totalPackedQty: fromBoxes.totalPackedQty,
          totalInwardQty: inwardSummary.totalInwardQty,
          totalDifference: inwardSummary.totalInwardQty - fromBoxes.totalPackedQty,
          mismatchCount: inwardSummary.mismatchCount,
          notInwardedCount: inwardSummary.notInwardedCount,
          fullyInwardedCount: inwardSummary.fullyInwardedCount,
          shortCount: inwardSummary.shortCount,
          excessCount: inwardSummary.excessCount,
          hasMismatch: inwardSummary.hasMismatch,
        },
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Create consignment
router.post('/', authenticateToken, requirePermission('consignments', 'create consignment'), async (req, res) => {
  try {
    const { id, shipmentNo, internalShipmentNo, name, description, expectedDate, marketplaceId, warehouse,
      poExpiryDate, appointmentDate, scheduledDispatchDate, actualDispatchDate, dateOfInward,
      forwardInvoiceNo, docketCompany, docketNo, marketplaceTicketId, shipmentStatus, isDisputed,
      unitsShipped, unitsReceived, unitsInwarded, qaFailExcessQty, skus = [] } = req.body;
    
    if (!internalShipmentNo) return res.status(400).json({ error: 'Internal Shipment No. is required' });

    const trimmedInternal = String(internalShipmentNo || '').trim();
    const trimmedRequestedId = String(id || '').trim();
    const resolvedId = buildConsignmentId(trimmedRequestedId, trimmedInternal);
    if (!resolvedId) return res.status(400).json({ error: 'Internal Shipment No. is required to create a consignment.' });

    // Block reuse of the same Consignment ID / Internal Shipment No (including archived).
    const conflict = await findConsignmentIdentityConflict({
      keys: [resolvedId, trimmedRequestedId, trimmedInternal, shipmentNo],
    });
    if (conflict) {
      return res.status(409).json({
        error: formatIdentityConflictError(conflict),
        code: 'CONSIGNMENT_ALREADY_EXISTS',
        field: conflict.field,
        value: conflict.value,
        existingId: conflict.consignment?.id || null,
      });
    }

    const pendingExternalId = !trimmedRequestedId;

    const consignmentData = {
      id: resolvedId,
      internalShipmentNo: trimmedInternal,
      pendingExternalId,
      name: name || trimmedInternal,
      shipmentNo: String(shipmentNo || trimmedInternal || '').trim(),
      description: description || '',
      expectedDate: expectedDate || '',
      marketplaceId: marketplaceId || '',
      warehouse: warehouse || '',
      poExpiryDate: poExpiryDate || '',
      appointmentDate: appointmentDate || '',
      scheduledDispatchDate: scheduledDispatchDate || '',
      actualDispatchDate: actualDispatchDate || '',
      dateOfInward: dateOfInward || '',
      forwardInvoiceNo: forwardInvoiceNo || '',
      docketCompany: docketCompany || '',
      docketNo: docketNo || '',
      marketplaceTicketId: marketplaceTicketId || '',
      isDisputed: Boolean(isDisputed),
      shipmentStatus: shipmentStatus || 'Planned',
      status: 'pending',
      stageConfirmations: emptyStageConfirmations(),
      tatDeadlines: buildTatDeadlines(now()),
      groundTeamUserId: null,
      groundTeamName: null,
      groundTeamEmail: null,
      isEscalated: false,
      escalationLevel: 0,
      skuIds: [],
      boxIds: [],
      videoIds: [],
      documentIds: [],
      totalRequiredQty: 0,
      totalPackedQty: 0,
      unitsShipped: Number(unitsShipped) || 0,
      unitsReceived: Number(unitsReceived) || 0,
      unitsInwarded: Number(unitsInwarded) || 0,
      qaFailExcessQty: Number(qaFailExcessQty) || 0,
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id
    };

    const skuIds = [];
    let totalRequiredQty = 0;
    const skuBatch = [];
    
    for (const sku of skus) {
      const skuId = generateId();
      const normalizedSku = normalizeSkuInput(sku, { marketplaceId });
      const skuData = {
        id: skuId,
        consignmentId: resolvedId,
        // The packing scanner must use the marketplace barcode (FNSKU/FSN/ASIN/etc.).
        ...normalizedSku,
        marketplaceId: normalizedSku.marketplaceId || marketplaceId || '',
        requiredQty: parseInt(sku.requiredQty) || 0,
        packedQty: 0,
        omsGuruRemovedQty: 0,
        omsGuruRemarks: '',
        boxQuantities: {},
        status: 'pending',
        createdAt: now(),
        updatedAt: now()
      };
      skuBatch.push([skuId, skuData]);
      skuIds.push(skuId);
      totalRequiredQty += skuData.requiredQty;
    }

    consignmentData.skuIds = skuIds;
    consignmentData.totalRequiredQty = totalRequiredQty;

    const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
    const planned = await applyDispatchPlanning(consignmentData, marketplaceMap);

    await firestoreHelpers.batchCreateMulti([
      ['consignments', resolvedId, planned],
      ...skuBatch.map(([skuId, skuData]) => ['skus', skuId, skuData]),
    ]);
    addAuditLog('create', 'consignment', resolvedId, req.user.id, { internalShipmentNo: trimmedInternal, skuCount: skus.length, pendingExternalId })
      .catch((auditError) => console.warn('[Consignments] Create audit log failed:', auditError.message));

    // Create TaskFlow workflow before responding so failures are visible on consignment.taskflow.
    let taskflowResult = null;
    try {
      const { syncConsignmentCreated, isTaskflowEnabled, getTaskflowStatus } = require('../utils/taskflowBridge');
      if (isTaskflowEnabled()) {
        taskflowResult = await Promise.race([
          syncConsignmentCreated(planned, { force: true }),
          new Promise((resolve) => setTimeout(() => resolve({ skipped: true, reason: 'timeout' }), 12000)),
        ]);
      } else {
        const status = getTaskflowStatus();
        console.warn('[Consignments] TaskFlow disabled/unconfigured on create', status.missing);
        taskflowResult = { skipped: true, reason: 'disabled_or_unconfigured', missing: status.missing };
      }
    } catch (tfError) {
      console.error('[Consignments] TaskFlow create failed:', tfError.message);
      taskflowResult = { ok: false, error: tfError.message };
    }

    const refreshed = await firestoreHelpers.getDocument('consignments', resolvedId);
    const consignmentOut = refreshed || planned;

    res.status(201).json({
      consignment: consignmentOut,
      taskflow: taskflowResult,
    });
    emitConsignmentChange({
      id: resolvedId,
      status: consignmentOut.status,
      shipmentStatus: consignmentOut.shipmentStatus,
      totalPackedQty: consignmentOut.totalPackedQty,
      totalRequiredQty: consignmentOut.totalRequiredQty,
      internalShipmentNo: consignmentOut.internalShipmentNo,
      updatedAt: consignmentOut.updatedAt,
    });
    try {
      require('../utils/inventoryNotify').scheduleInventoryPlanningCheck('new_shortage');
    } catch (_) { /* non-blocking */ }
  } catch (error) {
    if (error?.code === 'DOCUMENT_ALREADY_EXISTS' || error?.statusCode === 409) {
      return res.status(409).json({
        error: 'Consignment ID already exists. You cannot create the same consignment again.',
        code: 'CONSIGNMENT_ALREADY_EXISTS',
      });
    }
    sendError(res, error);
  }
});

// Assign official consignment ID when it arrives later (migrates document + related records)
router.post('/:id/reassign-id', authenticateToken, requirePermission('consignments', 'update consignment'), async (req, res) => {
  try {
    const { id } = req.params;
    const { newConsignmentId } = req.body || {};
    const result = await reassignConsignmentId(id, newConsignmentId, req.user.id);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
    const enriched = enrichConsignment(result.consignment, marketplaceMap);
    await addAuditLog('update', 'consignment', result.newId, req.user.id, {
      action: 'reassign-id',
      oldId: result.oldId,
      newId: result.newId,
    });
    emitConsignmentChange({
      id: result.newId,
      oldId: result.oldId,
      status: enriched.status,
      shipmentStatus: enriched.shipmentStatus,
      internalShipmentNo: enriched.internalShipmentNo,
      updatedAt: enriched.updatedAt,
    });
    syncConsignmentIdChange(result.oldId, enriched).catch(() => {});
    res.json({ consignment: enriched, oldId: result.oldId, newId: result.newId });
  } catch (error) {
    sendError(res, error);
  }
});

// Update consignment
router.put('/:id', authenticateToken, requirePermission('consignments', 'update consignment'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const existing = await firestoreHelpers.getDocument('consignments', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const allowed = ['name', 'shipmentNo', 'internalShipmentNo', 'description', 'expectedDate', 'marketplaceId', 'warehouse',
      'poExpiryDate', 'appointmentDate', 'scheduledDispatchDate', 'actualDispatchDate', 'dateOfInward',
      'forwardInvoiceNo', 'docketCompany', 'docketNo', 'marketplaceTicketId', 'isDisputed', 'shipmentStatus', 'status',
      'unitsShipped', 'unitsReceived', 'unitsInwarded', 'qaFailExcessQty',
      'omsGuruQtyRemoved', 'omsGuruQtyRemovedAt', 'omsGuruQtyRemovedBy',
      'groundTeamUserId', 'groundTeamName', 'groundTeamEmail'];
    const updateData = { updatedAt: now() };
    allowed.forEach(f => { if (updates[f] !== undefined) updateData[f] = updates[f]; });

    if (updateData.shipmentStatus && updateData.shipmentStatus !== existing.shipmentStatus) {
      const gate = canAdvanceLogistics(existing, updateData.shipmentStatus);
      if (!gate.ok) {
        return res.status(409).json({ error: gate.error, code: gate.code });
      }
    }

    const merged = { ...existing, ...updateData };
    const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
    const updated = await applyDispatchPlanning(merged, marketplaceMap);
    await firestoreHelpers.setDocument('consignments', id, updated);
    await addAuditLog('update', 'consignment', id, req.user.id, updateData);
    const enriched = enrichConsignment(updated, marketplaceMap);
    emitConsignmentChange({
      id,
      status: enriched.status,
      shipmentStatus: enriched.shipmentStatus,
      totalPackedQty: enriched.totalPackedQty,
      totalRequiredQty: enriched.totalRequiredQty,
      internalShipmentNo: enriched.internalShipmentNo,
      updatedAt: enriched.updatedAt,
    });
    res.json({ consignment: enriched });
    const planningFields = ['appointmentDate', 'scheduledDispatchDate', 'marketplaceId', 'warehouse', 'status', 'shipmentStatus'];
    const touchedPlanning = planningFields.some((f) => updates[f] !== undefined && updates[f] !== existing[f]);
    if (touchedPlanning) {
      try {
        require('../utils/inventoryNotify').scheduleInventoryPlanningCheck('priority_change');
      } catch (_) { /* non-blocking */ }
    }
  } catch (error) {
    sendError(res, error);
  }
});

// Delete consignment
router.delete('/:id', authenticateToken, requirePermission(DELETE_CONSIGNMENTS, 'delete consignments'), async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmationText } = req.body || {};
    const existing = await firestoreHelpers.getDocument('consignments', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (!matchesDeletionConfirmation(existing, confirmationText)) {
      return res.status(400).json({
        error: 'Deletion confirmation does not match the Consignment ID or name.',
      });
    }

    const plan = await collectConsignmentDeletionPlan(existing);
    const storageDeleted = await deleteStorageRecordsForPlan(plan);
    const result = pgEnabled()
      ? await deleteConsignmentPlanFromPostgres(plan, req.user.id, storageDeleted)
      : await deleteConsignmentPlanWithHelpers(plan, req.user.id, storageDeleted);

    emitConsignmentChange({
      id,
      deleted: true,
      updatedAt: now(),
      internalShipmentNo: existing.internalShipmentNo || '',
    });

    res.json({
      message: 'Consignment permanently deleted.',
      deleted: {
        consignmentId: id,
        storageFiles: storageDeleted.length,
        relatedRecords: Object.fromEntries(
          Object.entries(plan.collections).map(([collectionName, records]) => [collectionName, records.length])
        ),
        ...(result || {}),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id/labels', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'download labels'), async (req, res) => {
  try {
    const consignment = await firestoreHelpers.getDocument('consignments', req.params.id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const boxes = consignment.boxIds?.length
      ? (await firestoreHelpers.batchGetDocuments('boxes', consignment.boxIds)).filter(Boolean)
      : await firestoreHelpers.queryCollection('boxes', 'consignmentId', '==', consignment.id);

    if (!boxes.length) {
      return res.status(404).json({ error: 'No saved boxes available for labels.' });
    }

    const lines = ['shipmentId,boxNo,internalSku,qty,packedQty'];
    const shipmentId = consignment.internalShipmentNo || consignment.shipmentNo || consignment.id;
    for (const box of boxes) {
      const boxNo = box.boxNo || box.box_no || '';
      for (const item of box.items || []) {
        const qty = Number(item.qty ?? item.quantity) || 0;
        if (qty <= 0) continue;
        lines.push([
          JSON.stringify(String(shipmentId)),
          JSON.stringify(String(boxNo)),
          JSON.stringify(String(item.internalSku || item.sku || '')),
          qty,
          qty,
        ].join(','));
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="labels-${shipmentId}.csv"`);
    res.send(lines.join('\n'));
  } catch (error) {
    sendError(res, error);
  }
});

// Legacy direct SKU pack — disabled. Packed totals must come from saved boxes via /api/packing.
router.post('/:id/skus/:skuId/pack', authenticateToken, requirePermission('packing', 'pack items'), async (_req, res) => {
  return res.status(410).json({
    error: 'This legacy packing endpoint is disabled. Use the Packing Station (/api/packing) so packed quantities are derived from saved boxes.',
    code: 'LEGACY_PACK_DISABLED',
  });
});

// Save box
router.post('/:id/boxes', authenticateToken, requirePermission('packing', 'save boxes'), async (req, res) => {
  try {
    const { id } = req.params;
    const { boxNo, items, notes } = req.body;
    if (!boxNo) return res.status(400).json({ error: 'Box number required' });

    const normalizedItems = (items || []).map((item) => {
      const qty = parsePositiveQty(item.qty ?? item.quantity);
      if (!qty) {
        const error = new Error('Box contains an item with invalid quantity');
        error.statusCode = 400;
        throw error;
      }
      return { ...item, qty };
    });
    if (!normalizedItems.length) return res.status(400).json({ error: 'Box is empty' });

    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Not found' });

    const boxId = `${id}_box_${boxNo}`;
    const timestamp = now();
    const boxData = {
      id: boxId,
      consignmentId: id,
      boxNo: String(boxNo),
      items: normalizedItems,
      notes: notes || '',
      totalQty: normalizedItems.reduce((sum, item) => sum + item.qty, 0),
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id
    };
    const auditLog = {
      id: generateId(),
      action: 'save_box',
      entityType: 'box',
      entityId: boxId,
      userId: req.user.id,
      details: { boxNo, itemCount: normalizedItems.length },
      timestamp,
    };
    const productivityEvent = {
      id: generateId(),
      consignmentId: id,
      boxNo: String(boxNo),
      eventType: 'box_saved',
      itemsCount: boxData.totalQty,
      timestamp,
      userId: req.user.id,
    };

    let saveResult = null;
    if (pgEnabled()) {
      saveResult = await saveBoxWithPostgresTransaction({
        consignmentId: id,
        boxId,
        boxData,
        userId: req.user.id,
        timestamp,
        getStatusUpdates: ({ consignment: lockedConsignment, allCompleted }) => getSaveBoxUpdates(lockedConsignment, allCompleted) || {
          status: allCompleted ? 'completed' : 'in_progress',
          updatedAt: timestamp,
        },
        auditLog,
        productivityEvent,
      });
    } else {
      const boxIds = new Set(consignment.boxIds || []);
      boxIds.add(boxId);

      const skuDocs = await firestoreHelpers.batchGetDocuments('skus', consignment.skuIds || []);
      const existingBoxes = await getSavedBoxesForConsignment(id, consignment.boxIds || []);
      const boxesById = new Map(existingBoxes.boxes.map((box) => [box.id, box]));
      boxesById.set(boxId, boxData);
      const consignmentForReport = { ...consignment, boxIds: Array.from(boxIds) };
      const { report, skuUpdates } = calculateBoxDerivedSkuUpdates(
        consignmentForReport,
        skuDocs.filter(Boolean),
        Array.from(boxesById.values()),
        existingBoxes.missingBoxIds
      );
      const totalRequiredQty = report.summary.totalRequired;
      const totalPackedQty = report.summary.totalPacked;
      const allCompleted = report.rows.length > 0 && report.rows.every((row) => row.required > 0 && row.packedFromBoxes >= row.required);
      const statusUpdates = getSaveBoxUpdates(consignment, allCompleted) || {
        status: allCompleted ? 'completed' : 'in_progress',
        updatedAt: timestamp,
      };

      await firestoreHelpers.batchSetMulti([
        ['boxes', boxId, boxData],
        ...skuUpdates,
        ['consignments', id, {
          boxIds: Array.from(boxIds),
          totalPackedQty,
          totalRequiredQty,
          ...statusUpdates,
        }],
      ]);
      await addAuditLog('save_box', 'box', boxId, req.user.id, { boxNo, itemCount: normalizedItems.length });
      await firestoreHelpers.setDocument('productivity', productivityEvent.id, productivityEvent);
    }

    const refreshed = saveResult?.consignment || await firestoreHelpers.getDocument('consignments', id);
    const [skuDocs, boxResult] = await Promise.all([
      firestoreHelpers.batchGetDocuments('skus', refreshed?.skuIds || []),
      getSavedBoxesForConsignment(id, refreshed?.boxIds || []),
    ]);
    const report = buildPackingReport(refreshed || consignment, skuDocs.filter(Boolean), boxResult.boxes, boxResult.missingBoxIds);
    const allCompleted = report.rows.length > 0 && report.rows.every((row) => row.required > 0 && row.packedFromBoxes >= row.required);
    const derivedStatus = allCompleted ? 'completed' : report.summary.totalPacked > 0 ? 'in_progress' : 'pending';

    emitConsignmentChange({
      id,
      status: refreshed?.status || derivedStatus,
      shipmentStatus: refreshed?.shipmentStatus || consignment.shipmentStatus,
      totalPackedQty: report.summary.totalPacked,
      totalRequiredQty: report.summary.totalRequired,
      internalShipmentNo: refreshed?.internalShipmentNo || consignment.internalShipmentNo,
      updatedAt: refreshed?.updatedAt || timestamp,
    });

    res.status(201).json({
      box: boxData,
      reportSummary: report.summary,
      integrityIssues: report.integrityIssues,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Soft-archive consignment (keeps PostgreSQL data; hides from active lists)
router.post('/:id/archive', authenticateToken, requirePermission('consignments', 'archive consignments'), async (req, res) => {
  try {
    const { id } = req.params;
    const consignment = await firestoreHelpers.getDocument('consignments', id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const gate = canArchiveConsignment(consignment);
    if (!gate.ok) {
      return res.status(409).json({ error: gate.error, code: gate.code });
    }

    const archivedAt = now();
    const updates = {
      operationalStatus: 'archived',
      isArchived: true,
      archivedAt,
      archivedReason: req.body?.reason
        || (isStageConfirmed(consignment, 'inward_completed')
          ? 'Inward verified — archived'
          : 'Manually archived after inward'),
      archivedByUserId: req.user.id,
      archivedByName: req.user.name || req.user.email,
      updatedAt: archivedAt,
    };
    // When inward is done, Ship should read Inwarded (not stuck on In Transit).
    if (
      isStageConfirmed(consignment, 'inward_completed')
      || consignment.dateOfInward
      || Number(consignment.unitsInwarded) > 0
    ) {
      const ship = consignment.shipmentStatus;
      if (!ship || ship === 'In Transit' || ship === 'Forwarded' || ship === 'Ready') {
        updates.shipmentStatus = 'Inwarded';
      }
    }
    await firestoreHelpers.setDocument('consignments', id, updates);
    await addAuditLog('archive', 'consignment', id, req.user.id, {
      reason: updates.archivedReason,
      previousStatus: consignment.shipmentStatus,
    });
    const enriched = enrichWorkflowFields({ ...consignment, ...updates });
    emitConsignmentChange(enriched);
    res.json({ consignment: enriched });
  } catch (error) {
    sendError(res, error);
  }
});

// Exported as an object (same convention as routes/workflow.js) so background
// jobs can reuse loadPackingReport without going through HTTP.
module.exports = { router, loadPackingReport };
