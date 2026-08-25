const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getOpenWaStatus } = require('../utils/openwaClient');
const { getPool, pgEnabled } = require('../config/database');
const { enqueueWhatsAppNotification } = require('../utils/whatsappOutbox'); // if we need it for manual testing

// All routes here should be protected by authenticateToken and requireRole('admin')
// We can apply it at the router level in server.js, but let's be explicit here too.
router.use(authenticateToken);
router.use(requireRole('admin'));

/**
 * GET /api/internal/admin/whatsapp/status
 * Exposes health/status without leaking secrets.
 */
router.get('/status', async (req, res) => {
  try {
    const status = getOpenWaStatus();
    
    let pendingOutboxCount = 0;
    let failedCount = 0;
    let lastSuccessfulSendTime = null;

    if (pgEnabled()) {
      const pool = getPool();
      
      const pendingRes = await pool.query(`SELECT count(*) as count FROM whatsapp_notification_outbox WHERE status = 'pending' OR status = 'processing'`);
      pendingOutboxCount = parseInt(pendingRes.rows[0].count, 10);
      
      const failedRes = await pool.query(`SELECT count(*) as count FROM whatsapp_notification_outbox WHERE status = 'failed'`);
      failedCount = parseInt(failedRes.rows[0].count, 10);
      
      const lastSentRes = await pool.query(`SELECT max(sent_at) as last_sent FROM whatsapp_notification_outbox WHERE status = 'sent'`);
      lastSuccessfulSendTime = lastSentRes.rows[0].last_sent;
    }

    res.json({
      ...status,
      pendingOutboxCount,
      failedCount,
      lastSuccessfulSendTime,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/internal/admin/whatsapp/outbox
 * Lists recent outbox entries for debugging.
 */
router.get('/outbox', async (req, res) => {
  try {
    if (!pgEnabled()) return res.status(503).json({ error: 'Postgres required' });
    const pool = getPool();
    const result = await pool.query(`
      SELECT id, consignment_id, event_type, dedupe_key, group_id, status, attempt_count, max_attempts, next_attempt_at, openwa_message_id, last_error, created_at, updated_at, sent_at
      FROM whatsapp_notification_outbox
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ outbox: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/internal/admin/whatsapp/outbox/:id/retry
 * Manually forces a retry of a failed job.
 */
router.post('/outbox/:id/retry', async (req, res) => {
  try {
    if (!pgEnabled()) return res.status(503).json({ error: 'Postgres required' });
    const pool = getPool();
    const { id } = req.params;
    
    const result = await pool.query(`
      UPDATE whatsapp_notification_outbox
      SET status = 'pending', attempt_count = 0, next_attempt_at = now()
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Outbox entry not found' });
    }

    res.json({ ok: true, job: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/internal/admin/whatsapp/trigger-report
 * Manually triggers WhatsApp reports.
 */
router.post('/trigger-report', async (req, res) => {
  try {
    const { reportType } = req.body;
    const { 
      sendMorningWhatsAppBrief, 
      sendEndOfDayWhatsAppSummary, 
      sendTATApproachingAlert 
    } = require('../utils/whatsappReports');

    let result;
    if (reportType === 'morning') {
      result = await sendMorningWhatsAppBrief();
    } else if (reportType === 'eod') {
      result = await sendEndOfDayWhatsAppSummary();
    } else if (reportType === 'tat_alert') {
      result = await sendTATApproachingAlert();
    } else {
      return res.status(400).json({ error: 'Invalid reportType' });
    }

    res.json({ ok: true, result });
      
    // Immediately process the outbox asynchronously
    const { processOutbox } = require('../utils/whatsappOutbox');
    processOutbox(20).catch(err => console.error('[WhatsAppAdmin] processOutbox async error:', err));
      
  } catch (error) {
    console.error('[WhatsAppAdmin] Error triggering report:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
