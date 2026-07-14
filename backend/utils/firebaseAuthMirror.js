/**
 * Firebase Auth mirror — keeps the app's users collection in sync with Firebase Authentication.
 *
 * Why mirror instead of replace?
 *   - The existing JWT login flow keeps working (no UI/breaking changes).
 *   - Admins can ALSO manage users in the Firebase Console (view, disable, password reset, MFA).
 *   - Future ability to switch to native Firebase login is trivial — accounts already exist.
 *
 * All operations are fire-and-forget: if Firebase Auth is down or not configured,
 * the local user operation still succeeds. Errors are logged, never thrown.
 */
const { admin, firebaseInitialized } = require('../config/firebase');

const enabled = () => firebaseInitialized && admin && admin.auth;

/**
 * Create OR update a Firebase Auth user. Idempotent — safe to call repeatedly.
 * Returns { uid } on success, null on failure (never throws).
 */
async function syncUser({ id, email, name, password, disabled = false, photoURL }) {
  if (!enabled() || !email) return null;
  try {
    const auth = admin.auth();
    let userRecord = null;
    try { userRecord = await auth.getUserByEmail(email); } catch (e) { /* not found */ }

    if (userRecord) {
      // Update existing
      const update = { displayName: name, disabled };
      if (password) update.password = password;
      if (photoURL !== undefined) update.photoURL = photoURL || null;
      await auth.updateUser(userRecord.uid, update);
      return { uid: userRecord.uid, created: false };
    }

    // Create new — uid mirrors our local id so we can map both ways
    const created = await auth.createUser({
      uid: id,
      email,
      displayName: name,
      password: password || undefined,
      photoURL: photoURL || undefined,
      disabled,
      emailVerified: false
    });
    return { uid: created.uid, created: true };
  } catch (e) {
    console.warn('[FirebaseAuth] syncUser failed:', e.message);
    return null;
  }
}

async function updateProfile(emailOrUid, { name, photoURL } = {}) {
  if (!enabled() || !emailOrUid) return null;
  try {
    const auth = admin.auth();
    let uid = emailOrUid;
    if (emailOrUid.includes('@')) {
      try { const u = await auth.getUserByEmail(emailOrUid); uid = u.uid; } catch { return null; }
    }
    const update = {};
    if (name !== undefined) update.displayName = name || null;
    if (photoURL !== undefined) update.photoURL = photoURL || null;
    if (!Object.keys(update).length) return null;
    return await auth.updateUser(uid, update);
  } catch (e) {
    console.warn('[SecureAccess] updateProfile failed:', e.message);
    return null;
  }
}

async function getUser(emailOrUid) {
  if (!enabled() || !emailOrUid) return null;
  try {
    const auth = admin.auth();
    return emailOrUid.includes('@')
      ? await auth.getUserByEmail(emailOrUid)
      : await auth.getUser(emailOrUid);
  } catch {
    return null;
  }
}

async function revokeSessions(emailOrUid) {
  if (!enabled() || !emailOrUid) return false;
  try {
    const auth = admin.auth();
    let uid = emailOrUid;
    if (emailOrUid.includes('@')) {
      const u = await auth.getUserByEmail(emailOrUid);
      uid = u.uid;
    }
    await auth.revokeRefreshTokens(uid);
    return true;
  } catch (e) {
    console.warn('[SecureAccess] revokeSessions failed:', e.message);
    return false;
  }
}

async function deleteUser(emailOrUid) {
  if (!enabled() || !emailOrUid) return false;
  try {
    const auth = admin.auth();
    let uid = emailOrUid;
    if (emailOrUid.includes('@')) {
      try { const u = await auth.getUserByEmail(emailOrUid); uid = u.uid; } catch { return false; }
    }
    await auth.deleteUser(uid);
    return true;
  } catch (e) {
    console.warn('[FirebaseAuth] deleteUser failed:', e.message);
    return false;
  }
}

async function setPassword(emailOrUid, newPassword) {
  if (!enabled() || !emailOrUid || !newPassword) return false;
  try {
    const auth = admin.auth();
    let uid = emailOrUid;
    if (emailOrUid.includes('@')) {
      try { const u = await auth.getUserByEmail(emailOrUid); uid = u.uid; } catch { return false; }
    }
    await auth.updateUser(uid, { password: newPassword });
    return true;
  } catch (e) {
    console.warn('[FirebaseAuth] setPassword failed:', e.message);
    return false;
  }
}

async function setDisabled(emailOrUid, disabled) {
  if (!enabled() || !emailOrUid) return false;
  try {
    const auth = admin.auth();
    let uid = emailOrUid;
    if (emailOrUid.includes('@')) {
      try { const u = await auth.getUserByEmail(emailOrUid); uid = u.uid; } catch { return false; }
    }
    await auth.updateUser(uid, { disabled });
    return true;
  } catch (e) {
    console.warn('[FirebaseAuth] setDisabled failed:', e.message);
    return false;
  }
}

module.exports = { syncUser, updateProfile, getUser, revokeSessions, deleteUser, setPassword, setDisabled, isEnabled: enabled };
