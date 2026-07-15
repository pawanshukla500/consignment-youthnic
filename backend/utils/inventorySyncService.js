/**
 * Google Sheet → DB inventory sync orchestration.
 * Team pastes OMSGuru inventory into AutoFetch; app reads sheet and calculates planning.
 * Non-blocking for packing: callers should fire-and-forget or await off the request path.
 */

const { getPool, pgEnabled } = require('../config/database');
const { generateId, addAuditLog } = require('./helpers');
const { fetchInventoryFromSheet, isSheetsConfigured } = require('./googleSheetsInventory');
const { getInventorySettings, saveInventorySettings } = require('./inventorySettings');
const { normalizeSkuKey } = require('./inventoryPlanning');

let syncInFlight = null;

async function ensureInventoryTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_stock (
      internal_sku TEXT PRIMARY KEY,
      quantity INTEGER,
      previous_quantity INTEGER,
      product_name TEXT,
      sync_status TEXT NOT NULL DEFAULT 'ok',
      last_synced_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      error_message TEXT,
      source TEXT NOT NULL DEFAULT 'google_sheet',
      manual_override BOOLEAN NOT NULL DEFAULT false,
      override_quantity INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_sync_runs (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL DEFAULT 'scheduled',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      skus_fetched INTEGER NOT NULL DEFAULT 0,
      skus_updated INTEGER NOT NULL DEFAULT 0,
      skus_failed INTEGER NOT NULL DEFAULT 0,
      skus_skipped INTEGER NOT NULL DEFAULT 0,
      sheet_updated BOOLEAN NOT NULL DEFAULT false,
      error_message TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_by TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_sync_sku_logs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      internal_sku TEXT NOT NULL,
      omsguru_quantity INTEGER,
      previous_quantity INTEGER,
      quantity_change INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadExistingStockMap(pool) {
  const result = await pool.query(
    `SELECT internal_sku, quantity, previous_quantity, product_name, sync_status,
            last_synced_at, last_success_at, manual_override, override_quantity
     FROM inventory_stock`
  );
  const map = {};
  for (const row of result.rows) {
    map[row.internal_sku] = row;
  }
  return map;
}

async function upsertStockRow(pool, {
  internalSku,
  quantity,
  previousQuantity,
  productName,
  syncStatus,
  errorMessage,
}) {
  const nowIso = new Date().toISOString();
  await pool.query(
    `INSERT INTO inventory_stock (
       internal_sku, quantity, previous_quantity, product_name, sync_status,
       last_synced_at, last_success_at, error_message, source, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'google_sheet',$6)
     ON CONFLICT (internal_sku) DO UPDATE SET
       quantity = EXCLUDED.quantity,
       previous_quantity = EXCLUDED.previous_quantity,
       product_name = COALESCE(NULLIF(EXCLUDED.product_name, ''), inventory_stock.product_name),
       sync_status = EXCLUDED.sync_status,
       last_synced_at = EXCLUDED.last_synced_at,
       last_success_at = CASE
         WHEN EXCLUDED.sync_status = 'ok' THEN EXCLUDED.last_synced_at
         ELSE inventory_stock.last_success_at
       END,
       error_message = EXCLUDED.error_message,
       source = 'google_sheet',
       updated_at = EXCLUDED.updated_at
     WHERE inventory_stock.manual_override IS NOT TRUE`,
    [
      internalSku,
      quantity,
      previousQuantity,
      productName || null,
      syncStatus,
      nowIso,
      syncStatus === 'ok' ? nowIso : null,
      errorMessage || null,
    ]
  );
}

/**
 * Run inventory sync from Google Sheet → DB.
 * Prevents overlapping jobs via in-process lock.
 */
async function runInventorySync({ triggerType = 'scheduled', triggeredBy = 'system' } = {}) {
  if (syncInFlight) {
    return { ok: false, reason: 'already_running', runId: syncInFlight };
  }

  if (!pgEnabled()) {
    return { ok: false, reason: 'datastore_unavailable' };
  }

  const pool = getPool();
  if (!pool) return { ok: false, reason: 'datastore_unavailable' };

  const runId = generateId();
  syncInFlight = runId;
  const startedAt = new Date().toISOString();

  try {
    await ensureInventoryTables(pool);
    await pool.query(
      `INSERT INTO inventory_sync_runs (id, trigger_type, status, started_at, triggered_by)
       VALUES ($1,$2,'running',$3,$4)`,
      [runId, triggerType, startedAt, triggeredBy]
    );

    await addAuditLog(
      triggerType === 'manual' ? 'inventory_sync_manual' : 'inventory_sync_started',
      'inventory_sync',
      runId,
      triggeredBy,
      { triggerType, source: 'google_sheet' }
    );

    const settings = await getInventorySettings();
    if (!isSheetsConfigured()) {
      throw new Error('Google Sheets credentials are not configured');
    }
    if (!settings.googleSheetId) {
      throw new Error('Google Sheet ID is not configured');
    }

    const fetchResult = await fetchInventoryFromSheet(
      settings.googleSheetId,
      settings.googleSheetName || 'AutoFetch'
    );

    const existing = await loadExistingStockMap(pool);
    let updated = 0;
    let failed = 0;
    let skipped = fetchResult.skipped?.length || 0;
    const skuLogRows = [];

    for (const item of fetchResult.rows) {
      const sku = normalizeSkuKey(item.internalSku);
      try {
        const prev = existing[sku];
        if (prev?.manual_override) {
          skipped += 1;
          skuLogRows.push({
            id: generateId(),
            runId,
            internalSku: sku,
            sheetQuantity: item.quantity,
            previousQuantity: prev.override_quantity ?? prev.quantity,
            quantityChange: null,
            syncStatus: 'skipped_override',
            errorMessage: 'Manual override active',
          });
          continue;
        }

        const previousQuantity = prev?.quantity ?? null;
        const quantityChange =
          previousQuantity == null ? item.quantity : item.quantity - previousQuantity;

        await upsertStockRow(pool, {
          internalSku: sku,
          quantity: item.quantity,
          previousQuantity,
          productName: item.productName,
          syncStatus: 'ok',
          errorMessage: null,
        });
        updated += 1;
        skuLogRows.push({
          id: generateId(),
          runId,
          internalSku: sku,
          sheetQuantity: item.quantity,
          previousQuantity,
          quantityChange,
          syncStatus: 'ok',
          errorMessage: null,
        });
      } catch (err) {
        failed += 1;
        skuLogRows.push({
          id: generateId(),
          runId,
          internalSku: sku,
          sheetQuantity: item.quantity,
          previousQuantity: existing[sku]?.quantity ?? null,
          quantityChange: null,
          syncStatus: 'failed',
          errorMessage: err.message,
        });
      }
    }

    for (let i = 0; i < skuLogRows.length; i += 200) {
      const chunk = skuLogRows.slice(i, i + 200);
      const values = [];
      const params = [];
      chunk.forEach((row, idx) => {
        const b = idx * 8;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
        params.push(
          row.id,
          row.runId,
          row.internalSku,
          row.sheetQuantity,
          row.previousQuantity,
          row.quantityChange,
          row.syncStatus,
          row.errorMessage
        );
      });
      await pool.query(
        `INSERT INTO inventory_sync_sku_logs
         (id, run_id, internal_sku, omsguru_quantity, previous_quantity, quantity_change, sync_status, error_message)
         VALUES ${values.join(',')}`,
        params
      );
    }

    await addAuditLog('google_sheet_read', 'inventory_sync', runId, triggeredBy, {
      rowCount: fetchResult.rows.length,
      column: fetchResult.meta?.inventoryColumnLabel,
    });

    const finishedAt = new Date().toISOString();
    await pool.query(
      `UPDATE inventory_sync_runs SET
         status = 'completed',
         finished_at = $2,
         skus_fetched = $3,
         skus_updated = $4,
         skus_failed = $5,
         skus_skipped = $6,
         sheet_updated = $7,
         details = $8::jsonb
       WHERE id = $1`,
      [
        runId,
        finishedAt,
        fetchResult.rows.length,
        updated,
        failed,
        skipped,
        true,
        JSON.stringify({
          fetchMeta: fetchResult.meta,
          skippedSamples: (fetchResult.skipped || []).slice(0, 25),
          source: 'google_sheet',
        }),
      ]
    );

    await saveInventorySettings({
      lastSuccessfulSyncAt: finishedAt,
      lastSyncStatus: 'completed',
      lastSyncError: null,
    }, triggeredBy);

    await addAuditLog('inventory_sync_completed', 'inventory_sync', runId, triggeredBy, {
      updated,
      failed,
      skipped,
      source: 'google_sheet',
    });

    return {
      ok: true,
      runId,
      skusFetched: fetchResult.rows.length,
      skusUpdated: updated,
      skusFailed: failed,
      skusSkipped: skipped,
      sheetUpdated: true,
      sheetMeta: fetchResult.meta,
      finishedAt,
    };
  } catch (error) {
    try {
      await pool.query(
        `UPDATE inventory_sync_runs SET status = 'failed', finished_at = $2, error_message = $3 WHERE id = $1`,
        [runId, new Date().toISOString(), error.message]
      );
    } catch (_) { /* ignore */ }

    await saveInventorySettings({
      lastSyncStatus: 'failed',
      lastSyncError: error.message,
    }, triggeredBy).catch(() => {});

    await addAuditLog('inventory_sync_failed', 'inventory_sync', runId, triggeredBy, {
      error: error.message,
      source: 'google_sheet',
    });

    return { ok: false, runId, error: error.message };
  } finally {
    if (syncInFlight === runId) syncInFlight = null;
  }
}

function isSyncRunning() {
  return Boolean(syncInFlight);
}

async function getLatestSyncRun() {
  if (!pgEnabled()) return null;
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM inventory_sync_runs ORDER BY started_at DESC LIMIT 1`
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

async function getStockMap() {
  if (!pgEnabled()) return {};
  const pool = getPool();
  if (!pool) return {};
  try {
    await ensureInventoryTables(pool);
    return loadExistingStockMap(pool);
  } catch (err) {
    console.warn('[InventorySync] getStockMap failed:', err.message);
    return {};
  }
}

async function getSyncSkuLogs(limit = 500) {
  if (!pgEnabled()) return [];
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT l.*, r.started_at AS run_started_at, r.status AS run_status
       FROM inventory_sync_sku_logs l
       LEFT JOIN inventory_sync_runs r ON r.id = l.run_id
       ORDER BY l.created_at DESC
       LIMIT $1`,
      [Math.min(5000, Math.max(1, limit))]
    );
    return result.rows;
  } catch {
    return [];
  }
}

module.exports = {
  runInventorySync,
  isSyncRunning,
  getLatestSyncRun,
  getStockMap,
  getSyncSkuLogs,
  ensureInventoryTables,
};
