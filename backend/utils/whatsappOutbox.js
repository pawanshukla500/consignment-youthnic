/**
 * Transactional Outbox for WhatsApp Notifications.
 * Ensures we decouple OpenWA delivery from core business transactions.
 */
const { getPool, pgEnabled } = require('../config/database');
const openwaClient = require('./openwaClient');
const { resolveReadableUrl } = require('./storage');

const OUTBOX_PROCESSOR_ID = `outbox-worker-${Math.random().toString(36).substring(2, 9)}`;

/**
 * Enqueue a WhatsApp notification event into the outbox.
 * Can be called with a transaction client or the default pool.
 */
async function enqueueWhatsAppNotification(consignmentId, eventType, dedupeKey, text, attachments = [], mentions = [], client = null) {
  if (!pgEnabled()) {
    console.warn('[WhatsAppOutbox] Skipping enqueue - Postgres is not enabled');
    return { ok: false, reason: 'Postgres disabled' };
  }
  
  const config = openwaClient.getOpenWAConfig();
  if (!config.enabled) {
    console.warn('[WhatsAppOutbox] Skipping enqueue - WhatsApp is disabled');
    return { ok: false, reason: 'WhatsApp disabled' };
  }

  try {
    const db = client || getPool();
    const query = `
      INSERT INTO whatsapp_notification_outbox 
      (consignment_id, event_type, dedupe_key, group_id, message_text, attachments, mentions, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id;
    `;
    const result = await db.query(query, [
      consignmentId, 
      eventType, 
      dedupeKey, 
      config.groupId, 
      text, 
      JSON.stringify(attachments),
      JSON.stringify(mentions)
    ]);
    
    if (result.rowCount === 0) {
      return { ok: true, skipped: true, reason: 'Duplicate dedupe_key' };
    }
    
    // Auto-trigger outbox processor in the background
    setTimeout(() => {
      processOutbox(5).catch(err => console.error('[WhatsAppOutbox] Auto-trigger processOutbox failed:', err.message));
    }, 2000);
    
    return { ok: true, id: result.rows[0].id };
  } catch (error) {
    console.error('[WhatsAppOutbox] Failed to enqueue notification:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Calculate the next attempt time with bounded exponential backoff.
 * 1m, 5m, 15m, 1h, then failed.
 */
function calculateNextAttempt(attemptCount) {
  const delaysMin = [1, 5, 15, 60];
  const delay = delaysMin[Math.min(attemptCount, delaysMin.length - 1)];
  return `now() + interval '${delay} minutes'`;
}

/**
 * Process pending items in the outbox. Designed to be called by Cloud Scheduler or a background worker.
 */
async function processOutbox(limit = 10) {
  if (!pgEnabled()) return { processed: 0, failed: 0, reason: 'Postgres disabled' };
  
  const config = openwaClient.getOpenWAConfig();
  if (!config.enabled) {
    return { processed: 0, failed: 0, reason: 'WhatsApp disabled' };
  }

  const pool = getPool();
  let processed = 0;
  let failed = 0;
  
  // Claim pending or due items
  const claimQuery = `
    UPDATE whatsapp_notification_outbox
    SET status = 'processing',
        attempt_count = attempt_count + 1,
        updated_at = now()
    WHERE id IN (
      SELECT id 
      FROM whatsapp_notification_outbox 
      WHERE (status = 'pending' OR (status = 'failed' AND attempt_count < max_attempts))
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  try {
    const claimResult = await pool.query(claimQuery, [limit]);
    const jobs = claimResult.rows;

    for (const job of jobs) {
      let success = false;
      let errorMsg = null;
      let messageId = null;

      try {
        // Send attachments first, then text (or handle them together based on WAHA API limits)
        let response;
        if (job.attachments && job.attachments.length > 0) {
           const attach = job.attachments[0];
           
           let finalUrl = attach.url;
           if (attach.storagePath) {
             finalUrl = await resolveReadableUrl({ storagePath: attach.storagePath }, { expiresMs: 3600000 });
           }

           if (attach.type === 'image') {
              response = await openwaClient.sendImage({
                chatId: job.group_id,
                url: finalUrl,
                base64: attach.base64,
                caption: job.message_text,
                mimetype: attach.mimeType,
                mentions: job.mentions
              });
           } else if (attach.type === 'document') {
              response = await openwaClient.sendDocument({
                chatId: job.group_id,
                url: finalUrl,
                base64: attach.base64,
                filename: attach.filename,
                mimetype: attach.mimeType,
                caption: job.message_text,
                mentions: job.mentions
              });
           }
        } else {
           response = await openwaClient.sendText({ 
             chatId: job.group_id, 
             text: job.message_text,
             mentions: job.mentions 
           });
        }

        if (response.ok) {
          success = true;
          messageId = response.data?.id || null;
        } else {
          errorMsg = response.error;
        }
      } catch (error) {
        errorMsg = error.message;
      }

      // Update job status
      if (success) {
        await pool.query(
          `UPDATE whatsapp_notification_outbox 
           SET status = 'sent', sent_at = now(), openwa_message_id = $1, last_error = null 
           WHERE id = $2`,
          [messageId, job.id]
        );
        processed++;
      } else {
        const nextAttemptStr = calculateNextAttempt(job.attempt_count);
        await pool.query(
          `UPDATE whatsapp_notification_outbox 
           SET status = 'failed', last_error = $1, next_attempt_at = ${nextAttemptStr} 
           WHERE id = $2`,
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
