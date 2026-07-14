const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { authenticateToken, requireRole, DEFAULT_USER, JWT_SECRET, currentTokenVersion } = require('../middleware/auth');
const { generateId, now, firestoreHelpers, addAuditLog } = require('../utils/helpers');
const { DEFAULT_PERMISSIONS, ensureDefaultAdminUser, normalizeEmail } = require('../utils/defaultAdmin');
const firebaseAuth = require('../utils/firebaseAuthMirror');
const { getFirebaseStatus, admin } = require('../config/firebase');
const { pgEnabled } = require('../config/database');
const pgHelpers = require('../utils/pgHelpers');
const { normalizePermissions, diffPermissions } = require('../utils/permissions');
const { sanitizeUserForStorage, sanitizeUserForApi } = require('../utils/sanitizeUser');
const { sendPasswordResetEmail } = require('../utils/passwordReset');

function cleanProfileUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeUser(user = {}, authRecord = null) {
  return sanitizeUserForApi(user, {
    avatarUrl: user.avatarUrl || user.photoURL || user.photoUrl || authRecord?.photoURL || '',
    emailVerified: Boolean(authRecord?.emailVerified),
    lastLoginAt: user.lastLoginAt || user.last_login_at || null,
    lastSignInAt: authRecord?.metadata?.lastSignInTime || user.lastLoginAt || null,
    createdAt: user.createdAt || authRecord?.metadata?.creationTime || null,
    preferences: {
      theme: 'light',
      notifications: true,
      language: 'en',
      ...(user.preferences || {})
    }
  });
}

function mergeJwtUserContext(document, reqUser) {
  if (!document && !reqUser) return null;
  return {
    ...(document || {}),
    id: document?.id || reqUser?.id,
    email: document?.email || reqUser?.email || '',
    name: document?.name || reqUser?.name || '',
    role: document?.role || reqUser?.role || 'user',
    permissions: document?.permissions || reqUser?.permissions || {},
    firebaseUid: document?.firebaseUid || document?.firebase_uid || reqUser?.firebaseUid || null,
    warehouseId: document?.warehouseId || document?.warehouse_id || reqUser?.warehouseId || null,
  };
}

async function getCurrentUserDocument(reqUser) {
  if (!reqUser?.id) return null;

  if (reqUser.id === DEFAULT_USER.id) {
    return mergeJwtUserContext(await ensureDefaultAdminUser(), reqUser);
  }

  let existing = await firestoreHelpers.getDocument('users', reqUser.id);
  if (!existing && pgEnabled()) {
    existing = await pgHelpers.getUserProfileById(reqUser.id);
  }

  if (existing) {
    return mergeJwtUserContext(existing, reqUser);
  }

  const email = normalizeEmail(reqUser.email);
  if (email) {
    const matches = await firestoreHelpers.queryCollection('users', 'email', '==', email);
    const matched = matches.find((user) => user && user.id);
    if (matched) {
      return mergeJwtUserContext(matched, reqUser);
    }

    if (pgEnabled()) {
      const pgUser = await pgHelpers.getUserProfileByEmail(email);
      if (pgUser) {
        return mergeJwtUserContext(pgUser, reqUser);
      }
    }
  }

  return mergeJwtUserContext(null, reqUser);
}

async function persistUserProfile(user) {
  const safe = sanitizeUserForStorage(user);
  await firestoreHelpers.setDocument('users', safe.id, safe);
  if (pgEnabled()) {
    await pgHelpers.upsertUserProfile(safe);
  }
}

/**
 * Verify current password for self-service change.
 * Prefer Firebase Identity Toolkit when FIREBASE_WEB_API_KEY is set;
 * otherwise fall back to a one-shot legacy bcrypt compare only if a hash
 * is still present (pre-migration). Never re-persist the hash.
 */
async function verifyCurrentPassword(user, currentPassword) {
  if (!currentPassword) return false;

  const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
  if (apiKey && user.email) {
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: user.email,
            password: currentPassword,
            returnSecureToken: false,
          }),
        }
      );
      return response.ok;
    } catch (error) {
      console.error('[users] Firebase password verify failed:', error.message);
      return false;
    }
  }

  if (user.password) {
    return bcrypt.compare(currentPassword, user.password);
  }

  return false;
}

async function getAuthRecordForUser(user) {
  return firebaseAuth.getUser(user.firebaseUid || user.firebase_uid || user.email);
}

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await getCurrentUserDocument(req.user);
    if (!user?.id || !user?.email) {
      return res.status(404).json({ error: 'User profile not found.' });
    }
    const authRecord = await getAuthRecordForUser(user);
    res.json({ user: safeUser(user, authRecord) });
  } catch (error) {
    console.error('[users/me]', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/me', authenticateToken, async (req, res) => {
  try {
    const user = await getCurrentUserDocument(req.user);
    if (!user?.id) return res.status(404).json({ error: 'User profile not found.' });
    if (user.isActive === false) return res.status(403).json({ error: 'Account is deactivated.' });

    const name = String(req.body?.name || '').trim();
    if (!name || name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'Display name must be between 2 and 80 characters.' });
    }

    const avatarUrl = cleanProfileUrl(req.body?.avatarUrl);
    if (avatarUrl === null) {
      return res.status(400).json({ error: 'Profile picture must be a valid HTTPS image URL.' });
    }

    const preferences = req.body?.preferences || {};
    const cleanedPreferences = {
      theme: ['light', 'system'].includes(preferences.theme) ? preferences.theme : 'light',
      notifications: preferences.notifications !== false,
      language: ['en', 'hi'].includes(preferences.language) ? preferences.language : 'en',
    };

    const updated = {
      ...user,
      name,
      avatarUrl,
      photoURL: avatarUrl,
      preferences: cleanedPreferences,
      updatedAt: now(),
      updatedBy: req.user.id,
    };

    await persistUserProfile(updated);
    await firebaseAuth.updateProfile(updated.firebaseUid || updated.firebase_uid || updated.email, { name, photoURL: avatarUrl });
    await addAuditLog('update_profile', 'user', updated.id, req.user.id, { self: true });

    const authRecord = await getAuthRecordForUser(updated);
    res.json({ user: safeUser(updated, authRecord) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/logout-all', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const user = id === DEFAULT_USER.id
      ? await ensureDefaultAdminUser()
      : await firestoreHelpers.getDocument('users', id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const revoked = await firebaseAuth.revokeSessions(user.firebaseUid || user.firebase_uid || user.email);
    const nextVersion = currentTokenVersion(user) + 1;
    await firestoreHelpers.setDocument('users', id, {
      ...user,
      tokenVersion: nextVersion,
      updatedAt: now(),
    });
    await addAuditLog('logout_all_devices', 'user', id, req.user.id, { self: req.user.id === id, revoked, tokenVersion: nextVersion });
    res.json({ ok: true, revoked, tokenVersion: nextVersion });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users (admin only)
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const pageSize = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || ((page - 1) * pageSize), 0);
    await ensureDefaultAdminUser();
    let users = await firestoreHelpers.getCollection('users');
    // Always include default admin
    const hasDefault = users.some(u => u.id === DEFAULT_USER.id || normalizeEmail(u.email) === normalizeEmail(DEFAULT_USER.email));
    if (!hasDefault) {
      users.unshift({
        id: DEFAULT_USER.id,
        email: normalizeEmail(DEFAULT_USER.email),
        name: DEFAULT_USER.name,
        role: DEFAULT_USER.role,
        permissions: { ...DEFAULT_PERMISSIONS },
        isDefault: true,
        createdAt: DEFAULT_USER.createdAt
      });
    }
    users = users
      .map((u) => safeUser(u))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    const total = users.length;
    const paged = users.slice(offset, offset + pageSize);
    res.json({ users: paged, count: paged.length, total, page, pageSize, hasMore: offset + paged.length < total });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create user (admin only)
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { name, email, password, role = 'user', permissions = {} } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    await ensureDefaultAdminUser();
    const normalizedEmail = normalizeEmail(email);
    const existing = await firestoreHelpers.getCollection('users');
    if (existing.some(u => normalizeEmail(u.email) === normalizedEmail)) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    const id = generateId();
    // Plain password is used only to create the Firebase Auth account — never stored in documents.
    const userData = sanitizeUserForStorage({
      id,
      name,
      email: normalizedEmail,
      role,
      isActive: true,
      permissions: normalizePermissions(role, permissions),
      createdAt: now(),
      updatedAt: now(),
      createdBy: req.user.id
    });

    await firestoreHelpers.setDocument('users', id, userData);
    if (pgEnabled()) {
      await pgHelpers.upsertUserProfile(userData);
    }
    await addAuditLog('create', 'user', id, req.user.id, {
      name,
      email: normalizedEmail,
      role,
      permissions: userData.permissions,
    });

    // Mirror into secure access for login.
    // The user can sign in to the frontend with this email + password through secure access.
    try {
      const synced = await firebaseAuth.syncUser({ id, email: normalizedEmail, name, password, disabled: false });
      if (synced?.created) console.log(`[SecureAccess] Created uid=${synced.uid} for ${normalizedEmail}`);
      if (synced?.uid) {
        await firestoreHelpers.setDocument('users', id, { firebaseUid: synced.uid, updatedAt: now() });
      }
    } catch (e) { console.warn('[Users] Secure access sync failed:', e.message); }

    // Generate + email a password-setup link (never email the temporary password).
    let inviteSent = false;
    try {
      const invite = await sendPasswordResetEmail(normalizedEmail);
      inviteSent = Boolean(invite?.sent);
      if (inviteSent) {
        console.log(`[SecureAccess] Invite email sent for ${normalizedEmail}`);
      } else {
        console.warn(`[SecureAccess] Invite email not sent for ${normalizedEmail} (Mailgun/Firebase unavailable)`);
      }
    } catch (e) {
      console.warn('[Users] Invite email failed:', e.message);
    }

    res.status(201).json({ user: safeUser(userData), inviteSent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user (admin only)
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, permissions, password, isActive } = req.body;

    if (id === DEFAULT_USER.id && req.user.id !== DEFAULT_USER.id) {
      return res.status(403).json({ error: 'Cannot modify default admin.' });
    }

    const existing = await firestoreHelpers.getDocument('users', id);
    if (!existing) return res.status(404).json({ error: 'User not found.' });

    const updateData = { updatedAt: now() };
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = normalizeEmail(email);
    if (role !== undefined) updateData.role = role;
    if (permissions !== undefined || role !== undefined) {
      updateData.permissions = normalizePermissions(role || existing.role, {
        ...(existing.permissions || {}),
        ...(permissions || {}),
      });
    }
    if (isActive !== undefined) updateData.isActive = isActive;
    // Password updates go to Firebase Auth only — never into documents.
    const permissionChanges = permissions !== undefined
      ? diffPermissions(existing.permissions || {}, normalizePermissions(role || existing.role, {
        ...(existing.permissions || {}),
        ...(permissions || {}),
      }))
      : {};
    const shouldBumpToken =
      (isActive !== undefined && Boolean(isActive) !== Boolean(existing.isActive !== false))
      || (role !== undefined && role !== existing.role)
      || Object.keys(permissionChanges).length > 0;
    if (shouldBumpToken) {
      updateData.tokenVersion = currentTokenVersion(existing) + 1;
    }

    const updated = sanitizeUserForStorage({ ...existing, ...updateData });
    await firestoreHelpers.setDocument('users', id, updated);
    if (pgEnabled()) {
      await pgHelpers.upsertUserProfile(updated);
    }
    await addAuditLog('update', 'user', id, req.user.id, { name: updated.name, email: updated.email, role: updated.role });
    if (Object.keys(permissionChanges).length) {
      await addAuditLog('permission_change', 'user', id, req.user.id, { permissionChanges });
    }

    // Mirror changes into secure access (fire-and-forget)
    if (updated.email) {
      firebaseAuth.syncUser({
        id: updated.id, email: updated.email, name: updated.name,
        password: password || undefined,
        disabled: updated.isActive === false
      });
    }

    res.json({ user: safeUser(updated) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user (admin only)
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (id === DEFAULT_USER.id) {
      return res.status(403).json({ error: 'Cannot delete default admin.' });
    }
    // Get email before deleting so we can also clean up secure access
    const existing = await firestoreHelpers.getDocument('users', id);
    await firestoreHelpers.deleteDocument('users', id);
    await addAuditLog('delete', 'user', id, req.user.id, {});

    // Mirror deletion to secure access
    if (existing?.email) firebaseAuth.deleteUser(existing.email);

    res.json({ message: 'User deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password (self or admin)
router.post('/:id/change-password', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required.' });
    }

    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const user = id === DEFAULT_USER.id
      ? await ensureDefaultAdminUser()
      : await firestoreHelpers.getDocument('users', id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account is deactivated.' });
    }

    // Verify current password (skip for admin changing others)
    if (req.user.role !== 'admin' || req.user.id === id) {
      const valid = await verifyCurrentPassword(user, currentPassword);
      if (!valid) {
        return res.status(401).json({
          error: 'Current password is incorrect.',
          hint: (!process.env.FIREBASE_WEB_API_KEY && !process.env.FIREBASE_API_KEY && !user.password)
            ? 'Set FIREBASE_WEB_API_KEY (same as the frontend Firebase web API key) to verify passwords, or use forgot-password.'
            : undefined,
        });
      }
    }

    // Update password in Firebase Auth only — never store hashes in documents.
    if (!user.email) {
      return res.status(400).json({ error: 'User email is required to change password.' });
    }
    const updatedInFirebase = await firebaseAuth.setPassword(user.email, newPassword);
    if (!updatedInFirebase) {
      return res.status(503).json({ error: 'Secure access is unavailable. Password was not changed.' });
    }

    // Ensure any leftover hash keys are stripped; bump tokenVersion so other sessions drop.
    const nextVersion = currentTokenVersion(user) + 1;
    await firestoreHelpers.setDocument('users', id, sanitizeUserForStorage({
      ...user,
      tokenVersion: nextVersion,
      updatedAt: now(),
    }));
    await addAuditLog('change_password', 'user', id, req.user.id, { self: req.user.id === id, tokenVersion: nextVersion });

    res.json({ message: 'Password changed successfully.', tokenVersion: nextVersion });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Secure access mirror admin tools (admin only) ──────────────────────────
// One-click sync: pushes every local user into secure access (idempotent)
router.post(['/sync-secure-access', '/sync-firebase-auth'], authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (!firebaseAuth.isEnabled()) {
      return res.status(503).json({ ok: false, error: 'Secure access service is not available' });
    }
    await ensureDefaultAdminUser();
    const users = await firestoreHelpers.getCollection('users');
    let synced = 0, created = 0, failed = 0;
    for (const u of users) {
      if (!u.email) continue;
      const isDefaultAdmin = u.id === DEFAULT_USER.id
        || normalizeEmail(u.email) === normalizeEmail(DEFAULT_USER.email);
      // Default admin gets the live ADMIN_PASSWORD; other users must reset via email.
      const r = await firebaseAuth.syncUser({
        id: u.id,
        email: u.email,
        name: u.name,
        password: isDefaultAdmin ? process.env.ADMIN_PASSWORD : undefined,
        disabled: u.isActive === false
      });
      if (r) { synced++; if (r.created) created++; } else failed++;
    }
    res.json({ ok: true, total: users.length, synced, created, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status check for the Settings page
router.get(['/secure-access-status', '/firebase-auth-status'], authenticateToken, requireRole('admin'), async (req, res) => {
  const status = getFirebaseStatus();
  let authReachable = false;
  let authError = null;

  if (status.authAvailable) {
    try {
      await admin.auth().listUsers(1);
      authReachable = true;
    } catch (e) {
      authError = process.env.NODE_ENV === 'production' ? 'Secure access check failed.' : e.message;
    }
  }

  res.json({
    enabled: status.initialized && authReachable,
    authReachable,
    setupRequired: !status.initialized || !authReachable,
    authError,
  });
});

module.exports = router;
