const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../utils/permissions');
const { addAuditLog } = require('../utils/helpers');
const {
  getInventorySettings,
  saveInventorySettings,
  getConnectionStatus,
  DEFAULT_INVENTORY_SETTINGS,
} = require('../utils/inventorySettings');
const { runInventorySync, isSyncRunning, getLatestSyncRun, getSyncSkuLogs } = require('../utils/inventorySyncService');
const { buildInventoryPlanningReport, getDashboardReport } = require('../utils/inventoryReportBuilder');
const { buildInventoryPlanningWorkbook } = require('../utils/inventoryPlanningExcel');
const { sendInventoryPlanningNotification } = require('../utils/inventoryNotify');

// Dashboard report (production / inventory teams with permission)
router.get(
  '/report',
  authenticateToken,
  requireAnyPermission(['inventoryPlanning', 'consignments', 'productivity'], 'view inventory planning'),
  async (req, res) => {
    try {
      const refresh = String(req.query.refresh || '') === '1';
      const report = await getDashboardReport({ refresh });
      res.json(report);
    } catch (error) {
      console.error('[InventoryPlanning] report failed:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

router.get(
  '/sync/status',
  authenticateToken,
  requireAnyPermission(['inventoryPlanning', 'consignments', 'productivity'], 'view inventory sync'),
  async (req, res) => {
    try {
      const settings = await getInventorySettings();
      const latest = await getLatestSyncRun();
      res.json({
        running: isSyncRunning(),
        connection: getConnectionStatus(),
        lastSuccessfulSyncAt: settings.lastSuccessfulSyncAt,
        lastSyncStatus: settings.lastSyncStatus,
        lastSyncError: settings.lastSyncError,
        latestRun: latest,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post(
  '/sync',
  authenticateToken,
  requireAnyPermission(['inventoryPlanning'], 'sync inventory'),
  async (req, res) => {
    try {
      if (isSyncRunning()) {
        return res.status(409).json({ error: 'An inventory sync is already running' });
      }
      const connection = getConnectionStatus();
      if (!connection.googleSheetsConfigured) {
        return res.status(503).json({
          error: connection.hint || 'Google Sheets is not configured on the server',
          connection,
        });
      }
      if (connection.googleSheetsJsonValid === false) {
        return res.status(503).json({
          error: connection.hint || 'Google Sheets service account JSON is invalid',
          connection,
        });
      }
      const userId = req.user.id;
      setImmediate(() => {
        runInventorySync({ triggerType: 'manual', triggeredBy: userId })
          .then(async (result) => {
            if (result.ok) {
              try {
                const report = await buildInventoryPlanningReport({
                  triggerReason: 'sync_shortage',
                  persist: true,
                });
                // Auto-email production when sync completes (shortage or forced daily-like alert when material)
                await sendInventoryPlanningNotification({
                  triggerReason: 'sync_shortage',
                  report,
                  force: (report.summary?.totalShortageQty || 0) > 0,
                });
              } catch (err) {
                console.warn('[InventoryPlanning] post-sync notify failed:', err.message);
              }
            } else {
              console.warn('[InventoryPlanning] sync failed:', result.error || result.reason);
            }
          })
          .catch((err) => console.warn('[InventoryPlanning] sync failed:', err.message));
      });
      await addAuditLog('inventory_sync_manual', 'inventory_sync', 'manual', userId, {});
      res.json({ ok: true, started: true, message: 'Google Sheet inventory sync started', connection });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.get(
  '/settings',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const settings = await getInventorySettings();
      res.json({
        settings,
        defaults: DEFAULT_INVENTORY_SETTINGS,
        connection: getConnectionStatus(),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.put(
  '/settings',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const before = await getInventorySettings();
      const saved = await saveInventorySettings(req.body || {}, req.user.id);
      const recipientChanged =
        JSON.stringify(before.productionTeamEmails) !== JSON.stringify(saved.productionTeamEmails) ||
        JSON.stringify(before.inventoryTeamEmails) !== JSON.stringify(saved.inventoryTeamEmails) ||
        JSON.stringify(before.organisationHeadCcEmails) !== JSON.stringify(saved.organisationHeadCcEmails) ||
        JSON.stringify(before.additionalCcEmails) !== JSON.stringify(saved.additionalCcEmails);
      const priorityChanged = JSON.stringify(before.bucketMap) !== JSON.stringify(saved.bucketMap);

      if (recipientChanged) {
        await addAuditLog('recipient_config_changed', 'inventory_planning', 'settings', req.user.id, {
          productionTeamEmails: saved.productionTeamEmails,
          inventoryTeamEmails: saved.inventoryTeamEmails,
          organisationHeadCcEmails: saved.organisationHeadCcEmails,
          additionalCcEmails: saved.additionalCcEmails,
        });
      }
      if (priorityChanged) {
        await addAuditLog('priority_rule_changed', 'inventory_planning', 'settings', req.user.id, {
          bucketMap: saved.bucketMap,
        });
      }
      await addAuditLog('update', 'inventory_planning_settings', 'inventoryPlanning', req.user.id, {
        keys: Object.keys(req.body || {}),
      });
      res.json({ settings: saved, connection: getConnectionStatus() });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

router.get(
  '/export.xlsx',
  authenticateToken,
  requireAnyPermission(['inventoryPlanning', 'consignments', 'productivity'], 'download inventory report'),
  async (req, res) => {
    try {
      const report = await buildInventoryPlanningReport({ triggerReason: 'export', persist: true });
      const logs = await getSyncSkuLogs(3000);
      const buffer = await buildInventoryPlanningWorkbook(report, logs);
      await addAuditLog('xlsx_generated', 'inventory_planning', report.id, req.user.id, {
        download: true,
        bytes: buffer.length,
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Inventory_Planning_${new Date().toISOString().slice(0, 10)}.xlsx"`
      );
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post(
  '/notify',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const result = await sendInventoryPlanningNotification({
        triggerReason: 'manual',
        force: true,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.get(
  '/email-history',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const { getPool, pgEnabled } = require('../config/database');
      if (!pgEnabled()) return res.json({ history: [] });
      const pool = getPool();
      const result = await pool.query(
        `SELECT * FROM inventory_email_history ORDER BY created_at DESC LIMIT 100`
      );
      res.json({ history: result.rows });
    } catch (error) {
      res.json({ history: [] });
    }
  }
);

router.get(
  '/sync/logs',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const logs = await getSyncSkuLogs(parseInt(req.query.limit, 10) || 500);
      res.json({ logs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
