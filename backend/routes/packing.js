const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { generateId, now, addAuditLog, firestoreHelpers } = require('../utils/helpers');
const { enrichConsignment, buildMarketplaceMap } = require('../utils/dispatchPlanning');
const { getPackingLoadUpdates, getSaveBoxUpdates, getPackingFinishUpdates, getQuantityReductionUpdates } = require('../utils/shipmentStatus');
const { loadDraft, saveDraft, scheduleDraftSave, flushDraftSave, clearDraft, applyDraftToSession } = require('../utils/packingDraft');
const { emitConsignmentChange } = require('../utils/syncBus');
const { pgEnabled } = require('../config/database');
const { saveBoxWithPostgresTransaction } = require('../utils/packingPersistence');
const { getMarketplaceBarcode, getScanKeys, findSkuByScanBarcode, clean } = require('../utils/skuIdentity');
const { resolveConsignmentByKey } = require('../utils/resolveConsignment');
const { resolveStoragePath, getSignedReadUrl } = require('../utils/storage');
const { checkConsignmentVideos, isTrustedVerified } = require('../utils/videoHealthCheck');
const { rebuildSessionSkuTotalsFromBoxes } = require('../utils/packingQuantities');
const {
  REMOVAL_REASONS,
  isInvoiceGenerated,
  listAdjustmentsForBox,
  summarizeBoxHistory,
  createPendingRemoval,
  attachRemovalVideo,
  finalizeRemoval,
} = require('../utils/packingAdjustments');

const MEM = {};
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const incrementLocks = new Map();

router.use(authenticateToken, requirePermission('packing', 'use the packing station'));

function acquireIncrementLock(consignmentId) {
  const key = String(consignmentId || '');
  const previous = incrementLocks.get(key) || Promise.resolve();
  let releaseLock;
  const current = previous.then(() => new Promise((resolve) => { releaseLock = resolve; }));
  incrementLocks.set(key, current);
  return previous.then(() => releaseLock);
}

function cloneBoxItems(session, boxNo) {
  return (session.boxes[boxNo] || []).map((item) => ({ ...item }));
}

function buildScanRejectionPayload(session, boxNo, sku, fields = {}) {
  const payload = {
    scan_id: fields.scan_id ?? null,
    ...fields,
  };
  if (sku) {
    payload.packed = sku.packed;
    payload.required = sku.required;
    payload.remaining = sku.remaining;
    payload.internalSku = sku.internalSku;
  }
  if (boxNo != null) {
    payload.box_items = cloneBoxItems(session, boxNo);
  }
  return payload;
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  const body = { error: error.message || 'Request failed' };
  if (error.code) body.code = error.code;
  return res.status(status).json(body);
}

function mapChange(consignment, updates = {}) {
  return {
    id: consignment.id,
    status: updates.status ?? consignment.status,
    shipmentStatus: updates.shipmentStatus ?? consignment.shipmentStatus,
    totalPackedQty: updates.totalPackedQty ?? consignment.totalPackedQty,
    totalRequiredQty: updates.totalRequiredQty ?? consignment.totalRequiredQty,
    internalShipmentNo: consignment.internalShipmentNo,
    updatedAt: updates.updatedAt ?? consignment.updatedAt,
    realtimeType: updates.realtimeType,
  };
}

async function emitPackingProgress(consignmentId, session, realtimeType = 'packing_scan') {
  if (!consignmentId || !session?.skus?.length) return;
  const totalPackedQty = session.skus.reduce((sum, s) => sum + (Number(s.packed) || 0), 0);
  const totalRequiredQty = session.skus.reduce((sum, s) => sum + (Number(s.required) || 0), 0);
  const timestamp = now();
  const progress = {
    id: consignmentId,
    totalPackedQty,
    totalRequiredQty,
    status: totalPackedQty > 0 ? 'in_progress' : 'pending',
    updatedAt: timestamp,
    realtimeType,
  };
  emitConsignmentChange(progress);
  // Authoritative consignment totals are updated on save-box/finish only (H2/H3).
}

async function persistSessionSkuQuantities(session) {
  if (!session?.skus?.length) return;
  const timestamp = now();
  await Promise.all(session.skus.map(async (sku) => {
    const boxQuantities = {};
    for (const [boxNo, items] of Object.entries(session.boxes || {})) {
      const item = (items || []).find((i) => i.skuId === sku.id);
      const qty = Number(item?.qty ?? item?.quantity) || 0;
      if (qty > 0) boxQuantities[boxNo] = qty;
    }
    await firestoreHelpers.setDocument('skus', sku.id, {
      packedQty: sku.packed,
      boxQuantities,
      balanceQty: sku.remaining,
      status: sku.status,
      updatedAt: timestamp,
    });
  }));
}

async function persistLiveSkuPackedQty(sku) {
  if (!sku?.id) return;
  const timestamp = now();
  await firestoreHelpers.setDocument('skus', sku.id, {
    packedQty: sku.packed,
    balanceQty: sku.remaining,
    status: sku.status,
    updatedAt: timestamp,
  });
}

async function persistScannedSkuQty(sku, session) {
  // Live scans must not mutate authoritative SKU packedQty (H3).
  // Totals are recomputed from saved boxes on save-box/finish.
  void sku;
  void session;
}

function parsePositiveQty(value, fallback = 1) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const qty = Number(raw);
  return Number.isInteger(qty) && qty > 0 ? qty : null;
}

function cleanKey(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeBoxItems(items) {
  return (items || []).map((item) => {
    const qty = parsePositiveQty(item.qty ?? item.quantity);
    if (!qty) {
      const error = new Error('Box contains an item with invalid quantity');
      error.statusCode = 400;
      throw error;
    }
    return { ...item, qty };
  });
}

function validateSessionQuantities(session) {
  rebuildSessionSkuTotalsFromBoxes(session);
  const overScanned = (session.skus || []).filter((sku) => (Number(sku.overScanned) || 0) > 0);
  if (!overScanned.length) return;
  const first = overScanned[0];
  const error = new Error(
    `Cannot save box: ${first.internalSku || first.marketplaceSku || first.id} is over-scanned (${first.packed}/${first.required}).`
  );
  error.statusCode = 409;
  error.code = 'PACKING_OVER_SCAN';
  throw error;
}

function cacheScanResult(session, scanId, payload) {
  if (!scanId) return;
  if (!session.processedScanIds) session.processedScanIds = [];
  if (!session.scanResults) session.scanResults = {};
  if (!session.processedScanIds.includes(scanId)) session.processedScanIds.push(scanId);
  session.scanResults[scanId] = payload;
  if (session.processedScanIds.length > 500) {
    const removed = session.processedScanIds.splice(0, session.processedScanIds.length - 500);
    removed.forEach((oldId) => { delete session.scanResults[oldId]; });
  }
}

async function queueScanPersistence({
  consignmentId,
  session,
  userId,
  scanId,
  event,
  sku,
}) {
  try {
    if (pgEnabled()) {
      const { getPool } = require('../config/database');
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        // Serialize durable scan/draft writes for this consignment across instances.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`packing:${consignmentId}`]);
        await writeScanEvent({ ...event, client });
        await flushDraftSave(consignmentId, session, userId, { client });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      await writeScanEvent(event);
      await flushDraftSave(consignmentId, session, userId);
    }
    // Do not persist authoritative SKU/consignment packed totals on live scans (H3).
    void sku;
  } catch (persistError) {
    console.error('[Packing] scan persist failed:', persistError.message, scanId || '');
    if (scanId && session?.scanResults) {
      delete session.scanResults[scanId];
      session.processedScanIds = (session.processedScanIds || []).filter((id) => id !== scanId);
    }
    throw persistError;
  }
}

async function retryWithBackoff(fn, maxAttempts = 3, baseDelayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[Packing] Retry ${attempt}/${maxAttempts} after ${delay}ms:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}



async function getStoredScanPayload(scanId) {
  if (!scanId) return null;
  const event = await firestoreHelpers.getDocument('scan_events', scanId);
  return event?.payload && typeof event.payload === 'object' ? event.payload : null;
}

async function writeScanEvent({ consignmentId, boxNo, sku, barcode, qty, result, req, scanId, payload = {}, client = null }) {
  const id = scanId || generateId();
  const marketplaceBarcode = getMarketplaceBarcode(sku) || barcode || null;
  await firestoreHelpers.setDocument('scan_events', id, {
    id,
    consignmentId,
    boxNo: boxNo ? String(boxNo) : null,
    skuId: sku?.id || null,
    barcode: marketplaceBarcode,
    marketplaceBarcode,
    marketplaceSku: sku?.marketplaceSku || null,
    internalSku: sku?.internalSku || null,
    qtyDelta: Number(qty) || 1,
    result,
    stationId: req.body?.station_id || req.headers['x-station-id'] || null,
    userId: req.user?.id || null,
    clientCreatedAt: req.body?.client_created_at || null,
    createdAt: now(),
    updatedAt: now(),
    payload,
  }, client ? { client } : undefined);
  return id;
}

function getSession(cid) {
  if (!MEM[cid]) MEM[cid] = { cid, skus: [], boxes: {}, currentBox: null, skuMap: {}, status: 'active', lastActivity: Date.now() };
  else MEM[cid].lastActivity = Date.now();
  return MEM[cid];
}

async function getOrLoadSession(cid) {
  if (MEM[cid] && MEM[cid].skus && MEM[cid].skus.length > 0) {
    MEM[cid].lastActivity = Date.now();
    return MEM[cid];
  }

  const consignment = await resolveConsignmentByKey(cid);
  if (!consignment) {
    const error = new Error('Consignment not found');
    error.statusCode = 404;
    throw error;
  }

  const actualCid = consignment.id;

  const [rawSkus, rawBoxes] = await Promise.all([
    consignment.skuIds?.length
      ? Promise.all(consignment.skuIds.map(id => firestoreHelpers.getDocument('skus', id)))
      : Promise.resolve([]),
    getSavedBoxes(consignment)
  ]);

  const skus = buildSkuViews(rawSkus, rawBoxes);
  const boxes = buildBoxesMap(rawBoxes);
  const boxUpdatedAt = {};
  rawBoxes.filter(Boolean).forEach((box) => {
    if (box.boxNo != null) boxUpdatedAt[String(box.boxNo)] = box.updatedAt || box.createdAt || null;
  });

  const session = {
    cid: actualCid,
    skus,
    boxes,
    boxUpdatedAt,
    currentBox: null,
    skuMap: {},
    processedScanIds: [],
    scanResults: {},
    status: 'active',
    lastActivity: Date.now()
  };

  skus.forEach(s => {
    getScanKeys(s).forEach(key => { session.skuMap[key] = s; });
  });

  const draft = await loadDraft(actualCid);
  applyDraftToSession(session, draft);
  rebuildSessionSkuTotalsFromBoxes(session);

  MEM[actualCid] = session;
  return session;
}

function clearSession(cid) { delete MEM[cid]; }

async function getSavedBoxes(consignment) {
  const byId = new Map();
  const boxIds = consignment?.boxIds || [];
  if (boxIds.length) {
    const docs = await firestoreHelpers.batchGetDocuments('boxes', boxIds);
    docs.filter(Boolean).forEach(box => byId.set(box.id, box));
  }
  const queried = await firestoreHelpers.queryCollection('boxes', 'consignmentId', '==', consignment.id);
  queried.filter(Boolean).forEach(box => byId.set(box.id, box));
  return Array.from(byId.values());
}

function buildBoxesMap(rawBoxes = []) {
  const boxes = {};
  rawBoxes.filter(Boolean).forEach(box => { boxes[box.boxNo] = box.items || []; });
  return boxes;
}

function uniqueById(records = []) {
  const byId = new Map();
  records.filter(Boolean).forEach((record) => {
    const id = record.id || record.data?.id;
    if (id) byId.set(id, { ...record, id });
  });
  return Array.from(byId.values());
}

async function getVideosForConsignment(consignment) {
  const records = [];
  if (consignment?.videoIds?.length) {
    records.push(...await firestoreHelpers.batchGetDocuments('videos', consignment.videoIds));
  }
  records.push(...await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignment.id));
  return uniqueById(records);
}

async function getMissingVerifiedVideoBoxes(consignment, boxes) {
  const requiredBoxNos = Array.from(new Set(
    boxes
      .map((box) => cleanKey(box.boxNo || box.box_no || box.id))
      .filter(Boolean)
  ));
  if (!requiredBoxNos.length) return [];

  const requiredSet = new Set(requiredBoxNos);
  const videos = await getVideosForConsignment(consignment);
  const verified = new Set();

  await Promise.all(videos.map(async (video) => {
    if (video.active === false) return;
    if (video.type === 'removal_video' || video.purpose === 'quantity_removal') return;
    const boxNo = cleanKey(video.boxNo || video.box_no);
    if (!requiredSet.has(boxNo)) return;
    const storagePath = resolveStoragePath(video);
    if (!storagePath) return;
    if (isTrustedVerified(video)) {
      verified.add(boxNo);
      return;
    }
    const readable = await getSignedReadUrl(storagePath, 5 * 60 * 1000);
    if (readable) {
      verified.add(boxNo);
      firestoreHelpers.setDocument('videos', video.id, {
        storageVerified: true,
        storageVerifiedAt: now(),
        updatedAt: now(),
      }).catch(() => {});
    }
  }));

  return requiredBoxNos.filter((boxNo) => !verified.has(boxNo));
}

function buildSkuViews(rawSkus = [], rawBoxes = []) {
  const packedBySku = {};
  const hasSavedBoxes = rawBoxes.filter(Boolean).length > 0;
  rawBoxes.filter(Boolean).forEach((box) => {
    for (const item of box.items || []) {
      if (!item.skuId) continue;
      packedBySku[item.skuId] = (packedBySku[item.skuId] || 0) + (Number(item.qty) || 0);
    }
  });

  return rawSkus.filter(Boolean).map(sku => {
    const packed = hasSavedBoxes ? (packedBySku[sku.id] || 0) : (sku.packedQty || 0);
    const required = sku.requiredQty || 0;
    const marketplaceBarcode = getMarketplaceBarcode(sku);
    return {
      id: sku.id,
      barcode: marketplaceBarcode,
      marketplaceBarcode,
      marketplaceBarcodeType: sku.marketplaceBarcodeType || '',
      marketplaceSku: sku.marketplaceSku || marketplaceBarcode,
      internalSku: sku.internalSku,
      required,
      packed,
      remaining: Math.max(0, required - packed),
      status: required > 0 && packed >= required ? 'completed' : 'pending',
      marketplaceId: sku.marketplaceId
    };
  });
}

// Purge sessions inactive for more than 24 hours (prevents memory leak)
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const cid of Object.keys(MEM)) {
    if ((MEM[cid].lastActivity || 0) < cutoff) {
      console.log(`[Packing] Purging stale session: ${cid}`);
      delete MEM[cid];
    }
  }
}, 60 * 60 * 1000); // run every hour

// Load consignment
router.post('/load', authenticateToken, async (req, res) => {
  try {
    const { consignment_id } = req.body;
    if (!consignment_id) return res.status(400).json({ error: 'Consignment ID required' });

    let consignment = await resolveConsignmentByKey(consignment_id);

    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    // Use the actual document id for all downstream references
    const actualCid = consignment.id;

    // Fetch SKUs and saved boxes in parallel (not sequential) for fast load.
    // Saved boxes are the source of truth for packed counts.
    const [rawSkus, rawBoxes] = await Promise.all([
      consignment.skuIds?.length
        ? Promise.all(consignment.skuIds.map(id => firestoreHelpers.getDocument('skus', id)))
        : Promise.resolve([]),
      getSavedBoxes(consignment)
    ]);

    const skus = buildSkuViews(rawSkus, rawBoxes);
    const boxes = buildBoxesMap(rawBoxes);

    const session = getSession(actualCid);
    session.skus = skus;
    session.boxes = boxes;
    session.boxUpdatedAt = {};
    rawBoxes.filter(Boolean).forEach((box) => {
      if (box.boxNo != null) session.boxUpdatedAt[String(box.boxNo)] = box.updatedAt || box.createdAt || null;
    });
    session.currentBox = null;
    session.skuMap = {};
    session.processedScanIds = [];
    session.scanResults = {};
    // Index only marketplace scan identifiers. Internal SKU is display/report data, not a scan key.
    skus.forEach(s => {
      getScanKeys(s).forEach(key => { session.skuMap[key] = s; });
    });

    const draft = await loadDraft(actualCid);
    applyDraftToSession(session, draft);
    rebuildSessionSkuTotalsFromBoxes(session);

    const resumedBoxes = Object.keys(boxes).length;
    const marketplaceMap = consignment.marketplaceId
      ? { [consignment.marketplaceId]: await firestoreHelpers.getDocument('marketplaces', consignment.marketplaceId) }
      : {};
    const planning = enrichConsignment(consignment, marketplaceMap);

    // Auto-transition: Planned -> Under Packing when consignment enters packing station
    const loadStatusUpdates = getPackingLoadUpdates(consignment);
    if (loadStatusUpdates) {
      await firestoreHelpers.setDocument('consignments', actualCid, loadStatusUpdates);
      Object.assign(consignment, loadStatusUpdates);
      emitConsignmentChange(mapChange(consignment, loadStatusUpdates));
      await addAuditLog('update', 'consignment', actualCid, req.user.id, {
        action: 'packing_started',
        status: loadStatusUpdates.status,
        shipmentStatus: loadStatusUpdates.shipmentStatus,
      });
    }

    res.json({
      consignment_id: actualCid,
      internalShipmentNo: consignment.internalShipmentNo || '',
      shipmentNo: consignment.shipmentNo || '',
      appointmentDate: consignment.appointmentDate || '',
      scheduledDispatchDate: planning.scheduledDispatchDate || consignment.scheduledDispatchDate || '',
      requiredDispatchDate: planning.requiredDispatchDate || '',
      transitDays: planning.transitDays || 0,
      priorityLevel: planning.priorityLevel,
      priorityLabel: planning.priorityLabel,
      prioritySublabel: planning.prioritySublabel,
      readinessStatus: planning.readinessStatus,
      marketplaceId: consignment.marketplaceId || '',
      warehouse: consignment.warehouse || '',
      shipmentStatus: consignment.shipmentStatus || '',
      status: consignment.status || '',
      totalRequiredQty: session.skus.reduce((sum, s) => sum + (Number(s.required) || 0), 0),
      totalPackedQty: session.skus.reduce((sum, s) => sum + (Number(s.packed) || 0), 0),
      boxCount: consignment.boxIds?.length || resumedBoxes,
      total_skus: skus.length,
      skus: session.skus,
      boxes: session.boxes,
      resumed: resumedBoxes > 0,
      resumed_boxes: resumedBoxes
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/increment', authenticateToken, async (req, res) => {
  // Serialize concurrent scans per consignment in-process; durable writes use
  // pg_advisory_xact_lock inside queueScanPersistence. Respond only after those writes commit.
  const release = await acquireIncrementLock(req.body?.consignment_id);
  try {
    await handleIncrement(req, res);
  } finally {
    release();
  }
});

async function handleIncrement(req, res) {
  try {
    const { consignment_id, barcode, box_no, qty: rawQty = 1, scan_id } = req.body;
    const qty = parsePositiveQty(rawQty);
    if (!consignment_id || !barcode || !box_no) {
      return res.status(400).json({ error: 'consignment_id, barcode, and box_no are required' });
    }
    if (!qty) {
      return res.status(400).json({ error: 'Quantity must be a positive whole number' });
    }

    const session = await getOrLoadSession(consignment_id);
    if (!session.skus || !session.skus.length) return res.status(400).json({ error: 'No consignment loaded' });

    if (!session.processedScanIds) session.processedScanIds = [];
    if (!session.scanResults) session.scanResults = {};

    if (scan_id && session.processedScanIds.includes(scan_id)) {
      const cached = session.scanResults[scan_id];
      if (cached) return res.json(cached);
      // Drafts no longer store full scanResults — recover idempotent payload from scan_events.
      const storedPayload = await getStoredScanPayload(scan_id);
      if (storedPayload) {
        cacheScanResult(session, scan_id, storedPayload);
        return res.json(storedPayload);
      }
    }

    // DB idempotency for retries / after restart when scan_id is not yet in memory.
    if (scan_id && !session.processedScanIds.includes(scan_id)) {
      const storedPayload = await getStoredScanPayload(scan_id);
      if (storedPayload) {
        cacheScanResult(session, scan_id, storedPayload);
        return res.json(storedPayload);
      }
    }

    const barcodeKey = clean(barcode);
    if (!barcodeKey) {
      return res.status(400).json({ error: 'Barcode is required' });
    }

    // Find only by marketplace barcode aliases (FNSKU/FSN/ASIN/etc.).
    const sku = findSkuByScanBarcode(session.skuMap, barcodeKey);
    if (!sku) {
      const allCompleted = session.skus.length > 0
        && session.skus.every((s) => s.status === 'completed' || s.remaining <= 0);
      const payload = buildScanRejectionPayload(session, box_no, null, {
        not_found: true,
        extra_item: allCompleted,
        all_complete: allCompleted,
        message: allCompleted
          ? 'Extra item — all required SKUs are already complete'
          : `Not found: ${barcodeKey}`,
        barcode: barcodeKey,
        scan_id: scan_id || null,
      });
      cacheScanResult(session, scan_id, payload);
      await queueScanPersistence({
        consignmentId: consignment_id,
        session,
        userId: req.user?.id,
        scanId: scan_id,
        event: {
          consignmentId: consignment_id,
          boxNo: box_no,
          barcode,
          qty,
          result: 'not_found',
          req,
          scanId: scan_id,
          payload,
        },
      });
      res.json(payload);
      return;
    }

    if (sku.packed >= sku.required || sku.status === 'completed' || sku.remaining <= 0) {
      const payload = buildScanRejectionPayload(session, box_no, sku, {
        over_limit: true,
        locked: true,
        extra_item: true,
        message: `Already completed (${sku.packed}/${sku.required})`,
        scan_id: scan_id || null,
      });
      cacheScanResult(session, scan_id, payload);
      await queueScanPersistence({
        consignmentId: consignment_id,
        session,
        userId: req.user?.id,
        scanId: scan_id,
        event: {
          consignmentId: consignment_id,
          boxNo: box_no,
          sku,
          barcode,
          qty,
          result: 'locked',
          req,
          scanId: scan_id,
          payload,
        },
      });
      res.json(payload);
      return;
    }

    const newPacked = sku.packed + qty;
    if (newPacked > sku.required) {
      const payload = buildScanRejectionPayload(session, box_no, sku, {
        over_limit: true,
        message: `Cannot exceed required qty (${sku.required})`,
        scan_id: scan_id || null,
      });
      cacheScanResult(session, scan_id, payload);
      await queueScanPersistence({
        consignmentId: consignment_id,
        session,
        userId: req.user?.id,
        scanId: scan_id,
        event: {
          consignmentId: consignment_id,
          boxNo: box_no,
          sku,
          barcode,
          qty,
          result: 'over_limit',
          req,
          scanId: scan_id,
          payload,
        },
      });
      res.json(payload);
      return;
    }

    const marketplaceBarcode = getMarketplaceBarcode(sku);
    const nextRemaining = sku.required - newPacked;
    const currentBoxItems = session.boxes[box_no] || [];
    // Snapshot pre-mutation state so a failed durable write can roll back memory
    // (otherwise a client retry would double-count on the already-mutated session).
    const prevSkuPacked = sku.packed;
    const prevSkuRemaining = sku.remaining;
    const prevSkuStatus = sku.status;
    const prevBoxItems = currentBoxItems.map((item) => ({ ...item }));

    const boxItems = currentBoxItems.map((item) => ({ ...item }));
    const existing = boxItems.find(i => i.skuId === sku.id);
    if (existing) {
      existing.qty += qty;
      existing.marketplaceBarcode = existing.marketplaceBarcode || marketplaceBarcode;
      existing.barcode = existing.barcode || marketplaceBarcode;
    } else {
      boxItems.push({
        skuId: sku.id,
        marketplaceBarcode,
        barcode: marketplaceBarcode,
        marketplaceSku: sku.marketplaceSku || marketplaceBarcode,
        internalSku: sku.internalSku,
        name: sku.internalSku,
        qty
      });
    }

    sku.packed = newPacked;
    sku.remaining = nextRemaining;
    if (sku.remaining <= 0) sku.status = 'completed';
    session.boxes[box_no] = boxItems;
    rebuildSessionSkuTotalsFromBoxes(session);

    const payload = {
      barcode: marketplaceBarcode,
      marketplaceBarcode,
      marketplaceSku: sku.marketplaceSku || marketplaceBarcode,
      internalSku: sku.internalSku,
      name: sku.internalSku,
      packed: sku.packed,
      required: sku.required,
      remaining: sku.remaining,
      box_items: cloneBoxItems(session, box_no),
      scan_id: scan_id || null,
    };
    cacheScanResult(session, scan_id, payload);

    try {
      await queueScanPersistence({
        consignmentId: consignment_id,
        session,
        userId: req.user?.id,
        scanId: scan_id,
        sku,
        event: {
          consignmentId: consignment_id,
          boxNo: box_no,
          sku,
          barcode,
          qty,
          result: 'accepted',
          req,
          scanId: scan_id,
          payload,
        },
      });
    } catch (persistError) {
      console.error('[Packing] accepted scan persist failed:', persistError.message, scan_id || '');
      sku.packed = prevSkuPacked;
      sku.remaining = prevSkuRemaining;
      sku.status = prevSkuStatus;
      session.boxes[box_no] = prevBoxItems;
      rebuildSessionSkuTotalsFromBoxes(session);
      return res.status(503).json({
        error: 'Scan could not be saved — please retry',
        retry: true,
        scan_id: scan_id || null,
      });
    }

    // Do not broadcast per-scan progress (causes packer UI refetch storms).
    // Authoritative updates emit on save-box / finish.
    res.json(payload);
  } catch (error) {
    console.error('[Packing] increment error:', error.message);
    sendError(res, error);
  }
}

router.post('/decrement', authenticateToken, async (req, res) => {
  if (!pgEnabled()) {
    const release = await acquireIncrementLock(req.body?.consignment_id);
    try {
      return await handleDecrement(req, res);
    } finally {
      release();
    }
  }

  const { getPool } = require('../config/database');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT 1 FROM documents WHERE collection = 'consignments' AND id = $1 FOR UPDATE`,
      [req.body?.consignment_id]
    );
    if (!rows.length) throw new Error('Consignment not found');
    
    clearSession(req.body?.consignment_id);
    await handleDecrement(req, res);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Packing] decrement transaction error:', err);
    if (!res.headersSent) sendError(res, err);
  } finally {
    client.release();
  }
});

async function handleDecrement(req, res) {
  try {
    const { consignment_id, barcode, box_no, qty: rawQty = 1 } = req.body;
    const qty = parsePositiveQty(rawQty);
    if (!consignment_id || !barcode || !box_no) {
      return res.status(400).json({ error: 'consignment_id, barcode, and box_no are required' });
    }
    if (!qty) {
      return res.status(400).json({ error: 'Quantity must be a positive whole number' });
    }

    const session = await getOrLoadSession(consignment_id);
    if (!session.skus || !session.skus.length) return res.status(400).json({ error: 'No consignment loaded' });

    const barcodeKey = clean(barcode);
    if (!barcodeKey) {
      return res.status(400).json({ error: 'Barcode is required' });
    }

    const sku = findSkuByScanBarcode(session.skuMap, barcodeKey);
    if (!sku) return res.json({ error: 'SKU not found' });

    if (session.boxes[box_no]) {
      const existing = session.boxes[box_no].find(i => i.skuId === sku.id);
      if (existing) {
        existing.qty -= qty;
        if (existing.qty <= 0) {
          session.boxes[box_no] = session.boxes[box_no].filter(i => i.skuId !== sku.id);
        }
      }
    }

    rebuildSessionSkuTotalsFromBoxes(session);
    const marketplaceBarcode = getMarketplaceBarcode(sku);
    const payload = {
      barcode: marketplaceBarcode,
      marketplaceBarcode,
      marketplaceSku: sku.marketplaceSku || marketplaceBarcode,
      internalSku: sku.internalSku,
      packed: sku.packed,
      required: sku.required,
      remaining: sku.remaining,
      box_items: cloneBoxItems(session, box_no),
    };

    try {
      await writeScanEvent({
        consignmentId: consignment_id,
        boxNo: box_no,
        sku,
        barcode,
        qty: -qty,
        result: 'decrement',
        req,
        payload,
      });
      await flushDraftSave(consignment_id, session, req.user.id);

      // Recompute consignment status from session (includes saved boxes + draft).
      // Authoritative SKU packedQty is still owned by save-box; here we only correct status flags.
      const consignment = await firestoreHelpers.getDocument('consignments', session.cid || consignment_id);
      if (consignment) {
        const allCompleted = (session.skus || []).every(
          (s) => (Number(s.remaining) || 0) <= 0 && (Number(s.required) || 0) > 0
        ) && (session.skus || []).length > 0;
        const statusUpdates = getQuantityReductionUpdates(consignment, allCompleted);
        if (statusUpdates) {
          await firestoreHelpers.setDocument('consignments', consignment.id, statusUpdates);
        }
      }

      await emitPackingProgress(consignment_id, session, 'packing_decrement');
    } catch (persistError) {
      console.error('[Packing] decrement persist failed:', persistError.message);
      return res.status(503).json({
        error: 'Could not save quantity change — please retry',
        retry: true,
      });
    }

    res.json(payload);
  } catch (error) {
    sendError(res, error);
  }
}

// Check duplicate box
router.post('/check-duplicate-box', authenticateToken, async (req, res) => {
  try {
    const { consignment_id, box_no } = req.body;
    const consignment = await resolveConsignmentByKey(consignment_id);
    if (!consignment) return res.json({ duplicate: false });

    const boxId = `${consignment.id}_box_${box_no}`;
    const existingBoxId = (consignment.boxIds || []).find((bid) => bid === boxId)
      || (await firestoreHelpers.getDocument('boxes', boxId) ? boxId : null);

    if (existingBoxId) {
      const box = await firestoreHelpers.getDocument('boxes', existingBoxId);
      const items = (box?.items || []).map((item) => ({
        skuId: item.skuId,
        internalSku: item.internalSku || '',
        marketplaceSku: item.marketplaceSku || '',
        barcode: item.barcode || item.marketplaceBarcode || '',
        qty: Number(item.qty) || 0,
      }));
      const totalQty = items.reduce((sum, item) => sum + item.qty, 0) || Number(box?.totalQty) || 0;
      return res.json({
        duplicate: true,
        total_qty: totalQty,
        box_no: String(box_no),
        consignment_id: consignment.id,
        internal_shipment_no: consignment.internalShipmentNo || consignment.id,
        items,
        invoice_generated: isInvoiceGenerated(consignment),
        forward_invoice_no: consignment.forwardInvoiceNo || '',
      });
    }
    res.json({ duplicate: false });
  } catch (error) {
    sendError(res, error);
  }
});

// Removal reasons + box context for quantity removal flow
router.get('/removal-reasons', authenticateToken, async (_req, res) => {
  res.json({ reasons: REMOVAL_REASONS });
});

router.get('/box-removal-context', authenticateToken, async (req, res) => {
  try {
    const consignmentId = req.query.consignment_id;
    const boxNo = req.query.box_no;
    if (!consignmentId || !boxNo) {
      return res.status(400).json({ error: 'consignment_id and box_no are required' });
    }

    const consignment = await resolveConsignmentByKey(consignmentId);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const boxId = `${consignment.id}_box_${boxNo}`;
    const box = await firestoreHelpers.getDocument('boxes', boxId);
    if (!box) return res.status(404).json({ error: 'Box not found' });

    const adjustments = await listAdjustmentsForBox(consignment.id, boxNo);
    const history = summarizeBoxHistory(box, adjustments);

    const videos = await getVideosForConsignment(consignment);
    const packingVideos = videos.filter((v) => {
      if (v.active === false) return false;
      if (String(v.boxNo) !== String(boxNo)) return false;
      return v.type !== 'removal_video';
    });
    const removalVideos = videos.filter((v) => {
      if (v.active === false) return false;
      if (String(v.boxNo) !== String(boxNo)) return false;
      return v.type === 'removal_video';
    });

    res.json({
      consignment_id: consignment.id,
      internal_shipment_no: consignment.internalShipmentNo || consignment.id,
      box_no: String(boxNo),
      total_qty: history.finalQuantity,
      items: (box.items || []).map((item) => ({
        skuId: item.skuId,
        internalSku: item.internalSku || '',
        marketplaceSku: item.marketplaceSku || '',
        barcode: item.barcode || item.marketplaceBarcode || '',
        qty: Number(item.qty) || 0,
      })),
      history,
      packing_videos: packingVideos.map((v) => ({
        id: v.id,
        originalName: v.originalName,
        uploadedAt: v.uploadedAt,
        url: v.storageUrl || v.firebaseUrl || null,
      })),
      removal_videos: removalVideos.map((v) => ({
        id: v.id,
        adjustmentId: v.adjustmentId || null,
        originalName: v.originalName,
        uploadedAt: v.uploadedAt,
        url: v.storageUrl || v.firebaseUrl || null,
      })),
      invoice_generated: isInvoiceGenerated(consignment),
      forward_invoice_no: consignment.forwardInvoiceNo || '',
      reasons: REMOVAL_REASONS,
      pending_adjustments: adjustments.filter((a) => a.status !== 'completed'),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/quantity-removal', authenticateToken, async (req, res) => {
  try {
    const {
      consignment_id,
      box_no,
      sku_id,
      quantity,
      reason,
      remarks,
      client_request_id,
    } = req.body || {};

    if (!consignment_id || !box_no || !sku_id) {
      return res.status(400).json({ error: 'consignment_id, box_no, and sku_id are required' });
    }

    const consignment = await resolveConsignmentByKey(consignment_id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const boxId = `${consignment.id}_box_${box_no}`;
    const box = await firestoreHelpers.getDocument('boxes', boxId);
    if (!box) return res.status(404).json({ error: 'Box not found' });

    const { adjustment, deduped } = await createPendingRemoval({
      consignment,
      box,
      skuId: sku_id,
      quantity,
      reason,
      remarks,
      user: req.user,
      clientRequestId: client_request_id,
    });

    res.status(deduped ? 200 : 201).json({
      adjustment,
      deduped,
      invoice_warning: adjustment.invoiceAlreadyGenerated
        ? 'The invoice has already been generated for this consignment. Quantity removal will require invoice correction or approval.'
        : null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/quantity-removal/:id/attach-video', authenticateToken, async (req, res) => {
  try {
    const videoId = req.body?.video_id || req.body?.videoId;
    const adjustment = await attachRemovalVideo(req.params.id, {
      videoId,
      userId: req.user.id,
    });
    res.json({ adjustment });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/quantity-removal/:id/complete', authenticateToken, async (req, res) => {
  try {
    const existing = await firestoreHelpers.getDocument('packing_adjustments', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Removal transaction not found' });

    // Idempotent complete if already done
    if (existing.status === 'completed') {
      return res.json({
        adjustment: existing,
        alreadyCompleted: true,
        invoice_warning: existing.invoiceCorrectionRequired
          ? 'The invoice has already been generated for this consignment. Quantity removal will require invoice correction or approval.'
          : null,
      });
    }

    let session = null;
    try {
      session = await getOrLoadSession(existing.consignmentId);
    } catch (_) {
      session = null;
    }

    const result = await finalizeRemoval(req.params.id, { user: req.user, session });

    // Drop stale draft/session so packed totals reload from reduced boxes
    try {
      await clearDraft(existing.consignmentId);
      clearSession(existing.consignmentId);
    } catch (_) { /* ignore */ }

    // Best-effort invoice team notification when invoice already exists
    if (result.invoiceWarning) {
      try {
        const { isMailgunConfigured, sendViaMailgun } = require('../utils/mailgun');
        if (isMailgunConfigured()) {
          const users = await firestoreHelpers.getCollection('users').catch(() => []);
          const recipients = (users || [])
            .filter((u) => {
              if (!u?.email || u.isActive === false) return false;
              if (u.role === 'admin' || u.role === 'organization_head' || u.role === 'invoice') return true;
              return u.permissions?.invoice === true || u.receiveOperationalEmails === true;
            })
            .map((u) => u.email)
            .filter(Boolean);
          const unique = [...new Set(recipients)];
          if (unique.length) {
            const subject = `[Invoice correction] Quantity removed — ${result.adjustment.internalShipmentNo || result.adjustment.consignmentId}`;
            const text = [
              result.invoiceWarning,
              `Consignment: ${result.adjustment.consignmentId}`,
              `Box: ${result.adjustment.boxNo}`,
              `SKU: ${result.adjustment.internalSku || result.adjustment.skuId}`,
              `Removed: ${result.adjustment.quantity}`,
              `Final SKU qty in box: ${result.adjustment.finalQty}`,
              `By: ${result.adjustment.removedByName || req.user.name || req.user.email}`,
              'Dispatch is blocked until invoice quantity matches final packed quantity (or an authorized exception is approved).',
            ].join('\n');
            await sendViaMailgun({
              to: unique,
              subject,
              text,
              html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</pre>`,
              tags: ['quantity-removal', 'invoice-correction'],
            });
          }
        }
      } catch (mailErr) {
        console.warn('[Packing] Invoice correction email failed:', mailErr.message);
      }
    }

    res.json({
      adjustment: result.adjustment,
      alreadyCompleted: result.alreadyCompleted,
      invoice_warning: result.invoiceWarning,
      box: result.box,
      totalPackedQty: result.consignment?.totalPackedQty,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Save box
router.post('/save-box', authenticateToken, async (req, res) => {
  try {
    const { consignment_id, box_no, weight, weight_unit, weight_image_id, items } = req.body;
    const session = await getOrLoadSession(consignment_id);
    if (!session.skus || !session.skus.length || !box_no) return res.status(400).json({ error: 'Invalid session' });

    let boxItems = normalizeBoxItems(session.boxes[box_no] || []);
    if (!boxItems.length && Array.isArray(items) && items.length) {
      boxItems = normalizeBoxItems(items);
      session.boxes[box_no] = boxItems;
      scheduleDraftSave(consignment_id, session, req.user.id);
    }
    if (!boxItems.length) return res.status(400).json({ error: 'Box is empty' });
    session.boxes[box_no] = boxItems;
    validateSessionQuantities(session);

    const boxId = `${consignment_id}_box_${box_no}`;
    const totalQty = boxItems.reduce((sum, i) => sum + i.qty, 0);
    const timestamp = now();

    const boxData = {
      id: boxId,
      consignmentId: consignment_id,
      boxNo: String(box_no),
      items: boxItems,
      totalQty,
      weight: weight ? Number(weight) : null,
      weightUnit: weight_unit || 'KG',
      weightImageId: weight_image_id || null,
      weightCapturedBy: req.user.id,
      weightCapturedByName: req.user.name || req.user.email,
      weightCapturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: req.user.id
    };

    // Preserve original packed total across re-saves / later removals
    try {
      const existingBox = await firestoreHelpers.getDocument('boxes', boxId);
      if (existingBox?.originalTotalQty != null) {
        boxData.originalTotalQty = Number(existingBox.originalTotalQty) || totalQty;
        boxData.removedTotalQty = Number(existingBox.removedTotalQty) || 0;
        boxData.createdAt = existingBox.createdAt || timestamp;
        boxData.createdBy = existingBox.createdBy || req.user.id;
      } else if (existingBox?.totalQty != null && Number(existingBox.totalQty) > 0) {
        // First time we see a prior total — treat prior as original baseline when appending
        boxData.originalTotalQty = Number(existingBox.originalTotalQty) || Number(existingBox.totalQty) || totalQty;
        boxData.removedTotalQty = Number(existingBox.removedTotalQty) || 0;
        boxData.createdAt = existingBox.createdAt || timestamp;
        boxData.createdBy = existingBox.createdBy || req.user.id;
      } else {
        boxData.originalTotalQty = totalQty;
        boxData.removedTotalQty = 0;
      }
    } catch (_) {
      boxData.originalTotalQty = totalQty;
      boxData.removedTotalQty = 0;
    }
    const auditLog = {
      id: generateId(),
      action: 'save_box',
      entityType: 'box',
      entityId: boxId,
      userId: req.user.id,
      details: { boxNo: box_no, itemCount: boxItems.length, weight: boxData.weight, weightUnit: boxData.weightUnit },
      timestamp,
    };
    const productivityEvent = {
      id: generateId(),
      consignmentId: consignment_id,
      boxNo: String(box_no),
      eventType: 'box_saved',
      itemsCount: totalQty,
      timestamp,
      userId: req.user.id,
    };

    let transactionResult = null;
    let fallbackConsignment = null;
    if (pgEnabled()) {
      transactionResult = await saveBoxWithPostgresTransaction({
        consignmentId: consignment_id,
        boxId,
        boxData,
        userId: req.user.id,
        timestamp,
        getStatusUpdates: ({ consignment, allCompleted }) => getSaveBoxUpdates(consignment, allCompleted) || {
          status: allCompleted ? 'completed' : 'in_progress',
          updatedAt: timestamp,
        },
        auditLog,
        productivityEvent,
      });

      const resultBySkuId = new Map(transactionResult.skuResults.map((sku) => [sku.id, sku]));
      for (const sku of session.skus) {
        const persisted = resultBySkuId.get(sku.id);
        if (!persisted) continue;
        sku.packed = persisted.packedQty;
        sku.remaining = Math.max(0, (sku.required || 0) - persisted.packedQty);
        sku.status = persisted.status;
      }
      // Keep in-session unsaved box scans reflected in totals and SKU box breakdown.
      rebuildSessionSkuTotalsFromBoxes(session);
      await persistSessionSkuQuantities(session);
    } else {
      const consignment = await firestoreHelpers.getDocument('consignments', consignment_id);
      if (!consignment) return res.status(404).json({ error: 'Consignment not found' });
      fallbackConsignment = consignment;
      const writeBatch = [];
      writeBatch.push(['boxes', boxId, boxData]);

      if (consignment) {
        const boxIds = new Set(consignment.boxIds || []);
        boxIds.add(boxId);

        // Single source of truth: physical box contents.
        const skuBoxQtys = {};
        for (const [bno, items] of Object.entries(session.boxes)) {
          for (const item of items) {
            if (!item.skuId) continue;
            if (!skuBoxQtys[item.skuId]) skuBoxQtys[item.skuId] = {};
            skuBoxQtys[item.skuId][bno] = (skuBoxQtys[item.skuId][bno] || 0) + (item.qty || 0);
          }
        }

        for (const sku of session.skus) {
          const boxQuantities = skuBoxQtys[sku.id] || {};
          const packedFromBoxes = Object.values(boxQuantities).reduce((a, b) => a + b, 0);
          sku.packed = packedFromBoxes;
          sku.remaining = Math.max(0, (sku.required || 0) - packedFromBoxes);
          sku.status = (sku.required || 0) > 0 && packedFromBoxes >= sku.required ? 'completed' : 'pending';
          writeBatch.push(['skus', sku.id, {
            packedQty: packedFromBoxes,
            boxQuantities,
            status: sku.status,
            updatedAt: timestamp
          }]);
        }

        const totalPackedQty = session.skus.reduce((sum, s) => sum + (s.packed || 0), 0);
        const totalRequiredQty = session.skus.reduce((sum, s) => sum + (s.required || 0), 0);
        const allCompleted = session.skus.every(s => s.status === 'completed');
        const statusUpdates = getSaveBoxUpdates(consignment, allCompleted) || {
          status: allCompleted ? 'completed' : 'in_progress',
          updatedAt: timestamp,
        };

        // Fetch all boxes to calculate total weight
        const savedBoxes = await getSavedBoxes(consignment);
        const boxMap = new Map(savedBoxes.map(b => [b.boxNo || b.box_no, b]));
        boxMap.set(String(box_no), boxData);
        const totalWeight = Array.from(boxMap.values()).reduce((sum, b) => sum + (Number(b.weight) || 0), 0);

        writeBatch.push(['consignments', consignment_id, {
          boxIds: Array.from(boxIds),
          totalPackedQty,
          totalRequiredQty,
          totalWeight,
          weightUnit: weight_unit || Array.from(boxMap.values()).find(b => b.weightUnit)?.weightUnit || 'KG',
          ...statusUpdates,
        }]);
      }

      await firestoreHelpers.batchSetMulti(writeBatch);
      await addAuditLog('save_box', 'box', boxId, req.user.id, { boxNo: box_no, itemCount: boxItems.length, weight: boxData.weight, weightUnit: boxData.weightUnit });
      await firestoreHelpers.setDocument('productivity', productivityEvent.id, productivityEvent);
    }
    await flushDraftSave(consignment_id, session, req.user.id);

    const refreshed = transactionResult?.consignment || await firestoreHelpers.getDocument('consignments', consignment_id);
    const marketplaceMap = refreshed?.marketplaceId
      ? { [refreshed.marketplaceId]: await firestoreHelpers.getDocument('marketplaces', refreshed.marketplaceId) }
      : {};
    const planning = enrichConsignment(refreshed || fallbackConsignment, marketplaceMap);

    if (refreshed) {
      emitConsignmentChange(mapChange(refreshed));
    }
    emitPackingProgress(consignment_id, session, 'packing_save_box');

    res.json({
      success: true,
      box: boxData,
      synced: true,
      totals: {
        totalPackedQty: refreshed?.totalPackedQty || 0,
        totalRequiredQty: refreshed?.totalRequiredQty || 0,
        boxCount: refreshed?.boxIds?.length || 0,
      },
      planning: {
        requiredDispatchDate: planning.requiredDispatchDate,
        priorityLevel: planning.priorityLevel,
        priorityLabel: planning.priorityLabel,
        readinessStatus: planning.readinessStatus,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Generate label
router.post('/generate-label', authenticateToken, async (req, res) => {
  try {
    const { consignment_id, box_no } = req.body;
    res.json({ success: true, message: `Label for Box #${box_no} generated` });
  } catch (error) {
    sendError(res, error);
  }
});

// Finish
router.post('/finish', authenticateToken, async (req, res) => {
  try {
    const { consignment_id } = req.body;
    const session = await getOrLoadSession(consignment_id);

    const consignment = await firestoreHelpers.getDocument('consignments', consignment_id);
    if (consignment) {
      // Re-derive everything from the PHYSICAL BOXES (single source of truth).
      // This self-heals any drift between packedQty, boxQuantities and box totals.
      const [allSkus, allBoxes] = await Promise.all([
        firestoreHelpers.batchGetDocuments('skus', consignment.skuIds || []),
        firestoreHelpers.batchGetDocuments('boxes', consignment.boxIds || [])
      ]);
      const validSkus  = allSkus.filter(Boolean);
      const validBoxes = allBoxes.filter(Boolean);

      const videoHealth = await checkConsignmentVideos(consignment_id);
      if (videoHealth.orphaned.length > 0) {
        return res.status(409).json({
          error: 'Some video files are recorded but not readable in storage. Please re-upload them.',
          code: 'VIDEO_STORAGE_ORPHANED',
          affectedBoxes: videoHealth.orphaned.map(v => v.boxNo),
        });
      }

      const missingVideoBoxes = await getMissingVerifiedVideoBoxes(consignment, validBoxes);
      if (missingVideoBoxes.length) {
        return res.status(409).json({
          error: 'Upload and verify one video for every saved box before finishing this consignment.',
          code: 'VIDEOS_PENDING',
          missingBoxes: missingVideoBoxes,
        });
      }

      // Sum each SKU's qty across all boxes, keyed by skuId
      const packedBySku = {};   // skuId -> { boxNo: qty }
      for (const box of validBoxes) {
        for (const item of (box.items || [])) {
          if (!item.skuId) continue;
          if (!packedBySku[item.skuId]) packedBySku[item.skuId] = {};
          packedBySku[item.skuId][box.boxNo] = (packedBySku[item.skuId][box.boxNo] || 0) + (item.qty || 0);
        }
      }

      // Update each SKU to match physical boxes
      const skuWrites = [];
      for (const s of validSkus) {
        const boxQuantities = packedBySku[s.id] || {};
        const packed = Object.values(boxQuantities).reduce((a, b) => a + b, 0);
        const status = (s.requiredQty || 0) > 0 && packed >= s.requiredQty ? 'completed' : 'pending';
        s.packedQty = packed; s.status = status; s.boxQuantities = boxQuantities;
        skuWrites.push(['skus', s.id, { packedQty: packed, boxQuantities, status, updatedAt: now() }]);
      }
      if (skuWrites.length) await firestoreHelpers.batchSetMulti(skuWrites);

      const totalPackedQty = validSkus.reduce((sum, s) => sum + (s.packedQty || 0), 0);
      const totalRequiredQty = validSkus.reduce((sum, s) => sum + (s.requiredQty || 0), 0);
      const allCompleted = validSkus.length > 0 && validSkus.every(s => s.status === 'completed');

      const finishUpdates = getPackingFinishUpdates(consignment, allCompleted) || {
        status: allCompleted ? 'completed' : 'in_progress',
        updatedAt: now(),
      };

      const totalWeight = validBoxes.reduce((sum, b) => sum + (Number(b.weight) || 0), 0);

      await firestoreHelpers.setDocument('consignments', consignment_id, {
        ...consignment,
        totalPackedQty,
        totalRequiredQty,
        totalWeight,
        weightUnit: validBoxes.find(b => b.weightUnit)?.weightUnit || 'KG',
        ...finishUpdates,
      });

      await addAuditLog('finish', 'consignment', consignment_id, req.user.id, {
        status: finishUpdates.status,
        shipmentStatus: finishUpdates.shipmentStatus,
        totalPackedQty,
        totalRequiredQty,
      });
      await firestoreHelpers.setDocument('productivity', generateId(), {
        consignmentId: consignment_id, eventType: 'consignment_finished', timestamp: now(), userId: req.user.id
      });

      await clearDraft(consignment_id);
      clearSession(consignment_id);
      emitConsignmentChange(mapChange({ ...consignment, ...finishUpdates, totalPackedQty, totalRequiredQty }));

      res.json({
        success: true,
        summary: {
          fully_packed: allCompleted,
          totalPackedQty,
          totalRequiredQty,
          status: finishUpdates.status,
          shipmentStatus: finishUpdates.shipmentStatus,
        },
      });
    } else {
      res.status(404).json({ error: 'Consignment not found' });
    }
  } catch (error) {
    sendError(res, error);
  }
});

// Resume session
router.get('/resume-session', authenticateToken, async (req, res) => {
  try {
    const drafts = await firestoreHelpers.getCollection('packing_drafts');
    const active = drafts.map(draft => {
      const cid = draft.consignmentId;
      const boxes = draft.boxes || {};
      const skus = draft.skus || [];
      return {
        consignment_id: cid,
        box_count: Object.keys(boxes).length,
        total_packed: skus.reduce((sum, sku) => sum + (sku.packed || 0), 0),
        total_required: skus.reduce((sum, sku) => sum + (sku.required || 0), 0),
        last_saved: draft.updatedAt || 'Unknown'
      };
    });
    res.json({ available: active.length > 0, consignments: active });
  } catch (error) {
    sendError(res, error);
  }
});

// Sync status - optional consignment_id for live packing sync
router.get('/sync-status', authenticateToken, async (req, res) => {
  try {
    const { consignment_id } = req.query;
    if (!consignment_id) {
      return res.json({ state: 'synced', pending_count: 0 });
    }

    const session = await getOrLoadSession(consignment_id);
    let consignment = await firestoreHelpers.getDocument('consignments', consignment_id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found' });

    const marketplaceMap = consignment.marketplaceId
      ? { [consignment.marketplaceId]: await firestoreHelpers.getDocument('marketplaces', consignment.marketplaceId) }
      : {};
    const enriched = enrichConsignment(consignment, marketplaceMap);

    let skus;
    let boxes = {};
    if (session?.skus?.length) {
      rebuildSessionSkuTotalsFromBoxes(session);
      skus = session.skus.map((sku) => {
        const boxQuantities = {};
        for (const [boxNo, items] of Object.entries(session.boxes || {})) {
          const item = (items || []).find((i) => i.skuId === sku.id);
          const qty = Number(item?.qty ?? item?.quantity) || 0;
          if (qty > 0) boxQuantities[boxNo] = qty;
        }
        return { ...sku, boxQuantities };
      });
      boxes = session.boxes || {};
    } else {
      const [rawSkus, rawBoxes] = await Promise.all([
        Promise.all((consignment.skuIds || []).map((id) => firestoreHelpers.getDocument('skus', id))),
        getSavedBoxes(consignment),
      ]);
      skus = buildSkuViews(rawSkus, rawBoxes);
      boxes = buildBoxesMap(rawBoxes);
    }

    const boxCount = consignment.boxIds?.length || Object.keys(boxes).filter((k) => boxes[k]?.length).length;

    const sessionPacked = session?.skus?.length
      ? session.skus.reduce((sum, s) => sum + (Number(s.packed) || 0), 0)
      : 0;
    const storedPacked = Number(consignment.totalPackedQty) || 0;
    const hasLiveBoxItems = Object.values(session?.boxes || {}).some((items) => items?.length > 0);
    // Only treat as "live packing" when session differs from stored totals (unsaved scans),
    // not merely because saved boxes were hydrated into MEM.
    const sessionActive = !!(
      session?.skus?.length
      && hasLiveBoxItems
      && sessionPacked !== storedPacked
    );

    res.json({
      state: 'synced',
      pending_count: 0,
      sessionActive,
      consignment: enriched,
      totals: {
        totalPackedQty: sessionActive
          ? sessionPacked
          : (consignment.totalPackedQty || 0),
        totalRequiredQty: consignment.totalRequiredQty || 0,
        boxCount,
      },
      skus,
      boxes,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Productivity
router.get('/productivity', authenticateToken, async (req, res) => {
  try {
    const today = new Date().toDateString();
    const records = await firestoreHelpers.getCollection('productivity');
    const todayRecords = records.filter(r => new Date(r.timestamp).toDateString() === today);
    const boxesToday = todayRecords.filter(r => r.eventType === 'box_saved').length;
    const itemsToday = todayRecords.filter(r => r.eventType === 'box_saved').reduce((sum, r) => sum + (r.itemsCount || 0), 0);
    const boxRecords = todayRecords.filter(r => r.eventType === 'box_saved');
    const avgSpeed = boxRecords.length > 0 ? (itemsToday / boxRecords.length).toFixed(1) : '0';
    res.json({ boxes_today: boxesToday, items_today: itemsToday, avg_speed: avgSpeed, avg_time_per_box: 0 });
  } catch (error) {
    sendError(res, error);
  }
});

// Legacy multipart video upload removed — clients must use signed R2 PUT + /api/uploads/metadata
router.post('/upload-video', authenticateToken, (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been removed. Upload videos via /api/uploads/generate-signed-url and /api/uploads/metadata.',
    code: 'UPLOAD_PATH_REMOVED',
  });
});

module.exports = router;
module.exports.getSessionCount = () => Object.keys(MEM).length;
module.exports.clearPackingSession = (cid) => {
  if (cid) delete MEM[cid];
};
