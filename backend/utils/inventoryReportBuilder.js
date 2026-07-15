/**
 * Build a full inventory planning report from open consignments + stock snapshot.
 */

const { firestoreHelpers, generateId, addAuditLog } = require('./helpers');
const { enrichConsignment, buildMarketplaceMap } = require('./dispatchPlanning');
const { getPool, pgEnabled } = require('../config/database');
const { getInventorySettings } = require('./inventorySettings');
const { getStockMap, getLatestSyncRun } = require('./inventorySyncService');
const {
  isOpenConsignment,
  buildSkuDemand,
  applyStockToDemand,
  summarizePlanning,
  buildAlertFingerprint,
  criticalAndUrgentSkus,
} = require('./inventoryPlanning');

async function loadOpenConsignmentsWithSkus(settings) {
  const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
  const all = await firestoreHelpers.getCollection('consignments');
  const open = [];

  for (const raw of all) {
    const enriched = enrichConsignment(raw, marketplaceMap);
    if (!isOpenConsignment(enriched, {
      openStatuses: settings.openConsignmentStatuses,
      excludedShipmentStatuses: settings.excludedShipmentStatuses,
    })) continue;

    // Prefer embedded skus; fall back to query by consignmentId
    let skus = Array.isArray(enriched.skus) ? enriched.skus : null;
    if (!skus || !skus.length) {
      try {
        skus = await firestoreHelpers.queryCollection('skus', 'consignmentId', '==', enriched.id);
      } catch {
        skus = [];
      }
    }
    open.push({ ...enriched, skus: skus || [] });
  }

  return open;
}

async function buildInventoryPlanningReport({ triggerReason = 'manual', persist = true } = {}) {
  const settings = await getInventorySettings();
  const openConsignments = await loadOpenConsignmentsWithSkus(settings);
  const stockBySku = await getStockMap();
  const latestRun = await getLatestSyncRun();

  const demand = buildSkuDemand(openConsignments, { bucketMap: settings.bucketMap });
  const skuRows = applyStockToDemand(demand, stockBySku, {
    treatMissingAsZero: settings.treatMissingInventoryAsZero === true,
    lowInventoryPct: settings.lowInventoryPct,
    lastSyncAt: settings.lastSuccessfulSyncAt || latestRun?.finished_at || null,
  }).sort((a, b) => {
    const rank = {
      'Critical Shortage': 0,
      'Urgent Production Required': 1,
      'Low Inventory': 2,
      'Inventory Data Missing': 3,
      'Sheet Sync Failed': 4,
      'OMSGuru Sync Failed': 4,
      Sufficient: 5,
    };
    const ra = rank[a.inventoryStatus] ?? 9;
    const rb = rank[b.inventoryStatus] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.totalShortage || 0) - (a.totalShortage || 0) || a.internalSku.localeCompare(b.internalSku);
  });

  const syncStatus =
    latestRun?.status ||
    settings.lastSyncStatus ||
    (settings.lastSuccessfulSyncAt ? 'completed' : 'never');

  const summary = summarizePlanning(skuRows, {
    generatedAt: new Date().toISOString(),
    sheetSyncStatus: syncStatus,
    lastInventorySyncAt: settings.lastSuccessfulSyncAt || latestRun?.finished_at || null,
    activeConsignmentCount: openConsignments.length,
  });

  const fingerprint = buildAlertFingerprint(skuRows);
  const consignmentDetails = [];
  for (const row of skuRows) {
    for (const detail of row.consignmentDetails || []) {
      consignmentDetails.push({
        ...detail,
        availableInventory: row.latestInventory,
        shortage: row.totalShortage,
        recommendedAction: row.recommendedAction,
        inventoryStatus: row.inventoryStatus,
      });
    }
  }

  const report = {
    id: generateId(),
    triggerReason,
    fingerprint,
    summary,
    skus: skuRows,
    consignments: consignmentDetails,
    criticalUrgentSkus: criticalAndUrgentSkus(skuRows),
    syncMeta: {
      latestRun,
      lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt,
      lastSyncStatus: settings.lastSyncStatus,
      lastSyncError: settings.lastSyncError,
    },
    settingsEcho: {
      treatMissingInventoryAsZero: settings.treatMissingInventoryAsZero,
      bucketMap: settings.bucketMap,
    },
  };

  if (persist && pgEnabled()) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS inventory_planning_snapshots (
            id TEXT PRIMARY KEY,
            generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            fingerprint TEXT NOT NULL,
            trigger_reason TEXT,
            summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            skus JSONB NOT NULL DEFAULT '[]'::jsonb,
            consignments JSONB NOT NULL DEFAULT '[]'::jsonb,
            sync_meta JSONB NOT NULL DEFAULT '{}'::jsonb
          )
        `);
        await pool.query(
          `INSERT INTO inventory_planning_snapshots
           (id, generated_at, fingerprint, trigger_reason, summary, skus, consignments, sync_meta)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
          [
            report.id,
            summary.generatedAt,
            fingerprint,
            triggerReason,
            JSON.stringify(summary),
            JSON.stringify(skuRows),
            JSON.stringify(consignmentDetails),
            JSON.stringify(report.syncMeta),
          ]
        );
        await addAuditLog('planning_report_generated', 'inventory_planning', report.id, 'system', {
          triggerReason,
          fingerprint,
          skuCount: skuRows.length,
          shortage: summary.totalShortageQty,
        });
      } catch (err) {
        console.warn('[InventoryPlanning] snapshot persist failed:', err.message);
      }
    }
  }

  return report;
}

async function getLatestSnapshot() {
  if (!pgEnabled()) return null;
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_planning_snapshots ORDER BY generated_at DESC LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      triggerReason: row.trigger_reason,
      summary: row.summary,
      skus: row.skus,
      consignments: row.consignments,
      syncMeta: row.sync_meta,
      generatedAt: row.generated_at,
    };
  } catch {
    return null;
  }
}

module.exports = {
  loadOpenConsignmentsWithSkus,
  buildInventoryPlanningReport,
  getLatestSnapshot,
};
