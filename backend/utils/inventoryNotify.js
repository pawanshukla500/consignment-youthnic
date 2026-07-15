/**
 * Inventory planning email notification + dedupe + history.
 */

const { generateId, addAuditLog } = require('./helpers');
const { getPool, pgEnabled } = require('../config/database');
const { isMailgunConfigured, sendViaMailgun } = require('./mailgun');
const { getInventorySettings, saveInventorySettings, resolveOrganisationHeadCcEmails } = require('./inventorySettings');
const { buildInventoryPlanningReport } = require('./inventoryReportBuilder');
const { buildInventoryPlanningWorkbook } = require('./inventoryPlanningExcel');
const { buildInventoryPlanningEmail } = require('./inventoryPlanningEmail');
const { getSyncSkuLogs } = require('./inventorySyncService');
const { INVENTORY_STATUSES } = require('./inventoryPlanning');

let notifyTimer = null;
let pendingReasons = new Set();

async function ensureEmailHistoryTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_email_history (
      id TEXT PRIMARY KEY,
      trigger_reason TEXT NOT NULL,
      fingerprint TEXT,
      status TEXT NOT NULL,
      recipients JSONB NOT NULL DEFAULT '{}'::jsonb,
      subject TEXT,
      snapshot_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function appBaseUrl() {
  return (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

function shouldSendForReason(settings, triggerReason) {
  const map = {
    new_shortage: settings.emailOnNewShortage,
    quantity_change: settings.emailOnQuantityChange,
    priority_change: settings.emailOnPriorityChange,
    sync_shortage: settings.emailOnNewShortageFromSync,
    critical_urgent: settings.emailOnCriticalOrUrgent,
    shortage_resolved: settings.emailOnResolvedShortage,
    daily_report: settings.emailDailyReport,
    manual: true,
  };
  return map[triggerReason] !== false;
}

function detectMaterialChange(report, previousFingerprint, settings) {
  const hasCriticalUrgent = (report.criticalUrgentSkus || []).length > 0;
  const hasShortage = (report.summary?.totalShortageQty || 0) > 0;
  const hasMissing = (report.skus || []).some((s) =>
    s.inventoryStatus === INVENTORY_STATUSES.MISSING ||
    s.inventoryStatus === INVENTORY_STATUSES.SYNC_FAILED
  );
  const fingerprintChanged = report.fingerprint !== previousFingerprint;

  if (!fingerprintChanged && !hasCriticalUrgent) {
    return { send: false, reason: 'unchanged' };
  }

  // Resolved: previously had material issues, now sufficient-only material set empty
  if (
    previousFingerprint &&
    fingerprintChanged &&
    !hasShortage &&
    !hasMissing &&
    !hasCriticalUrgent
  ) {
    if (!settings.emailOnResolvedShortage) return { send: false, reason: 'resolved_disabled' };
    return { send: true, reason: 'shortage_resolved' };
  }

  if (hasCriticalUrgent) return { send: true, reason: 'critical_urgent' };
  if (hasShortage || hasMissing) return { send: true, reason: 'new_shortage' };
  if (fingerprintChanged) return { send: true, reason: 'changed' };
  return { send: false, reason: 'unchanged' };
}

async function recordEmailHistory(entry) {
  if (!pgEnabled()) return;
  const pool = getPool();
  if (!pool) return;
  try {
    await ensureEmailHistoryTable(pool);
    await pool.query(
      `INSERT INTO inventory_email_history
       (id, trigger_reason, fingerprint, status, recipients, subject, snapshot_id, error_message)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [
        entry.id,
        entry.triggerReason,
        entry.fingerprint || null,
        entry.status,
        JSON.stringify(entry.recipients || {}),
        entry.subject || null,
        entry.snapshotId || null,
        entry.errorMessage || null,
      ]
    );
  } catch (err) {
    console.warn('[InventoryEmail] history write failed:', err.message);
  }
}

async function sendInventoryPlanningNotification({
  triggerReason = 'manual',
  force = false,
  report: existingReport = null,
} = {}) {
  const settings = await getInventorySettings();
  if (!settings.enabled && !force) {
    return { ok: false, reason: 'disabled' };
  }
  if (!shouldSendForReason(settings, triggerReason) && !force) {
    return { ok: false, reason: 'rule_disabled', triggerReason };
  }

  // Production team is the primary To; inventory team emails (if configured) are also To.
  const to = [...new Set([
    ...settings.productionTeamEmails,
    ...settings.inventoryTeamEmails,
  ])];
  const orgHeadCc = await resolveOrganisationHeadCcEmails(settings);
  const cc = [...new Set([
    ...orgHeadCc,
    ...settings.additionalCcEmails,
  ])].filter((e) => !to.includes(e));

  if (!to.length) {
    return { ok: false, reason: 'no_recipients' };
  }
  if (!isMailgunConfigured()) {
    return { ok: false, reason: 'mailgun_not_configured' };
  }

  const report = existingReport || await buildInventoryPlanningReport({
    triggerReason,
    persist: true,
  });

  const change = force
    ? { send: true, reason: triggerReason }
    : detectMaterialChange(report, settings.lastEmailFingerprint, settings);

  if (!change.send && triggerReason !== 'daily_report') {
    await recordEmailHistory({
      id: generateId(),
      triggerReason,
      fingerprint: report.fingerprint,
      status: 'skipped_duplicate',
      recipients: { to, cc },
      subject: null,
      snapshotId: report.id,
      errorMessage: change.reason,
    });
    return { ok: false, reason: change.reason, fingerprint: report.fingerprint };
  }

  // Rate limit non-forced emails
  if (!force && settings.lastEmailSentAt && settings.emailMinIntervalMinutes > 0) {
    const elapsed = Date.now() - new Date(settings.lastEmailSentAt).getTime();
    if (elapsed < settings.emailMinIntervalMinutes * 60 * 1000) {
      await recordEmailHistory({
        id: generateId(),
        triggerReason,
        fingerprint: report.fingerprint,
        status: 'skipped_rate_limit',
        recipients: { to, cc },
        snapshotId: report.id,
        errorMessage: `min interval ${settings.emailMinIntervalMinutes}m`,
      });
      return { ok: false, reason: 'rate_limited' };
    }
  }

  // Same fingerprint as last successful email → skip (except daily/forced)
  if (
    !force &&
    triggerReason !== 'daily_report' &&
    settings.lastEmailFingerprint &&
    settings.lastEmailFingerprint === report.fingerprint
  ) {
    await recordEmailHistory({
      id: generateId(),
      triggerReason,
      fingerprint: report.fingerprint,
      status: 'skipped_duplicate',
      recipients: { to, cc },
      snapshotId: report.id,
    });
    return { ok: false, reason: 'duplicate_fingerprint' };
  }

  const isDaily = triggerReason === 'daily_report';
  const subject = isDaily
    ? `Daily Inventory Planning Report – ${new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })}`
    : 'Inventory Planning Alert – Critical and Urgent SKU Requirements';
  const dashboardUrl = `${appBaseUrl()}${settings.dashboardPath || '/inventory-planning'}`;
  const { html, text } = buildInventoryPlanningEmail({ report, dashboardUrl, subject });

  const syncLogs = await getSyncSkuLogs(2000);
  let xlsxBuffer;
  try {
    xlsxBuffer = await buildInventoryPlanningWorkbook(report, syncLogs);
    await addAuditLog('xlsx_generated', 'inventory_planning', report.id, 'system', {
      bytes: xlsxBuffer.length,
    });
  } catch (err) {
    console.warn('[InventoryEmail] XLSX build failed:', err.message);
  }

  const historyId = generateId();
  try {
    await sendViaMailgun({
      to,
      cc,
      subject,
      html,
      text,
      tags: ['inventory-planning', triggerReason],
      attachmentBuffers: xlsxBuffer
        ? [{
            filename: `Inventory_Planning_${new Date().toISOString().slice(0, 10)}.xlsx`,
            data: xlsxBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }]
        : [],
    });

    await recordEmailHistory({
      id: historyId,
      triggerReason: change.reason || triggerReason,
      fingerprint: report.fingerprint,
      status: 'sent',
      recipients: { to, cc },
      subject,
      snapshotId: report.id,
    });
    await saveInventorySettings({
      lastEmailFingerprint: report.fingerprint,
      lastEmailSentAt: new Date().toISOString(),
    }, 'system');
    await addAuditLog('email_sent', 'inventory_planning', report.id, 'system', {
      triggerReason,
      to,
      cc,
    });
    return { ok: true, reportId: report.id, fingerprint: report.fingerprint, to, cc };
  } catch (err) {
    await recordEmailHistory({
      id: historyId,
      triggerReason,
      fingerprint: report.fingerprint,
      status: 'failed',
      recipients: { to, cc },
      subject,
      snapshotId: report.id,
      errorMessage: err.message,
    });
    await addAuditLog('email_failed', 'inventory_planning', report.id, 'system', {
      triggerReason,
      error: err.message,
    });
    // One extra retry after short delay for transient failures
    try {
      await new Promise((r) => setTimeout(r, 1500));
      await sendViaMailgun({
        to,
        cc,
        subject,
        html,
        text,
        tags: ['inventory-planning', triggerReason, 'retry'],
        attachmentBuffers: xlsxBuffer
          ? [{
              filename: `Inventory_Planning_${new Date().toISOString().slice(0, 10)}.xlsx`,
              data: xlsxBuffer,
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            }]
          : [],
      });
      await recordEmailHistory({
        id: generateId(),
        triggerReason,
        fingerprint: report.fingerprint,
        status: 'sent',
        recipients: { to, cc },
        subject,
        snapshotId: report.id,
      });
      await saveInventorySettings({
        lastEmailFingerprint: report.fingerprint,
        lastEmailSentAt: new Date().toISOString(),
      }, 'system');
      return { ok: true, retried: true, reportId: report.id, to, cc };
    } catch (retryErr) {
      return { ok: false, reason: 'send_failed', error: retryErr.message };
    }
  }
}

/**
 * Debounce packing/consignment-driven recalculation so packing stays non-blocking.
 * New consignments use a shorter delay so production is alerted quickly.
 */
function scheduleInventoryPlanningCheck(reason = 'quantity_change') {
  pendingReasons.add(reason);
  if (notifyTimer) clearTimeout(notifyTimer);
  const delayMs = reason === 'new_shortage' || pendingReasons.has('new_shortage') ? 2500 : 8000;
  notifyTimer = setTimeout(async () => {
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    notifyTimer = null;
    try {
      const triggerReason = reasons.includes('new_shortage')
        ? 'new_shortage'
        : reasons.includes('priority_change')
          ? 'priority_change'
          : reasons[0] || 'quantity_change';
      const report = await buildInventoryPlanningReport({ triggerReason, persist: true });
      // New consignment / shortage alerts force send when any shortage exists
      const force = triggerReason === 'new_shortage' && (report.summary?.totalShortageQty || 0) > 0;
      await sendInventoryPlanningNotification({ triggerReason, report, force });
    } catch (err) {
      console.warn('[InventoryNotify] deferred check failed:', err.message);
    }
  }, delayMs);
}

module.exports = {
  sendInventoryPlanningNotification,
  scheduleInventoryPlanningCheck,
  detectMaterialChange,
};
