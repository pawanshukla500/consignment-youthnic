/**
 * Pure helpers for the firebase-login hot path.
 * Kept separate so timing/security choices can be unit-tested without Express.
 */

function shouldCheckRevoked(env = process.env) {
  const raw = String(env.AUTH_CHECK_REVOKED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function buildSessionUserFromAuth(user, decoded, nowFn = () => new Date().toISOString()) {
  const loginAt = nowFn();
  return {
    ...user,
    firebaseUid: decoded?.uid || user.firebaseUid || user.firebase_uid || null,
    lastLoginAt: loginAt,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: user.permissions || {},
    warehouseId: user.warehouseId || user.warehouse_id || user.warehouse || null,
    isActive: user.isActive !== false,
    updatedAt: loginAt,
  };
}

function summarizeLoginTimings(timings = {}) {
  const entries = Object.entries(timings).filter(([, ms]) => Number.isFinite(ms));
  const totalMs = entries.reduce((sum, [, ms]) => sum + ms, 0);
  return {
    totalMs,
    stages: Object.fromEntries(entries),
  };
}

module.exports = {
  shouldCheckRevoked,
  buildSessionUserFromAuth,
  summarizeLoginTimings,
};
