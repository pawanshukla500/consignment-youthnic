/**
 * Scheduled sweep that pushes box-wise packing data to the Consignment Master
 * sheet for every consignment that has changed since its last successful push.
 *
 * Runs daily at 07:00 Asia/Kolkata (see server.js). Because the push writes
 * fixed cells (columns I and J of already-matched rows), a duplicate run — two
 * Cloud Run instances, or a retry — is harmless.
 */

const { getPool, pgEnabled } = require('../config/database');
const { firestoreHelpers, now, addAuditLog } = require('./helpers');
const { pushPackingToSheet } = require('./consignmentSheetPush');

const DEFAULT_MAX_PER_RUN = Number(process.env.SHEET_PUSH_MAX_PER_RUN || 100);
const PAUSE_BETWEEN_PUSHES_MS = Number(process.env.SHEET_PUSH_PAUSE_MS || 400);

let running = false;

function isSweepRunning() {
  return running;
}

/**
 * Consignments worth pushing: not archived, has at least one saved box, has an
 * Internal Shipment No. to match on, and either never pushed or changed since
 * the last push. The staleness check happens in SQL so unchanged consignments
 * never cost a packing-report build.
 */
async function findPushCandidates(limit = DEFAULT_MAX_PER_RUN) {
  const { rows } = await getPool().query(
    `SELECT data
       FROM documents
      WHERE collection = 'consignments'
        AND COALESCE(data->>'internalShipmentNo', '') <> ''
        AND jsonb_array_length(COALESCE(data->'boxIds', '[]'::jsonb)) > 0
        AND COALESCE(data->>'operationalStatus', '') <> 'archived'
        AND COALESCE((data->>'isArchived')::boolean, false) = false
        AND (
              data->'sheetPush'->>'at' IS NULL
              OR COALESCE(data->'sheetPush'->>'at', '') < COALESCE(data->>'updatedAt', '')
            )
      ORDER BY data->>'updatedAt' DESC
      LIMIT $1`,
    [limit]
  );
  return rows.map((row) => row.data).filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push every stale consignment. Individual failures are recorded and the sweep
 * continues — one unreachable shipment must not stop the rest.
 */
async function runScheduledSheetPush({ trigger = 'scheduled', limit = DEFAULT_MAX_PER_RUN } = {}) {
  if (!pgEnabled()) return { ok: false, reason: 'datastore_unavailable', pushed: 0 };
  if (running) return { ok: false, reason: 'already_running', pushed: 0 };

  running = true;
  const startedAt = Date.now();
  const summary = { ok: true, trigger, candidates: 0, pushed: 0, skipped: 0, failed: 0, failures: [] };

  try {
    // Required late to avoid a require cycle: routes/consignments pulls in the
    // push util, which the scheduler also uses.
    const { loadPackingReport } = require('../routes/consignments');

    const candidates = await findPushCandidates(limit);
    summary.candidates = candidates.length;

    for (const consignment of candidates) {
      const internalShipmentNo = consignment.internalShipmentNo || '';
      try {
        const loaded = await loadPackingReport(consignment.id);
        if (!loaded) {
          summary.skipped++;
          continue;
        }

        const result = await pushPackingToSheet({
          internalShipmentNo,
          reportRows: loaded.report.rows || [],
        });

        if (!result.ok) {
          summary.failed++;
          summary.failures.push({
            consignmentId: consignment.id,
            internalShipmentNo,
            reason: result.reason,
            error: result.error,
          });
          // A shipment that simply has no rows in the sheet is stamped so the
          // sweep does not retry it every single day.
          if (result.reason === 'shipment_not_in_sheet') {
            await stampPush(consignment.id, {
              at: now(),
              trigger,
              updated: 0,
              skippedReason: result.reason,
              fingerprint: consignment.sheetPush?.fingerprint || '',
            });
          }
          continue;
        }

        // Nothing to write (no SKU matched a sheet row), or unchanged since the
        // last push. Stamp the time so the SQL staleness filter stops selecting
        // it, but do not count it as work done.
        const unchanged = result.fingerprint && result.fingerprint === consignment.sheetPush?.fingerprint;
        if (result.reason === 'nothing_to_write' || unchanged) {
          summary.skipped++;
          await stampPush(consignment.id, {
            ...(consignment.sheetPush || {}),
            at: now(),
            trigger,
            ...(result.reason === 'nothing_to_write' ? { skippedReason: result.reason } : {}),
          });
          continue;
        }

        summary.pushed++;
        await stampPush(consignment.id, {
          at: now(),
          trigger,
          by: 'scheduler',
          byName: 'Daily sheet sync',
          updated: result.updated || 0,
          fingerprint: result.fingerprint || '',
        });
        await addAuditLog('sheet_push', 'consignment', consignment.id, 'scheduler', {
          internalShipmentNo,
          updated: result.updated || 0,
          cleared: result.cleared || 0,
          trigger,
        });
      } catch (err) {
        summary.failed++;
        summary.failures.push({ consignmentId: consignment.id, internalShipmentNo, error: err.message });
      }

      if (PAUSE_BETWEEN_PUSHES_MS > 0) await sleep(PAUSE_BETWEEN_PUSHES_MS);
    }
  } catch (err) {
    summary.ok = false;
    summary.error = err.message;
  } finally {
    running = false;
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

async function stampPush(consignmentId, sheetPush) {
  // setDocument shallow-merges, so only sheetPush is replaced.
  await firestoreHelpers.setDocument('consignments', consignmentId, { sheetPush });
}

module.exports = {
  DEFAULT_MAX_PER_RUN,
  findPushCandidates,
  runScheduledSheetPush,
  isSweepRunning,
};
