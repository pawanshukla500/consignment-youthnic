/**
 * Measures login-adjacent backend stages without requiring a browser.
 * Uses a synthetic JWT path for /me + /realtime-token, and times DB helpers
 * that sit on the firebase-login critical path.
 *
 * Usage: node scripts/login-timing-probe.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const jwt = require('jsonwebtoken');
const { DEFAULT_USER, JWT_SECRET } = require('../middleware/auth');
const { ensureDefaultAdminUser, normalizeEmail } = require('../utils/defaultAdmin');
const { firestoreHelpers } = require('../utils/helpers');
const { pgEnabled, testConnection, getPool } = require('../config/database');
const pgHelpers = require('../utils/pgHelpers');
const { admin, firebaseInitialized } = require('../config/firebase');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}`;

async function time(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { label, ok: true, ms: Date.now() - started, result };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - started, error: error.message };
  }
}

async function request(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - started;
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, ms, data };
}

async function main() {
  console.log('\n=== Login Timing Probe ===\n');

  const stages = [];

  stages.push(await time('db.connection', () => testConnection()));
  if (pgEnabled()) {
    stages.push(await time('db.getDocument(users/default-admin)', () =>
      firestoreHelpers.getDocument('users', DEFAULT_USER.id)));
    stages.push(await time('db.getCollection(users) [legacy slow path]', () =>
      firestoreHelpers.getCollection('users')));
    stages.push(await time('db.ensureDefaultAdminUser', () => ensureDefaultAdminUser()));
    stages.push(await time('db.queryCollection(users by email)', () =>
      firestoreHelpers.queryCollection('users', 'email', '==', normalizeEmail(DEFAULT_USER.email))));
    if (pgHelpers.getUserProfileByEmail) {
      stages.push(await time('db.getUserProfileByEmail', () =>
        pgHelpers.getUserProfileByEmail(DEFAULT_USER.email)));
    }
  }

  if (firebaseInitialized && admin?.auth) {
    stages.push(await time('firebase.getUserByEmail', () =>
      admin.auth().getUserByEmail(normalizeEmail(DEFAULT_USER.email))));
  }

  const adminUser = await ensureDefaultAdminUser().catch(() => ({
    id: DEFAULT_USER.id,
    email: DEFAULT_USER.email,
    name: DEFAULT_USER.name,
    role: 'admin',
    permissions: {},
  }));

  const token = jwt.sign(
    {
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      role: 'admin',
      permissions: adminUser.permissions || {},
      tokenVersion: 1,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  stages.push(await time('api.GET /api/health', async () => request('GET', '/api/health')));
  stages.push(await time('api.GET /api/auth/me', async () => request('GET', '/api/auth/me', { token })));
  stages.push(await time('api.GET /api/auth/realtime-token', async () =>
    request('GET', '/api/auth/realtime-token', { token })));
  stages.push(await time('api.GET /api/productivity/dashboard-summary', async () =>
    request('GET', '/api/productivity/dashboard-summary', { token })));

  console.log('Stage timings:');
  for (const stage of stages) {
    const status = stage.ok ? 'OK' : 'FAIL';
    const extra = stage.error
      ? ` — ${stage.error}`
      : (stage.result && typeof stage.result === 'object' && stage.result.status
        ? ` — HTTP ${stage.result.status} (${stage.result.ms}ms network)`
        : (stage.result && stage.result.latencyMs != null
          ? ` — probe ${stage.result.latencyMs}ms`
          : ''));
    console.log(`  ${status.padEnd(4)} ${String(stage.ms).padStart(5)}ms  ${stage.label}${extra}`);
  }

  console.log('\nInterpretation:');
  console.log('  - db.getCollection(users) should be avoided on the login hot path.');
  console.log('  - /auth/me and /realtime-token should stay under a few hundred ms once DB is local/healthy.');
  console.log('  - dashboard-summary is post-login and should not block authentication.');

  try { await getPool()?.end(); } catch (_) {}
}

main().catch(async (error) => {
  console.error('FATAL:', error.message);
  try { await getPool()?.end(); } catch (_) {}
  process.exit(1);
});
