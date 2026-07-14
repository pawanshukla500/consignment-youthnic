/**
 * Internal smoke test - infrastructure + all API GET endpoints.
 * Run: node scripts/smoke-test.js
 * Requires backend running on PORT (default 5000).
 */
const requestedPort = process.env.PORT;
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
if (requestedPort) process.env.PORT = requestedPort;

const jwt = require('jsonwebtoken');
const { DEFAULT_USER, JWT_SECRET } = require('../middleware/auth');
const { ensureDefaultAdminUser } = require('../utils/defaultAdmin');

const BASE = `http://127.0.0.1:${process.env.PORT || 5000}`;

async function request(method, path, { token, body, expect } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    return { path, method, ok: false, status: 0, ms: Date.now() - start, error: e.message };
  }
  const ms = Date.now() - start;
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    try { data = await res.json(); } catch { data = null; }
  } else if (method === 'GET' && path.includes('templates')) {
    data = { type: 'file', size: (await res.text()).length };
  }

  const ok = expect ? expect(res.status, data) : res.status >= 200 && res.status < 300;
  return {
    path,
    method,
    ok,
    status: res.status,
    ms,
    error: ok ? null : (data?.error || res.statusText),
    sample: data && typeof data === 'object' ? summarize(data) : undefined,
  };
}

function summarize(data) {
  if (Array.isArray(data)) return `array[${data.length}]`;
  if (data.consignments) return `consignments:${data.consignments.length}`;
  if (data.files) return `files:${data.files.length}`;
  if (data.users) return `users:${data.users.length}`;
  if (data.settings) return 'settings';
  if (data.status === 'ok') return 'ok';
  if (data.postgres) return `pg:${data.postgres.connected ? 'connected' : 'down'}`;
  if (data.firebase) return `fb:auth=${data.firebase.authAdminAvailable}`;
  if (data.storage) return `storage:${data.storage.primary}`;
  const keys = Object.keys(data).slice(0, 4);
  return keys.join(',');
}

async function testInfrastructure() {
  const results = [];

  // Firebase SQL / Postgres
  try {
    const { pgEnabled, getPool } = require('../config/database');
    if (!pgEnabled()) {
      results.push({ service: 'Firebase SQL (Cloud SQL)', ok: false, detail: 'pgEnabled() is false - check SUPABASE_DB_URL' });
    } else {
      await getPool().query('SELECT 1');
      const count = await getPool().query('SELECT COUNT(*)::int n FROM documents');
      results.push({ service: 'Firebase SQL (Cloud SQL)', ok: true, detail: `${count.rows[0].n} document rows` });
    }
  } catch (e) {
    results.push({ service: 'Firebase SQL (Cloud SQL)', ok: false, detail: e.message });
  }

  // Firebase Admin (Auth only)
  try {
    const { firebaseInitialized, admin } = require('../config/firebase');
    let authOk = false;
    if (firebaseInitialized && admin?.auth) {
      await admin.auth().listUsers(1);
      authOk = true;
    }
    results.push({
      service: 'Firebase Auth Admin',
      ok: authOk,
      detail: authOk ? 'listUsers OK' : 'not configured',
    });
  } catch (e) {
    results.push({ service: 'Firebase Auth Admin', ok: false, detail: e.message });
  }

  // Cloudflare R2 object storage
  try {
    const { getR2Status } = require('../config/r2');
    const { checkStorageReachable } = require('../utils/storage');
    const r2 = getR2Status();
    const storage = r2.configured
      ? await checkStorageReachable()
      : { reachable: false, error: r2.setupHint || 'R2 not configured' };
    results.push({
      service: 'Cloudflare R2',
      ok: storage.reachable,
      detail: storage.reachable ? (r2.bucket || 'configured') : (storage.error || 'unreachable'),
    });
  } catch (e) {
    results.push({ service: 'Cloudflare R2', ok: false, detail: e.message });
  }

  // Mailgun
  const mailgunKey = process.env.MAILGUN_API_KEY || '';
  results.push({
    service: 'Mailgun Email',
    ok: mailgunKey && !mailgunKey.includes('your-mailgun'),
    detail: mailgunKey && !mailgunKey.includes('your-mailgun') ? 'API key set' : 'placeholder key - emails disabled',
  });

  return results;
}

async function main() {
  console.log('\n=== Consignment Packing App - Internal Smoke Test ===\n');

  console.log('--- Infrastructure ---');
  const infra = await testInfrastructure();
  infra.forEach((r) => {
    console.log(`  ${r.ok ? 'ok' : 'x'} ${r.service}: ${r.detail}`);
  });

  console.log('\n--- API Server ---');
  const health = await request('GET', '/api/health');
  if (!health.ok) {
    console.log(`  x Server not reachable at ${BASE}`);
    console.log(`    Start with: cd backend && node server.js`);
    console.log(`    Error: ${health.error}`);
    process.exit(1);
  }
  console.log(`  ok GET /api/health -> ${health.status} (${health.ms}ms)`);

  let token;
  if (process.env.ALLOW_LEGACY_PASSWORD_LOGIN === 'true') {
    const start = Date.now();
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL || DEFAULT_USER.email,
        password: process.env.ADMIN_PASSWORD || process.env.SMOKE_TEST_PASSWORD || null,
      }),
    });
    const loginData = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || !loginData.token) {
      console.log(`  x POST /api/auth/login failed: ${loginData.error || loginRes.statusText}`);
      process.exit(1);
    }
    token = loginData.token;
    console.log(`  ok POST /api/auth/login -> admin token (${Date.now() - start}ms)`);
  } else {
    const adminUser = await ensureDefaultAdminUser();
    token = jwt.sign({
      id: adminUser.id || DEFAULT_USER.id,
      email: adminUser.email || DEFAULT_USER.email,
      name: adminUser.name || DEFAULT_USER.name,
      role: adminUser.role || 'admin',
      permissions: adminUser.permissions || {},
    }, JWT_SECRET, { expiresIn: '10m' });
    console.log('  ok Internal smoke-test admin JWT created (legacy password login disabled)');
  }

  const endpoints = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/consignments?limit=5'],
    ['GET', '/api/marketplaces'],
    ['GET', '/api/users'],
    ['GET', '/api/docket-companies'],
    ['GET', '/api/productivity'],
    ['GET', '/api/productivity/planning'],
    ['GET', '/api/productivity/audit?limit=5'],
    ['GET', '/api/packing/resume-session'],
    ['GET', '/api/packing/productivity'],
    ['GET', '/api/audit-logs?limit=5'],
    ['GET', '/api/audit-logs/my-activity?limit=5'],
    ['GET', '/api/settings'],
    ['GET', '/api/settings/db-info'],
    ['GET', '/api/settings/system-health'],
    ['GET', '/api/email/resolve-address?name=Pawan%20Shukla'],
    ['GET', '/api/users/firebase-auth-status'],
    ['GET', '/api/templates/consignment'],
  ];

  console.log('\n--- Authenticated GET endpoints ---');
  let passed = 0;
  let failed = 0;
  let consignmentId = null;

  for (const [method, path] of endpoints) {
    const r = await request(method, path, { token });
    const mark = r.ok ? 'ok' : 'x';
    console.log(`  ${mark} ${method} ${path} -> ${r.status} (${r.ms}ms)${r.sample ? ` [${r.sample}]` : ''}${r.error ? ` - ${r.error}` : ''}`);
    if (r.ok) passed++; else failed++;
  }

  // Consignment detail + uploads if any exist
  const listRes = await fetch(`${BASE}/api/consignments?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  const listData = await listRes.json();
  consignmentId = listData.consignments?.[0]?.id;
  if (consignmentId) {
    for (const path of [`/api/consignments/${consignmentId}`, `/api/consignments/${consignmentId}/packing-report`, `/api/uploads/${consignmentId}`]) {
      const r = await request('GET', path, { token });
      const mark = r.ok ? 'ok' : 'x';
      console.log(`  ${mark} GET ${path} -> ${r.status} (${r.ms}ms)${r.sample ? ` [${r.sample}]` : ''}`);
      if (r.ok) passed++; else failed++;
    }
  } else {
    console.log('  - No consignments in DB - skipped detail/upload tests');
  }

  // Firebase login endpoint (expect 400 without token)
  const fbLogin = await request('POST', '/api/auth/firebase-login', {
    body: {},
    expect: (s) => s === 400,
  });
  console.log(`\n--- Auth edge cases ---`);
  console.log(`  ${fbLogin.ok ? 'ok' : 'x'} POST /api/auth/firebase-login (no token) -> ${fbLogin.status} (expects 400)`);

  console.log('\n=== Summary ===');
  console.log(`  Infrastructure: ${infra.filter((i) => i.ok).length}/${infra.length} connected`);
  console.log(`  API endpoints:  ${passed}/${passed + failed} passed`);
  const infraFail = infra.filter((i) => !i.ok);
  if (infraFail.length) {
    console.log('\n  Action required:');
    infraFail.forEach((i) => console.log(`    - ${i.service}: ${i.detail}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
