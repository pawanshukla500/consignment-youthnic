/**
 * Inventory Planning engine — demand aggregation buckets + inventory allocation.
 *
 * Priority mapping (defaults; configurable via Admin settings):
 *   app criticality "critical" → Critical
 *   app criticality "high"     → Urgent
 *   app criticality "medium" |
 *   app criticality "normal"   → Normal
 *
 * Demand for open consignments uses remaining qty: max(0, requiredQty − packedQty).
 * Completed consignments are excluded. Hard-deletes mean cancelled rows never appear.
 */

const crypto = require('crypto');
const { getShipmentCriticality } = require('./criticality');

const DEFAULT_BUCKET_MAP = {
  critical: 'critical',
  high: 'urgent',
  medium: 'normal',
  normal: 'normal',
  warning: 'urgent',
};

const INVENTORY_STATUSES = {
  SUFFICIENT: 'Sufficient',
  LOW: 'Low Inventory',
  URGENT_PRODUCTION: 'Urgent Production Required',
  CRITICAL_SHORTAGE: 'Critical Shortage',
  MISSING: 'Inventory Data Missing',
  SYNC_FAILED: 'OMSGuru Sync Failed',
};

function toNonNegInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function normalizeSkuKey(value) {
  return String(value || '').trim();
}

function mapCriticalityToBucket(level, bucketMap = DEFAULT_BUCKET_MAP) {
  const key = String(level || 'normal').toLowerCase();
  return bucketMap[key] || 'normal';
}

function isOpenConsignment(consignment, options = {}) {
  if (!consignment) return false;
  const status = String(consignment.status || '').toLowerCase();
  if (status === 'completed' || status === 'cancelled' || status === 'deleted' || status === 'archived') {
    return false;
  }
  const openStatuses = options.openStatuses || ['pending', 'in_progress'];
  if (!openStatuses.includes(status)) return false;

  const ship = String(consignment.shipmentStatus || '').trim();
  const excludedShip = options.excludedShipmentStatuses || [
    'Dispatched',
    'Inwarded',
    'Delivered',
    'Cancelled',
  ];
  if (excludedShip.some((s) => s.toLowerCase() === ship.toLowerCase())) return false;
  return true;
}

function allocateInventory(criticalReq, urgentReq, normalReq, availableRaw, options = {}) {
  const treatMissingAsZero = options.treatMissingAsZero === true;
  const critical = toNonNegInt(criticalReq);
  const urgent = toNonNegInt(urgentReq);
  const normal = toNonNegInt(normalReq);
  const totalReq = critical + urgent + normal;

  const missing = availableRaw === null || availableRaw === undefined || availableRaw === '';
  if (missing && !treatMissingAsZero) {
    return {
      available: null,
      inventoryMissing: true,
      criticalRequirement: critical,
      urgentRequirement: urgent,
      normalRequirement: normal,
      totalRequirement: totalReq,
      criticalCovered: 0,
      urgentCovered: 0,
      normalCovered: 0,
      criticalShortage: critical,
      urgentShortage: urgent,
      normalShortage: normal,
      totalShortage: totalReq,
      suggestedProductionQty: totalReq,
      remainingAfterAllocation: null,
    };
  }

  let remaining = Math.max(0, toNonNegInt(missing ? 0 : availableRaw));
  const available = remaining;

  const criticalCovered = Math.min(critical, remaining);
  remaining -= criticalCovered;
  const urgentCovered = Math.min(urgent, remaining);
  remaining -= urgentCovered;
  const normalCovered = Math.min(normal, remaining);
  remaining -= normalCovered;

  const criticalShortage = critical - criticalCovered;
  const urgentShortage = urgent - urgentCovered;
  const normalShortage = normal - normalCovered;
  const totalShortage = criticalShortage + urgentShortage + normalShortage;

  return {
    available,
    inventoryMissing: false,
    criticalRequirement: critical,
    urgentRequirement: urgent,
    normalRequirement: normal,
    totalRequirement: totalReq,
    criticalCovered,
    urgentCovered,
    normalCovered,
    criticalShortage,
    urgentShortage,
    normalShortage,
    totalShortage,
    suggestedProductionQty: totalShortage,
    remainingAfterAllocation: remaining,
  };
}

function deriveInventoryStatus(allocation, stockMeta = {}, options = {}) {
  if (stockMeta.syncFailed) return INVENTORY_STATUSES.SYNC_FAILED;
  if (allocation.inventoryMissing) return INVENTORY_STATUSES.MISSING;
  if (allocation.criticalShortage > 0) return INVENTORY_STATUSES.CRITICAL_SHORTAGE;
  if (allocation.urgentShortage > 0) return INVENTORY_STATUSES.URGENT_PRODUCTION;
  if (allocation.totalShortage > 0) return INVENTORY_STATUSES.LOW;
  const lowThresholdPct = Number(options.lowInventoryPct);
  if (
    Number.isFinite(lowThresholdPct) &&
    lowThresholdPct > 0 &&
    allocation.totalRequirement > 0 &&
    allocation.available != null &&
    allocation.available / allocation.totalRequirement * 100 < lowThresholdPct
  ) {
    return INVENTORY_STATUSES.LOW;
  }
  return INVENTORY_STATUSES.SUFFICIENT;
}

function recommendedAction(status, allocation) {
  switch (status) {
    case INVENTORY_STATUSES.CRITICAL_SHORTAGE:
      return `Produce ${allocation.suggestedProductionQty} units immediately — critical orders not fully covered`;
    case INVENTORY_STATUSES.URGENT_PRODUCTION:
      return `Schedule urgent production of ${allocation.suggestedProductionQty} units`;
    case INVENTORY_STATUSES.LOW:
      return `Plan production of ${allocation.suggestedProductionQty} units before shipment deadlines`;
    case INVENTORY_STATUSES.MISSING:
      return 'Verify Internal SKU in OMSGuru and re-sync inventory';
    case INVENTORY_STATUSES.SYNC_FAILED:
      return 'Investigate OMSGuru sync failure and re-run Sync Now';
    default:
      return 'No production action required';
  }
}

/**
 * Build SKU demand rows from enriched consignments + SKU lines.
 * Each consignment should already include criticality via enrichConsignment.
 */
function buildSkuDemand(openConsignments, options = {}) {
  const bucketMap = { ...DEFAULT_BUCKET_MAP, ...(options.bucketMap || {}) };
  const bySku = new Map();

  for (const consignment of openConsignments || []) {
    if (!isOpenConsignment(consignment, options)) continue;
    const criticality = consignment.criticalityLevel
      ? { level: consignment.criticalityLevel }
      : getShipmentCriticality(consignment);
    const bucket = mapCriticalityToBucket(criticality.level, bucketMap);
    const skus = Array.isArray(consignment.skus) ? consignment.skus : [];
    const consignmentId = consignment.id || consignment.internalShipmentNo;
    const marketplaceName = consignment.marketplaceName || '';
    const appointmentDate = consignment.appointmentDate || '';
    const dispatchDate = consignment.requiredDispatchDate || consignment.scheduledDispatchDate || '';
    const transitDays = consignment.transitDays ?? null;
    const packingPercent = consignment.packingPercent ?? getShipmentCriticality(consignment).packingPercent;

    for (const sku of skus) {
      const internalSku = normalizeSkuKey(sku.internalSku);
      if (!internalSku) continue;

      const required = toNonNegInt(sku.requiredQty);
      const packed = toNonNegInt(sku.packedQty);
      const demandQty = Math.max(0, required - packed);
      if (demandQty <= 0) continue;

      let row = bySku.get(internalSku);
      if (!row) {
        row = {
          internalSku,
          productName: sku.productName || sku.name || '',
          marketplaces: new Set(),
          consignmentIds: new Set(),
          consignmentDetails: [],
          criticalQty: 0,
          urgentQty: 0,
          normalQty: 0,
          totalPlannedQty: 0,
          earliestAppointmentDate: '',
          earliestDispatchDate: '',
          warehouseTatDays: transitDays,
        };
        bySku.set(internalSku, row);
      }

      if (marketplaceName) row.marketplaces.add(marketplaceName);
      row.consignmentIds.add(consignmentId);
      row.consignmentDetails.push({
        consignmentId,
        status: consignment.status,
        shipmentStatus: consignment.shipmentStatus || '',
        internalSku,
        plannedQty: demandQty,
        requiredQty: required,
        packedQty: packed,
        priorityBucket: bucket,
        criticalityLevel: criticality.level,
        appointmentDate,
        shippingDeadline: dispatchDate,
        warehouseTatDays: transitDays,
        packingProgress: packingPercent,
      });

      if (bucket === 'critical') row.criticalQty += demandQty;
      else if (bucket === 'urgent') row.urgentQty += demandQty;
      else row.normalQty += demandQty;
      row.totalPlannedQty += demandQty;

      if (appointmentDate) {
        if (!row.earliestAppointmentDate || appointmentDate < row.earliestAppointmentDate) {
          row.earliestAppointmentDate = appointmentDate;
        }
      }
      if (dispatchDate) {
        if (!row.earliestDispatchDate || dispatchDate < row.earliestDispatchDate) {
          row.earliestDispatchDate = dispatchDate;
        }
      }
      if (transitDays != null && (row.warehouseTatDays == null || transitDays < row.warehouseTatDays)) {
        row.warehouseTatDays = transitDays;
      }
      if (!row.productName && (sku.productName || sku.name)) {
        row.productName = sku.productName || sku.name;
      }
    }
  }

  return [...bySku.values()].map((row) => ({
    ...row,
    marketplaces: [...row.marketplaces],
    consignmentIds: [...row.consignmentIds],
    activeConsignmentCount: row.consignmentIds.size,
  }));
}

function applyStockToDemand(demandRows, stockBySku, options = {}) {
  const lastSyncAt = options.lastSyncAt || null;
  return (demandRows || []).map((demand) => {
    const stock = stockBySku[demand.internalSku] || stockBySku[normalizeSkuKey(demand.internalSku)] || null;
    let availableRaw = null;
    let syncFailed = false;
    if (stock) {
      if (stock.manual_override && stock.override_quantity != null) {
        availableRaw = stock.override_quantity;
      } else if (stock.sync_status === 'failed' && (stock.quantity === null || stock.quantity === undefined)) {
        syncFailed = true;
        availableRaw = null;
      } else if (stock.quantity === null || stock.quantity === undefined) {
        availableRaw = null;
      } else {
        availableRaw = stock.quantity;
      }
      if (stock.sync_status === 'failed') syncFailed = true;
    }

    const allocation = allocateInventory(
      demand.criticalQty,
      demand.urgentQty,
      demand.normalQty,
      availableRaw,
      options
    );
    const status = deriveInventoryStatus(allocation, { syncFailed }, options);
    const action = recommendedAction(status, allocation);

    return {
      internalSku: demand.internalSku,
      productName: demand.productName || stock?.product_name || '',
      marketplaces: demand.marketplaces,
      marketplace: demand.marketplaces.join(', '),
      activeConsignmentCount: demand.activeConsignmentCount,
      consignmentIds: demand.consignmentIds,
      totalPlannedQty: demand.totalPlannedQty,
      criticalQty: demand.criticalQty,
      urgentQty: demand.urgentQty,
      normalQty: demand.normalQty,
      latestInventory: allocation.available,
      inventoryAllocatedCritical: allocation.criticalCovered,
      inventoryAllocatedUrgent: allocation.urgentCovered,
      inventoryAllocatedNormal: allocation.normalCovered,
      criticalShortage: allocation.criticalShortage,
      urgentShortage: allocation.urgentShortage,
      normalShortage: allocation.normalShortage,
      totalShortage: allocation.totalShortage,
      suggestedProductionQty: allocation.suggestedProductionQty,
      earliestAppointmentDate: demand.earliestAppointmentDate,
      earliestShipmentDate: demand.earliestDispatchDate || demand.earliestAppointmentDate,
      warehouseTatDays: demand.warehouseTatDays,
      lastInventorySyncAt: stock?.last_success_at || stock?.last_synced_at || lastSyncAt,
      inventoryStatus: status,
      recommendedAction: action,
      consignmentDetails: demand.consignmentDetails,
      syncStatus: stock?.sync_status || (stock ? 'ok' : 'missing'),
    };
  });
}

function summarizePlanning(skuRows, meta = {}) {
  const skus = skuRows || [];
  const counts = {
    sufficient: 0,
    low: 0,
    urgent: 0,
    critical: 0,
    missing: 0,
    syncFailed: 0,
  };
  let totalPlanned = 0;
  let totalAvailable = 0;
  let availableKnown = 0;
  let totalShortage = 0;
  let totalSuggested = 0;
  let earliestDate = '';
  const consignmentIds = new Set();

  for (const row of skus) {
    totalPlanned += toNonNegInt(row.totalPlannedQty);
    totalShortage += toNonNegInt(row.totalShortage);
    totalSuggested += toNonNegInt(row.suggestedProductionQty);
    if (row.latestInventory != null) {
      totalAvailable += toNonNegInt(row.latestInventory);
      availableKnown += 1;
    }
    (row.consignmentIds || []).forEach((id) => consignmentIds.add(id));
    const d = row.earliestShipmentDate || row.earliestAppointmentDate;
    if (d && (!earliestDate || d < earliestDate)) earliestDate = d;

    switch (row.inventoryStatus) {
      case INVENTORY_STATUSES.CRITICAL_SHORTAGE:
        counts.critical += 1;
        break;
      case INVENTORY_STATUSES.URGENT_PRODUCTION:
        counts.urgent += 1;
        break;
      case INVENTORY_STATUSES.LOW:
        counts.low += 1;
        break;
      case INVENTORY_STATUSES.MISSING:
        counts.missing += 1;
        break;
      case INVENTORY_STATUSES.SYNC_FAILED:
        counts.syncFailed += 1;
        break;
      default:
        counts.sufficient += 1;
    }
  }

  return {
    generatedAt: meta.generatedAt || new Date().toISOString(),
    omsGuruSyncStatus: meta.omsGuruSyncStatus || 'unknown',
    lastInventorySyncAt: meta.lastInventorySyncAt || null,
    activeConsignmentCount: meta.activeConsignmentCount ?? consignmentIds.size,
    totalSkusReviewed: skus.length,
    sufficientSkuCount: counts.sufficient,
    lowInventorySkuCount: counts.low,
    urgentSkuCount: counts.urgent,
    criticalShortageSkuCount: counts.critical,
    missingInventorySkuCount: counts.missing,
    syncFailedSkuCount: counts.syncFailed,
    normalAttentionSkuCount: counts.low,
    totalPlannedQty: totalPlanned,
    totalAvailableInventory: totalAvailable,
    skusWithKnownInventory: availableKnown,
    totalShortageQty: totalShortage,
    totalSuggestedProductionQty: totalSuggested,
    earliestShipmentOrAppointmentDate: earliestDate,
  };
}

function buildAlertFingerprint(skuRows) {
  const material = (skuRows || [])
    .filter((r) =>
      r.totalShortage > 0 ||
      r.inventoryStatus === INVENTORY_STATUSES.MISSING ||
      r.inventoryStatus === INVENTORY_STATUSES.SYNC_FAILED ||
      r.inventoryStatus === INVENTORY_STATUSES.CRITICAL_SHORTAGE ||
      r.inventoryStatus === INVENTORY_STATUSES.URGENT_PRODUCTION
    )
    .map((r) => [
      r.internalSku,
      r.inventoryStatus,
      r.criticalShortage,
      r.urgentShortage,
      r.normalShortage,
      r.totalShortage,
      r.latestInventory === null ? 'null' : r.latestInventory,
    ].join(':'))
    .sort();

  const resolved = (skuRows || [])
    .filter((r) => r.inventoryStatus === INVENTORY_STATUSES.SUFFICIENT && r.totalPlannedQty > 0)
    .map((r) => r.internalSku)
    .sort();

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ material, resolvedCount: resolved.length }))
    .digest('hex');
}

function criticalAndUrgentSkus(skuRows) {
  return (skuRows || []).filter((r) =>
    r.inventoryStatus === INVENTORY_STATUSES.CRITICAL_SHORTAGE ||
    r.inventoryStatus === INVENTORY_STATUSES.URGENT_PRODUCTION ||
    r.criticalShortage > 0 ||
    r.urgentShortage > 0
  );
}

module.exports = {
  DEFAULT_BUCKET_MAP,
  INVENTORY_STATUSES,
  toNonNegInt,
  normalizeSkuKey,
  mapCriticalityToBucket,
  isOpenConsignment,
  allocateInventory,
  deriveInventoryStatus,
  recommendedAction,
  buildSkuDemand,
  applyStockToDemand,
  summarizePlanning,
  buildAlertFingerprint,
  criticalAndUrgentSkus,
};
