const { DEFAULT_USER } = require('../middleware/auth');
const { firestoreHelpers } = require('./helpers');

const DELETE_CONSIGNMENTS = 'deleteConsignments';
const DELETE_VIDEOS = 'deleteVideos';
const EDIT_BOX_QUANTITIES = 'editBoxQuantities';

const BASE_PERMISSIONS = {
  consignments: true,
  packing: true,
  productivity: false,
  marketplaces: false,
  users: false,
  auditLogs: false,
  [DELETE_CONSIGNMENTS]: false,
  [DELETE_VIDEOS]: false,
  [EDIT_BOX_QUANTITIES]: false,
};

/** Admin and Organization Head have full operational access by default. */
function isElevatedRole(role) {
  return role === 'admin' || role === 'organization_head';
}

function normalizePermissions(role = 'user', permissions = {}) {
  const normalized = {
    ...BASE_PERMISSIONS,
    ...(permissions || {}),
  };

  if (!isElevatedRole(role)) {
    normalized[DELETE_CONSIGNMENTS] = permissions?.[DELETE_CONSIGNMENTS] === true;
    normalized[DELETE_VIDEOS] = permissions?.[DELETE_VIDEOS] === true;
    normalized[EDIT_BOX_QUANTITIES] = permissions?.[EDIT_BOX_QUANTITIES] === true;
  }

  // Admin + Organization Head: full access to every module / sensitive action.
  if (isElevatedRole(role)) {
    Object.keys(normalized).forEach((key) => {
      normalized[key] = true;
    });
  }

  return normalized;
}

function hasPermission(user, permissionKey) {
  if (!user) return false;
  if (isElevatedRole(user.role)) return true;
  return user.permissions?.[permissionKey] === true;
}

async function getUserForPermissionCheck(reqUser) {
  if (!reqUser) return null;
  if (isElevatedRole(reqUser.role) || reqUser.id === DEFAULT_USER.id) return reqUser;

  const direct = await firestoreHelpers.getDocument('users', reqUser.id);
  if (direct) return { ...reqUser, ...direct };

  const email = String(reqUser.email || '').trim().toLowerCase();
  if (!email) return reqUser;

  // Prefer indexed email lookup — never scan the full users collection on the hot path.
  try {
    const matches = await firestoreHelpers.queryCollection('users', 'email', '==', email);
    const byEmail = matches[0] || null;
    return byEmail ? { ...reqUser, ...byEmail } : reqUser;
  } catch (error) {
    console.warn('[Permissions] email lookup failed:', error.message);
    return reqUser;
  }
}

async function requestUserHasPermission(req, permissionKey) {
  const user = await getUserForPermissionCheck(req.user);
  return hasPermission(user, permissionKey);
}

async function requestUserHasAnyPermission(req, permissionKeys = []) {
  const user = await getUserForPermissionCheck(req.user);
  if (!user) return false;
  if (isElevatedRole(user.role)) return true;
  return permissionKeys.some((key) => hasPermission(user, key));
}

function requirePermission(permissionKey, label = 'this action') {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
      if (await requestUserHasPermission(req, permissionKey)) return next();
      console.warn('[Permissions] denied', {
        userId: req.user.id,
        permission: permissionKey,
        path: req.originalUrl,
      });
      return res.status(403).json({ error: `You do not have permission to ${label}.` });
    } catch (error) {
      console.error('[Permissions] check failed:', error.message);
      return res.status(500).json({ error: 'Permission check failed.' });
    }
  };
}

/** Allow if the user has any of the listed permissions (admins always pass). */
function requireAnyPermission(permissionKeys, label = 'this action') {
  const keys = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
      if (await requestUserHasAnyPermission(req, keys)) return next();
      console.warn('[Permissions] denied', {
        userId: req.user.id,
        permissions: keys,
        path: req.originalUrl,
      });
      return res.status(403).json({ error: `You do not have permission to ${label}.` });
    } catch (error) {
      console.error('[Permissions] check failed:', error.message);
      return res.status(500).json({ error: 'Permission check failed.' });
    }
  };
}

function diffPermissions(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = {};
  keys.forEach((key) => {
    if (Boolean(before?.[key]) !== Boolean(after?.[key])) {
      changes[key] = {
        from: Boolean(before?.[key]),
        to: Boolean(after?.[key]),
      };
    }
  });
  return changes;
}

module.exports = {
  BASE_PERMISSIONS,
  DELETE_CONSIGNMENTS,
  DELETE_VIDEOS,
  EDIT_BOX_QUANTITIES,
  isElevatedRole,
  normalizePermissions,
  hasPermission,
  requestUserHasPermission,
  requestUserHasAnyPermission,
  requirePermission,
  requireAnyPermission,
  diffPermissions,
};
