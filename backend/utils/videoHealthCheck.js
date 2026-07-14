const { firestoreHelpers } = require('./helpers');
const { resolveStoragePath, getStorageFileMeta, resolveVideoStoragePath } = require('./storage');

const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;

function isTrustedVerified(video) {
  if (!video?.storageVerified) return false;
  const at = video.storageVerifiedAt ? new Date(video.storageVerifiedAt).getTime() : 0;
  if (!Number.isFinite(at) || at <= 0) return false;
  return (Date.now() - at) < VERIFIED_TTL_MS;
}

/**
 * Checks all video records for a consignment.
 * Returns { ok: [], missing: [], orphaned: [] }
 * Trusted recently-verified metadata skips a Storage round-trip (L4).
 */
async function checkConsignmentVideos(consignmentId) {
  const videos = await firestoreHelpers.queryCollection('videos', 'consignmentId', '==', consignmentId);
  const ok = [];
  const missing = [];
  const orphaned = [];

  await Promise.all(videos.map(async (video) => {
    if (video.active === false) return;
    // Removal evidence videos are tracked separately and must not block packing finish.
    if (video.type === 'removal_video' || video.purpose === 'quantity_removal') return;
    const storagePath = (await resolveVideoStoragePath(video)) || resolveStoragePath(video);
    if (!storagePath) {
      missing.push({ id: video.id, boxNo: video.boxNo });
      return;
    }
    if (isTrustedVerified(video)) {
      ok.push({ id: video.id, boxNo: video.boxNo, storagePath, cached: true });
      return;
    }
    const meta = await getStorageFileMeta(storagePath).catch(() => null);
    if (!meta) {
      orphaned.push({ id: video.id, boxNo: video.boxNo, storagePath });
    } else {
      ok.push({ id: video.id, boxNo: video.boxNo, storagePath, sizeBytes: meta.size });
      // Refresh trusted cache asynchronously
      firestoreHelpers.setDocument('videos', video.id, {
        storageVerified: true,
        storageVerifiedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }));

  return { ok, missing, orphaned };
}

module.exports = { checkConsignmentVideos, isTrustedVerified, VERIFIED_TTL_MS };
