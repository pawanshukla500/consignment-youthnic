/**
 * Transactional Outbox for WhatsApp Notifications.
 * Ensures we decouple OpenWA delivery from core business transactions.
 */
const { getPool, pgEnabled } = require('../config/database');
const openwaClient = require('./openwaClient');

const OUTBOX_PROCESSOR_ID = `outbox-worker-${Math.random().toString(36).substring(2, 9)}`;

/**
 * Enqueue a WhatsApp notification event into the outbox.
 * Can be called with a transaction client or the default pool.
 */
async function enqueueWhatsAppNotification(entityType, entityId, eventType, payload, client = null) {
  if (!pgEnabled()) {
    console.warn('[WhatsAppOutbox] Skipping enqueue - Postgres is not enabled');
    return { ok: false, reason: 'Postgres disabled' };
  }

  try {
    const db = client || getPool();
    const query = `
      INSERT INTO whatsapp_notification_outbox 
      (entity_type, entity_id, event_type, payload, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id;
    `;
    const result = await db.query(query, [entityType, entityId, eventType, JSON.stringify(payload)]);
    return { ok: true, id: result.rows[0].id };
  } catch (error) {
    console.error('[WhatsAppOutbox] Failed to enqueue notification:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Process pending items in the outbox. Designed to be called by Cloud Scheduler or a background worker.
 */
async function processOutbox(limit = 10) {
  if (!pgEnabled()) return { processed: 0, failed: 0, reason: 'Postgres disabled' };

  const pool = getPool();
  let processed = 0;
  let failed = 0;
  
  // Claim pending or stuck items
  const claimQuery = `
    UPDATE whatsapp_notification_outbox
    SET status = 'claimed',
        claimed_at = now(),
        claimed_by = $1,
        attempts = attempts + 1,
        updated_at = now()
    WHERE id IN (
      SELECT id 
      FROM whatsapp_notification_outbox 
      WHERE status = 'pending' 
         OR (status = 'claimed' AND claimed_at < now() - interval '5 minutes')
         OR (status = 'failed' AND attempts < 5)
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  try {
    const claimResult = await pool.query(claimQuery, [OUTBOX_PROCESSOR_ID, limit]);
    const jobs = claimResult.rows;

    for (const job of jobs) {
      let success = false;
      let errorMsg = null;

      try {
        // Here we format the text and send via openwaClient
        const payload = job.payload;
        let response;
        
        if (payload.type === 'text') {
          response = await openwaClient.sendText(payload.text, payload.chatId);
        } else if (payload.type === 'file') {
          response = await openwaClient.sendFile(payload.fileUrl, payload.filename, payload.caption, payload.chatId);
        } else {
          throw new Error(`Unknown payload type: ${payload.type}`);
        }

        if (response.ok) {
          success = true;
        } else {
          errorMsg = response.error;
        }
      } catch (error) {
        errorMsg = error.message;
      }

      // Update job status
      if (success) {
        await pool.query(
          `UPDATE whatsapp_notification_outbox SET status = 'processed', processed_at = now(), error_message = null WHERE id = $1`,
          [job.id]
        );
        processed++;
      } else {
        await pool.query(
          `UPDATE whatsapp_notification_outbox SET status = 'failed', error_message = $1 WHERE id = $2`,
          [errorMsg, job.id]
        );
        failed++;
        console.error(`[WhatsAppOutbox] Job ${job.id} failed:`, errorMsg);
      }
    }

    return { ok: true, processed, failed, totalClaimed: jobs.length };
  } catch (error) {
    console.error('[WhatsAppOutbox] Outbox processor error:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  enqueueWhatsAppNotification,
  processOutbox,
};
