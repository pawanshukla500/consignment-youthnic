/**
 * Bootstrap default admin in Supabase + Firebase Auth.
 * Run: node scripts/bootstrap-auth.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const { DEFAULT_USER } = require('../middleware/auth');
const { bootstrapDefaultAdmin } = require('../utils/adminBootstrap');
const { getFirebaseStatus } = require('../config/firebase');
const { pgEnabled, getPool, initSchema } = require('../config/database');

async function main() {
  console.log('Firebase:', getFirebaseStatus());
  if (pgEnabled()) {
    await initSchema();
    try {
      await getPool().query('SELECT 1');
      console.log('[Postgres] Connected');
    } catch (e) {
      console.warn('[Postgres] Connection failed:', e.message);
    }
  }

  const { adminUser, dbError, firebase } = await bootstrapDefaultAdmin();
  if (dbError) {
    console.warn('[App] Database bootstrap failed:', dbError.message);
  }
  console.log('[App] Default admin in DB:', adminUser?.email || DEFAULT_USER.email, adminUser?.id || DEFAULT_USER.id);
  console.log('[Firebase] Admin sync:', firebase);

  console.log('Done. Admin email:', adminUser?.email || DEFAULT_USER.email);
  console.log('Password is managed in Firebase Authentication (Firebase Console or Forgot password).');
  console.log('To push ADMIN_PASSWORD to Firebase explicitly: POST /api/auth/resync-admin with BOOTSTRAP_SECRET');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
