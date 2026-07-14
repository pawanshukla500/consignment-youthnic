const { DEFAULT_USER } = require('../middleware/auth');
const { ensureDefaultAdminUser, normalizeEmail, DEFAULT_PERMISSIONS } = require('./defaultAdmin');
const firebaseAuth = require('./firebaseAuthMirror');
const { admin, firebaseInitialized } = require('../config/firebase');

function getBootstrapPassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv);
  return null;
}

/**
 * Ensure the default admin exists in Firebase Auth.
 * Firebase is the source of truth — never overwrite an existing user's password on startup.
 * ADMIN_PASSWORD is only used when creating the account for the first time.
 */
async function ensureDefaultAdminInFirebase() {
  if (!firebaseAuth.isEnabled()) {
    return { synced: false, reason: 'firebase_not_configured' };
  }

  const email = normalizeEmail(DEFAULT_USER.email);
  const auth = admin.auth();
  let fbUser = null;

  try {
    fbUser = await auth.getUserByEmail(email);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      console.error('[Auth] Firebase admin lookup failed:', error.message);
      return { synced: false, reason: 'firebase_lookup_failed', email };
    }
  }

  if (fbUser) {
    const result = await firebaseAuth.syncUser({
      id: DEFAULT_USER.id,
      email,
      name: fbUser.displayName || DEFAULT_USER.name,
      photoURL: fbUser.photoURL || null,
      disabled: fbUser.disabled,
      // Never pass password — preserve whatever is set in Firebase Console / reset flow
    });

    return {
      synced: Boolean(result),
      email,
      uid: result?.uid || fbUser.uid,
      created: false,
      source: 'firebase',
      displayName: fbUser.displayName || DEFAULT_USER.name,
    };
  }

  const bootstrapPassword = getBootstrapPassword();
  if (!bootstrapPassword) {
    const message =
      '[Auth] Admin user missing in Firebase and ADMIN_PASSWORD is not set. ' +
      'Create the user in Firebase Console, or set ADMIN_PASSWORD for one-time bootstrap.';
    if (process.env.NODE_ENV === 'production') {
      console.error(message);
      return { synced: false, reason: 'admin_missing_no_bootstrap_password', email, fatal: true };
    }
    console.warn(message);
    return { synced: false, reason: 'admin_missing_no_bootstrap_password', email };
  }

  const result = await firebaseAuth.syncUser({
    id: DEFAULT_USER.id,
    email,
    name: DEFAULT_USER.name,
    password: bootstrapPassword,
    disabled: false,
  });

  if (!result) {
    return { synced: false, reason: 'firebase_create_failed', email };
  }

  console.log('[Auth] Created default admin in Firebase Auth:', email);
  return {
    synced: true,
    email,
    uid: result.uid,
    created: true,
    source: 'bootstrap',
  };
}

/**
 * Push ADMIN_PASSWORD into Firebase only when explicitly requested (resync endpoint / script).
 */
async function syncDefaultAdminToFirebase(adminUser = null) {
  if (!firebaseAuth.isEnabled()) {
    return { synced: false, reason: 'firebase_not_configured' };
  }

  const password = getBootstrapPassword();
  if (!password) {
    return { synced: false, reason: 'no_bootstrap_password', email: normalizeEmail(DEFAULT_USER.email) };
  }

  const user = adminUser || {
    id: DEFAULT_USER.id,
    email: normalizeEmail(DEFAULT_USER.email),
    name: DEFAULT_USER.name,
  };

  const result = await firebaseAuth.syncUser({
    id: user.id,
    email: user.email,
    name: user.name,
    password,
    disabled: false,
  });

  if (!result) {
    return {
      synced: false,
      reason: 'firebase_sync_failed',
      email: user.email,
    };
  }

  return {
    synced: true,
    email: user.email,
    uid: result.uid,
    created: Boolean(result.created),
    passwordUpdated: true,
  };
}

/**
 * Ensure admin exists in app datastore and Firebase Auth (profile only on existing accounts).
 */
async function bootstrapDefaultAdmin() {
  const firebaseResult = await ensureDefaultAdminInFirebase();

  let adminUser = null;
  let dbError = null;

  try {
    adminUser = await ensureDefaultAdminUser({
      name: firebaseResult.displayName || DEFAULT_USER.name,
      firebaseUid: firebaseResult.uid || null,
    });
  } catch (error) {
    dbError = error;
    console.error('[Auth] Default admin database bootstrap failed:', error.message);
    adminUser = {
      id: DEFAULT_USER.id,
      email: normalizeEmail(DEFAULT_USER.email),
      name: firebaseResult.displayName || DEFAULT_USER.name,
      role: 'admin',
      permissions: DEFAULT_PERMISSIONS,
      firebaseUid: firebaseResult.uid || null,
      isActive: true,
      isDefault: true,
    };
  }

  return {
    adminUser,
    dbError,
    firebase: firebaseResult,
  };
}

module.exports = {
  bootstrapDefaultAdmin,
  ensureDefaultAdminInFirebase,
  getBootstrapPassword,
  syncDefaultAdminToFirebase,
};
