const { firestoreHelpers, now } = require('../utils/helpers');
const { pgEnabled, getPool } = require('../config/database');
const { resolveStoragePath, deleteFile } = require('../utils/storage');

const DAY_MS = 24 * 60 * 60 * 1000;

async function getSettings() {
  const settings = await firestoreHelpers.getDocument('settings', 'retention');
  return {
    consignmentRetentionDays: settings?.consignmentRetentionDays ?? 450,
    videoRetentionDays: settings?.videoRetentionDays ?? 60,
    weightImageRetentionDays: settings?.weightImageRetentionDays ?? 90,
    auditLogRetentionDays: settings?.auditLogRetentionDays ?? 400,
    cleanupEnabled: settings?.cleanupEnabled ?? true
  };
}


async function cleanupOldAuditLogs(cutoffIso) {
  if (pgEnabled()) {
    const result = await getPool().query(
      `DELETE FROM documents
       WHERE collection = 'auditLogs'
         AND data->>'timestamp' IS NOT NULL
         AND (data->>'timestamp')::timestamptz < $1::timestamptz`,
      [cutoffIso]
    );
    return result.rowCount;
  }

  const allAuditLogs = await firestoreHelpers.getCollection('auditLogs');
  const oldAuditLogs = allAuditLogs.filter(log => log.timestamp && new Date(log.timestamp) < new Date(cutoffIso));
  for (const log of oldAuditLogs) {
    await firestoreHelpers.deleteDocument('auditLogs', log.id);
  }
  return oldAuditLogs.length;
}

async function deleteStorageRecord(record) {
  const path = resolveStoragePath(record);
  if (!path) return false;
  const deleted = await deleteFile(path);
  return deleted;
}

function hasTicket(consignment) {
  return Boolean(consignment && String(consignment.marketplaceTicketId || '').trim() !== '');
}

function isDisputed(consignment) {
  if (!consignment) return false;
  if (consignment.isDisputed === true || consignment.disputed === true) return true;
  const status = String(consignment.shipmentStatus || consignment.status || '').toLowerCase();
  return status.includes('disput');
}

function protectsVideos(consignment) {
  return hasTicket(consignment) || isDisputed(consignment);
}

function getVideoRetentionBaseDate(video, consignment) {
  return consignment?.dateOfInward
    || video?.dateOfInward
    || video?.inwardDate
    || video?.uploadedAt
    || video?.createdAt
    || null;
}

async function runRetentionCleanup() {
  const settings = await getSettings();
  if (!settings.cleanupEnabled) {
    console.log('[Cleanup] Cleanup disabled in settings.');
    return { skipped: true, reason: 'Cleanup disabled' };
  }

  const result = {
    consignmentsDeleted: 0,
    skusDeleted: 0,
    boxesDeleted: 0,
    videosDeleted: 0,
    weightImagesDeleted: 0,
    storageFilesDeleted: 0,
    auditLogsDeleted: 0,
    errors: []
  };

  const nowDate = new Date();

  try {
    const consignmentCutoff = new Date(nowDate.getTime() - settings.consignmentRetentionDays * DAY_MS);
    console.log(`[Cleanup] Consignment cutoff: ${consignmentCutoff.toISOString()} (${settings.consignmentRetentionDays} days)`);

    const cutoffIso = consignmentCutoff.toISOString();
    const allConsignments = await firestoreHelpers.getCollection('consignments');
    const consignmentData = allConsignments.filter(c => c.createdAt && c.createdAt < cutoffIso);

    console.log(`[Cleanup] Found ${consignmentData.length} old consignments`);

    for (const c of consignmentData) {
      try {
        if (protectsVideos(c)) {
          console.log(`[Cleanup] Skipping protected consignment ${c.id} (ticket/dispute).`);
          continue;
        }

        const skuIds = c.skuIds || [];
        if (skuIds.length) {
          await firestoreHelpers.batchDelete('skus', skuIds);
          result.skusDeleted += skuIds.length;
        }

        const boxIds = c.boxIds || [];
        if (boxIds.length) {
          await firestoreHelpers.batchDelete('boxes', boxIds);
          result.boxesDeleted += boxIds.length;
        }

        const videoIds = c.videoIds || [];
        for (const vid of videoIds) {
          try {
            const videoDoc = await firestoreHelpers.getDocument('videos', vid);
            if (videoDoc && await deleteStorageRecord(videoDoc)) {
              result.storageFilesDeleted++;
            }
            await firestoreHelpers.deleteDocument('videos', vid);
            result.videosDeleted++;
          } catch (e) {
            result.errors.push(`Video ${vid}: ${e.message}`);
          }
        }

        const documentIds = c.documentIds || [];
        for (const docId of documentIds) {
          try {
            const docData = await firestoreHelpers.getDocument('documents', docId);
            if (docData && await deleteStorageRecord(docData)) {
              result.storageFilesDeleted++;
            }
            await firestoreHelpers.deleteDocument('documents', docId);
          } catch (e) {
            result.errors.push(`Document ${docId}: ${e.message}`);
          }
        }

        await firestoreHelpers.deleteDocument('consignments', c.id);
        result.consignmentsDeleted++;
      } catch (e) {
        result.errors.push(`Consignment ${c.id}: ${e.message}`);
      }
    }

    const videoCutoff = new Date(nowDate.getTime() - settings.videoRetentionDays * DAY_MS);
    console.log(`[Cleanup] Video cutoff: ${videoCutoff.toISOString()} (${settings.videoRetentionDays} days)`);

    const allVideos = await firestoreHelpers.getCollection('videos');
    let orphanedVideos = 0;
    let protectedByTicket = 0;
    for (const v of allVideos) {
      try {
        const consignment = v.consignmentId
          ? await firestoreHelpers.getDocument('consignments', v.consignmentId)
          : null;
        const checkDate = getVideoRetentionBaseDate(v, consignment);

        if (checkDate && new Date(checkDate) < videoCutoff) {
          if (protectsVideos(consignment)) {
            protectedByTicket++;
            continue;
          }

          if (await deleteStorageRecord(v)) {
            result.storageFilesDeleted++;
          }
          await firestoreHelpers.deleteDocument('videos', v.id);
          result.videosDeleted++;
          if (!consignment) orphanedVideos++;
          if (consignment && Array.isArray(consignment.videoIds)) {
            await firestoreHelpers.setDocument('consignments', consignment.id, {
              videoIds: consignment.videoIds.filter((id) => id !== v.id),
              updatedAt: now()
            });
          }
        }
      } catch (e) {
        result.errors.push(`Video ${v.id}: ${e.message}`);
      }
    }

    // Clean up weight scale proof images after weightImageRetentionDays (default 90 days / 3 months)
    const weightImageCutoff = new Date(nowDate.getTime() - settings.weightImageRetentionDays * DAY_MS);
    console.log(`[Cleanup] Weight proof image cutoff: ${weightImageCutoff.toISOString()} (${settings.weightImageRetentionDays} days)`);

    const allDocuments = await firestoreHelpers.getCollection('documents');
    const weightImages = allDocuments.filter(d => d.type === 'weight_image');
    console.log(`[Cleanup] Found ${weightImages.length} total weight proof records. Checking age...`);

    let protectedProofs = 0;
    for (const img of weightImages) {
      try {
        const consignment = img.consignmentId
          ? await firestoreHelpers.getDocument('consignments', img.consignmentId)
          : null;

        const inwardDate = consignment?.dateOfInward || consignment?.expectedDate || img.createdAt;
        if (inwardDate && new Date(inwardDate) < weightImageCutoff) {
          if (protectsVideos(consignment)) {
            protectedProofs++;
            continue;
          }

          if (await deleteStorageRecord(img)) {
            result.storageFilesDeleted++;
          }
          await firestoreHelpers.deleteDocument('documents', img.id);
          result.weightImagesDeleted++;

          // Clear from consignment document list
          if (consignment && Array.isArray(consignment.documentIds)) {
            const nextDocIds = consignment.documentIds.filter(id => id !== img.id);
            await firestoreHelpers.setDocument('consignments', consignment.id, {
              ...consignment,
              documentIds: nextDocIds,
              updatedAt: now()
            });
          }

          // Clear from corresponding box
          if (img.boxNo && img.consignmentId) {
            const boxId = `${img.consignmentId}_box_${img.boxNo}`;
            const boxDoc = await firestoreHelpers.getDocument('boxes', boxId);
            if (boxDoc && boxDoc.weightImageId) {
              await firestoreHelpers.setDocument('boxes', boxId, {
                ...boxDoc,
                weightImageId: null,
                updatedAt: now()
              });
            }
          }
        }
      } catch (e) {
        result.errors.push(`Weight Proof ${img.id}: ${e.message}`);
      }
    }


    // Audit logs are protected from user-facing delete actions. To control database size,
    // retention cleanup removes only records older than auditLogRetentionDays (default 400 days).
    const auditLogCutoff = new Date(nowDate.getTime() - settings.auditLogRetentionDays * DAY_MS);
    console.log(`[Cleanup] Audit log cutoff: ${auditLogCutoff.toISOString()} (${settings.auditLogRetentionDays} days)`);

    try {
      result.auditLogsDeleted = await cleanupOldAuditLogs(auditLogCutoff.toISOString());
      console.log(`[Cleanup] Deleted ${result.auditLogsDeleted} audit logs older than ${settings.auditLogRetentionDays} days`);
    } catch (e) {
      result.errors.push(`Audit Logs: ${e.message}`);
    }

    console.log(`[Cleanup] Deleted ${result.consignmentsDeleted} consignments, ${result.skusDeleted} SKUs, ${result.boxesDeleted} boxes, ${result.videosDeleted} videos, ${result.weightImagesDeleted} weight proofs (${protectedProofs} protected by Ticket ID), ${result.storageFilesDeleted} storage files, ${result.auditLogsDeleted} audit logs older than ${settings.auditLogRetentionDays} days`);

    await firestoreHelpers.setDocument('settings', 'retention', {
      lastCleanupRun: now(),
      updatedAt: now()
    });

    return result;
  } catch (error) {
    console.error('[Cleanup] Error:', error);
    result.errors.push(error.message);
    return result;
  }
}

if (require.main === module) {
  runRetentionCleanup().then(result => {
    console.log('[Cleanup] Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('[Cleanup] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runRetentionCleanup, getSettings };
