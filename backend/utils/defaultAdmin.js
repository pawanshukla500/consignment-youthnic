const { DEFAULT_USER } = require('../middleware/auth');
const { firestoreHelpers, now } = require('./helpers');
const { sanitizeUserForStorage } = require('./sanitizeUser');

const DEFAULT_PERMISSIONS = {
  consignments: true,
  packing: true,
  productivity: true,
  marketplaces: true,
  users: true,
  auditLogs: true,
  deleteConsignments: true,
  deleteVideos: true,
  editBoxQuantities: true,
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function permissionsEqual(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if (Boolean(a?.[key]) !== Boolean(b?.[key])) return false;
  }
  return true;
}

function buildCanonicalAdmin(existing = {}, options = {}) {
  const { name: nameOverride, firebaseUid } = options;
  return sanitizeUserForStorage({
    ...existing,
    id: DEFAULT_USER.id,
    email: normalizeEmail(DEFAULT_USER.email),
    name: nameOverride || existing.name || DEFAULT_USER.name,
    role: 'admin',
    isActive: existing.isActive !== false,
    isDefault: true,
    permissions: { ...DEFAULT_PERMISSIONS, ...(existing.permissions || {}) },
    firebaseUid: firebaseUid || existing.firebaseUid || existing.firebase_uid || null,
    createdAt: existing.createdAt || DEFAULT_USER.createdAt,
    updatedAt: now(),
  });
}

function needsAdminRewrite(existing, next) {
  if (!existing) return true;
  if (existing.id !== next.id) return true;
  if (normalizeEmail(existing.email) !== normalizeEmail(next.email)) return true;
  if ((existing.name || '') !== (next.name || '')) return true;
  if (existing.role !== 'admin') return true;
  if (existing.isActive === false) return true;
  if (!existing.isDefault) return true;
  if ((existing.firebaseUid || existing.firebase_uid || null) !== (next.firebaseUid || null)) return true;
  if (!permissionsEqual(existing.permissions, next.permissions)) return true;
  return false;
}

/**
 * Ensure the bootstrap admin exists.
 * Fast path: read by id / email instead of loading the entire users collection.
 * Skips the write when the stored document is already canonical.
 */
async function ensureDefaultAdminUser(options = {}) {
  const canonicalEmail = normalizeEmail(DEFAULT_USER.email);

  let adminUser = await firestoreHelpers.getDocument('users', DEFAULT_USER.id);
  if (!adminUser) {
    const matches = await firestoreHelpers.queryCollection('users', 'email', '==', canonicalEmail);
    adminUser = matches[0] || null;
  }

  if (!adminUser) {
    // Rare fallback for legacy rows that used a different email casing/id shape.
    const users = await firestoreHelpers.getCollection('users');
    adminUser = users.find(
      (user) => user && (user.id === DEFAULT_USER.id || normalizeEmail(user.email) === canonicalEmail)
    ) || null;
  }

  if (!adminUser) {
    const created = buildCanonicalAdmin({}, options);
    await firestoreHelpers.setDocument('users', DEFAULT_USER.id, created);
    return created;
  }

  const migratedUser = buildCanonicalAdmin(adminUser, options);
  if (needsAdminRewrite(adminUser, migratedUser)) {
    await firestoreHelpers.setDocument('users', DEFAULT_USER.id, migratedUser);
    if (adminUser.id && adminUser.id !== DEFAULT_USER.id) {
      await firestoreHelpers.deleteDocument('users', adminUser.id);
    }
  }

  return migratedUser;
}

/**
 * Lightweight admin load for login /me — prefers a single document read.
 * Falls back to ensureDefaultAdminUser only when the document is missing.
 */
async function loadDefaultAdminForSession(options = {}) {
  const existing = await firestoreHelpers.getDocument('users', DEFAULT_USER.id);
  if (existing && existing.isActive !== false) {
    const { name: nameOverride, firebaseUid } = options;
    return sanitizeUserForStorage({
      ...existing,
      id: DEFAULT_USER.id,
      email: normalizeEmail(existing.email || DEFAULT_USER.email),
      name: nameOverride || existing.name || DEFAULT_USER.name,
      role: 'admin',
      permissions: { ...DEFAULT_PERMISSIONS, ...(existing.permissions || {}) },
      firebaseUid: firebaseUid || existing.firebaseUid || existing.firebase_uid || null,
      isActive: true,
      isDefault: true,
    });
  }
  return ensureDefaultAdminUser(options);
}

module.exports = {
  DEFAULT_PERMISSIONS,
  ensureDefaultAdminUser,
  loadDefaultAdminForSession,
  normalizeEmail,
  needsAdminRewrite,
  permissionsEqual,
};
