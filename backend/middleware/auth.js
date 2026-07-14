const jwt = require('jsonwebtoken');
const { firestoreHelpers } = require('../utils/helpers');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

if (!process.env.JWT_SECRET) {
  throw new Error('[SECURITY] JWT_SECRET environment variable is required.');
}

const JWT_SECRET = process.env.JWT_SECRET;

// Default admin identity. Password lives in Firebase Auth — not in source control.
// ADMIN_PASSWORD is only used for first-time Firebase account creation via bootstrap.
const DEFAULT_USER = {
  id: 'default-admin',
  email: process.env.ADMIN_EMAIL || 'returnorders@vbexports.co.in',
  password: process.env.ADMIN_PASSWORD || null,
  name: process.env.ADMIN_NAME || 'Pawan Shukla',
  role: 'admin',
  createdAt: new Date().toISOString(),
};

async function loadFreshUserRecord(reqUser) {
  if (!reqUser?.id) return null;

  if (reqUser.id === DEFAULT_USER.id) {
    const doc = await firestoreHelpers.getDocument('users', DEFAULT_USER.id);
    return doc || { ...DEFAULT_USER, permissions: {}, isActive: true, tokenVersion: 1 };
  }

  const direct = await firestoreHelpers.getDocument('users', reqUser.id);
  if (direct) return direct;

  const email = normalizeEmail(reqUser.email);
  if (!email) return null;

  try {
    const matches = await firestoreHelpers.queryCollection('users', 'email', '==', email);
    return matches[0] || null;
  } catch (error) {
    console.warn('[Auth] email lookup fallback failed:', error.message);
    return null;
  }
}

function currentTokenVersion(user) {
  const version = Number(user?.tokenVersion);
  return Number.isFinite(version) && version > 0 ? version : 1;
}

/**
 * Verify JWT, then reject deactivated accounts and stale token versions.
 * Async middleware — Express 4 supports this when errors are handled via res.
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];
  // Query-string tokens for EventSource and video stream (no Authorization header on <video>).
  const allowQueryToken = req.originalUrl?.startsWith('/api/sync/events')
    || /^\/api\/uploads\/stream\//.test(req.originalUrl || '')
    || /^\/uploads\/stream\//.test(req.path || '');
  const queryToken = allowQueryToken ? req.query?.token : null;
  const token = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const fresh = await loadFreshUserRecord(decoded);
    if (fresh?.isActive === false) {
      console.warn('[Auth] denied deactivated user', { userId: decoded.id });
      return res.status(403).json({ error: 'Account is deactivated.' });
    }

    const expectedVersion = currentTokenVersion(fresh || decoded);
    const presentedVersion = currentTokenVersion(decoded);
    if (fresh && presentedVersion !== expectedVersion) {
      console.warn('[Auth] denied stale token version', {
        userId: decoded.id,
        presentedVersion,
        expectedVersion,
      });
      return res.status(403).json({ error: 'Session expired. Please sign in again.' });
    }

    if (fresh) {
      req.user = {
        ...decoded,
        ...fresh,
        role: fresh.role || decoded.role,
        permissions: fresh.permissions || decoded.permissions || {},
        tokenVersion: expectedVersion,
        isActive: fresh.isActive !== false,
      };
    }

    return next();
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    if (error?.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    console.error('[Auth] authenticateToken failed:', error.message);
    return res.status(500).json({ error: 'Authentication check failed.' });
  }
};

const requireRole = (...roles) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      const fresh = await loadFreshUserRecord(req.user);
      if (fresh?.isActive === false) {
        return res.status(403).json({ error: 'Account is deactivated.' });
      }

      const role = fresh?.role || req.user.role;
      if (role === 'admin') {
        req.user = { ...req.user, ...fresh, role: 'admin' };
        return next();
      }

      if (!roles.includes(role)) {
        return res.status(403).json({ error: 'Insufficient permissions.' });
      }

      req.user = { ...req.user, ...fresh, role };
      return next();
    } catch (error) {
      console.error('[Auth] requireRole lookup failed:', error.message);
      return res.status(500).json({ error: 'Authorization check failed.' });
    }
  };
};

module.exports = {
  authenticateToken,
  requireRole,
  loadFreshUserRecord,
  currentTokenVersion,
  DEFAULT_USER,
  JWT_SECRET,
};
