/**
 * Validates that an R2 object path belongs to the claimed consignment.
 * Paths must match the client upload convention in storagePaths.js / useStorageUpload.js.
 */
function sanitizeConsignmentId(consignmentId) {
  return String(consignmentId || '').replace(/[^\w.-]/g, '_');
}

function isStoragePathForConsignment(storagePath, consignmentId) {
  if (!storagePath || !consignmentId) return false;
  const normalized = String(storagePath).replace(/^\/+/, '').trim();
  if (!normalized.startsWith('consignments/')) return false;

  const safeId = sanitizeConsignmentId(consignmentId);
  const allowedPrefixes = [
    `consignments/${consignmentId}/`,
    `consignments/${safeId}/`,
  ];
  return allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

module.exports = {
  sanitizeConsignmentId,
  isStoragePathForConsignment,
};
