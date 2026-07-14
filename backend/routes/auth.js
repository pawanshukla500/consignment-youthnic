const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { DEFAULT_USER, JWT_SECRET, authenticateToken, requireRole, currentTokenVersion } = require('../middleware/auth');
const { firestoreHelpers, addAuditLog, now } = require('../utils/helpers');
const { pgEnabled } = require('../config/database');
const pgHelpers = require('../utils/pgHelpers');
const { DEFAULT_PERMISSIONS, loadDefaultAdminForSession, normalizeEmail } = require('../utils/defaultAdmin');
const { admin, firebaseInitialized, getFirebaseStatus } = require('../config/firebase');
const { sendPasswordResetEmail } = require('../utils/passwordReset');
const { isMailgunConfigured } = require('../utils/mailgun');
const { syncDefaultAdminToFirebase } = require('../utils/adminBootstrap');
const { sanitizeUserForApi } = require('../utils/sanitizeUser');
const { requestUserHasAnyPermission, normalizePermissions } = require('../utils/permissions');
const {
  shouldCheckRevoked,
  buildSessionUserFromAuth,
  summarizeLoginTimings,
} = require('../utils/loginPath');

function normalizeIdToken(raw) {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  if (!token || token === 'null' || token === 'undefined') return null;
  // Firebase ID tokens are standard JWTs (header.payload.signature)
  if (token.split('.').length !== 3) return null;
  return token;
}

// Issue an app JWT for a verified user record (used by both login flows)
function issueAppToken(user) {
  const permissions = normalizePermissions(user.role, user.permissions || {});
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions,
      firebaseUid: user.firebaseUid || user.firebase_uid || null,
      warehouseId: user.warehouseId || user.warehouse_id || user.warehouse || null,
      tokenVersion: currentTokenVersion(user),
    },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

/**
 * Build the in-memory session user immediately, then persist profile updates
 * after the login response is sent. Waiting on dual DB writes was a major
 * contributor to slow /firebase-login latency.
 */
function syncAuthenticatedProfile(user, decoded) {
  const sessionUser = buildSessionUserFromAuth(
    {
      ...user,
      permissions: normalizePermissions(user.role, user.permissions || {}),
    },
    decoded,
    now
  );

  const profilePatch = {
    firebaseUid: sessionUser.firebaseUid,
    lastLoginAt: sessionUser.lastLoginAt,
    email: sessionUser.email,
    name: sessionUser.name,
    role: sessionUser.role,
    permissions: sessionUser.permissions,
    warehouseId: sessionUser.warehouseId,
    isActive: sessionUser.isActive !== false,
    updatedAt: sessionUser.updatedAt,
  };

  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        try {
          await firestoreHelpers.setDocument('users', user.id, profilePatch);
        } catch (error) {
          console.error('[Auth] User document sync failed (non-fatal):', error.message);
        }
        if (pgEnabled()) {
          try {
            await pgHelpers.upsertUserProfile(sessionUser);
          } catch (error) {
            console.error('[Auth] User profile sync failed (non-fatal):', error.message);
          }
        }
      })
      .catch((error) => {
        console.error('[Auth] Background profile sync failed (non-fatal):', error.message);
      });
  });

  return sessionUser;
}

async function loadDefaultAdminUser(decoded = null) {
  const firebaseUid = decoded?.uid || null;
  const name = decoded?.name || null;

  try {
    // Fast path: single document read. Avoid Firebase getUser + full collection scans on login.
    return await loadDefaultAdminForSession({ name, firebaseUid });
  } catch (error) {
    console.error('[Auth] loadDefaultAdminForSession failed, using env defaults:', error.message);
    return {
      id: DEFAULT_USER.id,
      email: normalizeEmail(DEFAULT_USER.email),
      name: name || DEFAULT_USER.name,
      role: 'admin',
      permissions: { ...DEFAULT_PERMISSIONS },
      firebaseUid,
      isActive: true,
      isDefault: true,
    };
  }
}

function loginResponse(sessionUser) {
  const safe = sanitizeUserForApi(sessionUser);
  const permissions = normalizePermissions(safe.role, safe.permissions || {});
  return {
    token: issueAppToken({ ...sessionUser, permissions }),
    user: {
      id: safe.id,
      email: safe.email,
      name: safe.name,
      role: safe.role,
      permissions,
      firebaseUid: safe.firebaseUid || null,
      warehouseId: safe.warehouseId || null,
    }
  };
}

function completeFirebaseLogin(sessionUser, email, via) {
  // Audit logging must not block the login response.
  setImmediate(() => {
    addAuditLog('login', 'user', sessionUser.id, sessionUser.id, { email, via }).catch((auditError) => {
      console.warn('[Auth] Login audit log failed (non-fatal):', auditError.message);
    });
  });
  return loginResponse(sessionUser);
}

/**
 * GET /api/auth/status
 * Public diagnostics — confirms whether secure sign-in is configured (no secrets exposed).
 */
router.get('/status', async (req, res) => {
  const fbStatus = getFirebaseStatus();
  let adminInFirebase = false;
  if (fbStatus.initialized && admin?.auth) {
    try {
      await admin.auth().getUserByEmail(normalizeEmail(DEFAULT_USER.email));
      adminInFirebase = true;
    } catch (_) {}
  }
  // Public response intentionally omits the admin login email (credential phishing aid).
  res.json({
    secureSignInConfigured: Boolean(fbStatus.initialized && fbStatus.authAvailable),
    adminInFirebase,
    passwordSource: 'firebase_auth',
    emailConfigured: isMailgunConfigured(),
    supportedProviders: ['password', 'google.com', 'microsoft.com'],
    hints: [
      !fbStatus.initialized
        ? 'Secure sign-in service is not configured on the server.'
        : null,
      !adminInFirebase
        ? 'Create the bootstrap admin in Firebase Console → Authentication → Users, or set ADMIN_PASSWORD once for bootstrap.'
        : null,
    ].filter(Boolean),
  });
});

/**
 * POST /api/auth/resync-admin
 * Re-sync default admin password into Firebase Auth after ADMIN_PASSWORD changes.
 * Requires header X-Bootstrap-Secret matching BOOTSTRAP_SECRET env var.
 */
router.post('/resync-admin', async (req, res) => {
  try {
    const expected = process.env.BOOTSTRAP_SECRET;
    const provided = req.headers['x-bootstrap-secret'];
    if (!expected || provided !== expected) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const result = await syncDefaultAdminToFirebase();
    if (!result.synced) {
      return res.status(503).json({
        ok: false,
        error: 'Admin secure-access sync failed.',
        reason: result.reason,
        email: result.email || normalizeEmail(DEFAULT_USER.email),
      });
    }

    res.json({
      ok: true,
      email: result.email,
      uid: result.uid,
      created: result.created,
      message: 'Default admin password synced to secure sign-in. Try logging in again.',
    });
  } catch (error) {
    console.error('[resync-admin]', error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Admin resync failed.'
      : error.message;
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/auth/firebase-login
 * Verifies a Firebase ID token, finds/creates the matching app user, returns app JWT.
 * Body: { idToken }
 *
 * This is the PRIMARY login path. The frontend signs in with Firebase Auth
 * (which sends emails via Firebase's verified noreply@youthnic.shop), gets an
 * ID token, and exchanges it for an app JWT here.
 */
router.post('/firebase-login', async (req, res) => {
  const timings = {};
  const mark = (label) => {
    const previous = mark._last || Date.now();
    const nowMs = Date.now();
    timings[label] = nowMs - previous;
    mark._last = nowMs;
  };
  mark._last = Date.now();

  try {
    if (!firebaseInitialized || !admin?.auth) {
      return res.status(503).json({
        error: 'Secure access is not configured on the server.',
        legacyLoginAvailable: true,
      });
    }
    const { idToken: rawToken } = req.body;
    const idToken = normalizeIdToken(rawToken);
    if (!idToken) {
      return res.status(400).json({ error: 'A valid Firebase ID token is required.' });
    }

    // Signature/issuer/expiry verification is always required.
    // Revocation checks hit Google Identity Toolkit over the network and are opt-in
    // via AUTH_CHECK_REVOKED=true (account deactivation is still enforced from our DB).
    const checkRevoked = shouldCheckRevoked();
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken, checkRevoked);
      mark('verifyIdTokenMs');
    } catch (err) {
      console.error('[Auth] Token verification failed:', err.message);
      return res.status(401).json({ error: 'Invalid or expired secure sign-in token.' });
    }

    const email = normalizeEmail(decoded.email);
    if (!email) return res.status(400).json({ error: 'Secure sign-in token has no email.' });

    const signInProvider = decoded.firebase?.sign_in_provider || 'password';

    // Match the default admin first (preserves their permissions/role)
    if (email === normalizeEmail(DEFAULT_USER.email)) {
      const adminUser = await loadDefaultAdminUser(decoded);
      mark('userLookupMs');
      const sessionUser = syncAuthenticatedProfile(adminUser, decoded);
      const payload = completeFirebaseLogin(sessionUser, email, signInProvider);
      mark('issueTokenMs');
      const summary = summarizeLoginTimings(timings);
      console.log('[firebase-login] timings', { email, checkRevoked, ...summary });
      res.setHeader('Server-Timing', `total;dur=${summary.totalMs}`);
      if (process.env.NODE_ENV === 'development') {
        return res.json({ ...payload, _timings: summary });
      }
      return res.json(payload);
    }

    // Find matching app user by email
    let user = null;
    try {
      const matches = await firestoreHelpers.queryCollection('users', 'email', '==', email);
      user = matches[0] || null;
      mark('userLookupMs');
    } catch (dbError) {
      console.error('[Auth] User lookup failed:', dbError.message);
      return res.status(503).json({ error: 'Account service is temporarily unavailable. Please try again.' });
    }
    if (!user) {
      return res.status(403).json({ error: 'No app account exists for this email. Ask your admin to add you.' });
    }
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account is deactivated.' });
    }

    const sessionUser = syncAuthenticatedProfile(user, decoded);
    const payload = completeFirebaseLogin(sessionUser, email, signInProvider);
    mark('issueTokenMs');
    const summary = summarizeLoginTimings(timings);
    console.log('[firebase-login] timings', { email, checkRevoked, ...summary });
    res.setHeader('Server-Timing', `total;dur=${summary.totalMs}`);
    if (process.env.NODE_ENV === 'development') {
      return res.json({ ...payload, _timings: summary });
    }
    res.json(payload);
  } catch (error) {
    console.error('[firebase-login]', error);
    const message = process.env.NODE_ENV === 'production'
      ? 'Sign-in could not be completed. Please try again or contact your administrator.'
      : error.message;
    res.status(500).json({ error: message });
  }
});

router.get('/realtime-token', authenticateToken, async (req, res) => {
  try {
    const allowed = await requestUserHasAnyPermission(req, ['consignments', 'packing']);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to subscribe to live sync.' });
    }

    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      // Public Broadcast mode does not need a signed Realtime JWT.
      return res.json({
        token: null,
        mode: 'public_broadcast',
        expiresIn: 0,
        note: 'Live sync uses public Realtime Broadcast; JWT secret not required.',
      });
    }

    const supabaseToken = jwt.sign(
      {
        aud: 'authenticated',
        role: 'authenticated',
        sub: String(req.user.firebaseUid || req.user.id),
        firebase_uid: req.user.firebaseUid || null,
        app_user_id: req.user.id,
        email: req.user.email,
        app_role: req.user.role,
        warehouse_id: req.user.warehouseId || null,
        app_permissions: {
          consignments: req.user.permissions?.consignments === true || req.user.role === 'admin',
          packing: req.user.permissions?.packing === true || req.user.role === 'admin',
        },
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    res.json({ token: supabaseToken, expiresIn: 3600 });
  } catch (error) {
    console.error('[realtime-token]', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await addAuditLog('logout', 'user', req.user.id, req.user.id, {
      email: req.user.email,
      via: 'app',
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('[logout]', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/forgot-password
 * Public. Sends branded password reset email via Mailgun (Firebase generates the link).
 * Body: { email }
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'email is required.' });

    if (!firebaseInitialized || !admin?.auth) {
      return res.status(503).json({
        error: 'Secure access is not configured on the server.',
        hint: 'Contact your administrator to finish secure access setup.',
      });
    }

    // Verify user exists in Firebase before sending (avoid email enumeration in response)
    try {
      await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e?.code === 'auth/user-not-found') {
        // Generic success message — don't reveal whether email exists
        return res.json({ ok: true, message: 'If an account exists, a reset email has been sent.' });
      }
      throw e;
    }

    const appOrigin = req.body?.appOrigin || req.get('origin') || null;
    const result = await sendPasswordResetEmail(email, appOrigin);

    if (!result.sent) {
      return res.status(503).json({
        ok: false,
        sent: false,
        emailConfigured: isMailgunConfigured(),
        error: isMailgunConfigured()
          ? 'Password reset email could not be sent. Please try again shortly.'
          : 'Password reset email is not configured. Contact your administrator.',
        ...(process.env.NODE_ENV === 'development' && result.resetUrl ? { devResetUrl: result.resetUrl } : {}),
      });
    }

    res.json({
      ok: true,
      sent: true,
      emailConfigured: true,
      message: 'Password reset email sent. Check your inbox and spam folder.',
    });
  } catch (error) {
    console.error('[forgot-password]', error);
    const message = /unauthorized-continue-uri/i.test(error.message)
      ? 'Password reset is temporarily unavailable. Please contact your administrator.'
      : (process.env.NODE_ENV === 'production'
        ? 'Password reset could not be sent. Please try again shortly.'
        : error.message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/auth/send-password-link
 * Admin-only. Generates a password-set link and emails it (welcome / resend invite).
 * Body: { email, name? }
 */
router.post('/send-password-link', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (!firebaseInitialized || !admin?.auth) {
      return res.status(503).json({ error: 'Secure access is not configured.' });
    }
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'email is required.' });

    const result = await sendPasswordResetEmail(email);
    console.log(`[Auth] Password set link emailed for ${email}`);
    res.json({
      ok: true,
      sent: result.sent,
      emailConfigured: isMailgunConfigured(),
      ...(process.env.NODE_ENV === 'development' && result.resetUrl && !result.sent ? { devResetUrl: result.resetUrl } : {}),
    });
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'No secure access account with that email.' });
    }
    console.error('[send-password-link]', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current user from token — must use authenticateToken so deactivated /
// revoked (tokenVersion) sessions cannot keep reading profile/permissions.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const decoded = req.user;
    if (decoded.id === DEFAULT_USER.id) {
      const adminUser = await loadDefaultAdminForSession();
      const permissions = normalizePermissions('admin', adminUser.permissions || DEFAULT_PERMISSIONS);
      return res.json({
        user: sanitizeUserForApi({
          ...decoded,
          email: adminUser.email,
          name: adminUser.name,
          role: 'admin',
          permissions,
        }),
      });
    }
    const dbUser = await firestoreHelpers.getDocument('users', decoded.id);
    if (dbUser) {
      const role = dbUser.role || decoded.role;
      const permissions = normalizePermissions(role, dbUser.permissions || decoded.permissions || {});
      // Heal legacy org-head rows that still store packer/admin module grants.
      if (role === 'organization_head' && JSON.stringify(dbUser.permissions || {}) !== JSON.stringify(permissions)) {
        setImmediate(() => {
          firestoreHelpers.setDocument('users', dbUser.id || decoded.id, {
            permissions,
            updatedAt: now(),
          }).catch(() => {});
        });
      }
      return res.json({
        user: sanitizeUserForApi({
          ...decoded,
          role,
          permissions,
          firebaseUid: dbUser.firebaseUid || decoded.firebaseUid || null,
          warehouseId: dbUser.warehouseId || dbUser.warehouse_id || dbUser.warehouse || decoded.warehouseId || null,
        }),
      });
    }
    const role = decoded.role;
    res.json({
      user: sanitizeUserForApi({
        ...decoded,
        permissions: normalizePermissions(role, decoded.permissions || {}),
      }),
    });
  } catch (error) {
    console.error('[auth/me]', error.message);
    res.status(500).json({ error: 'Could not load profile.' });
  }
});

module.exports = router;
