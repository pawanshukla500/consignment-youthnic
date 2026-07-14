/**
 * Quick API health and auth test — run with: node scripts/quick-api-test.js
 */
const http = require('http');

const BASE = 'http://localhost:5000';
const results = [];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body?._token) {
      opts.headers['Authorization'] = `Bearer ${body._token}`;
      delete body._token;
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body && Object.keys(body).length) req.write(JSON.stringify(body));
    req.end();
  });
}

function log(label, pass, detail = '') {
  const icon = pass ? '✅' : '❌';
  const msg = `${icon} ${label}${detail ? ' — ' + detail : ''}`;
  console.log(msg);
  results.push({ label, pass, detail });
}

async function run() {
  console.log('\n=== Consignment Packing API Test Suite ===\n');

  // 1. Health check
  try {
    const h = await request('GET', '/api/health');
    log('Health check', h.status === 200 && h.data.status === 'ok', `status=${h.data.status}`);
  } catch (e) {
    log('Health check', false, e.message);
  }

  // 2. Unauthenticated access should be denied
  try {
    const u = await request('GET', '/api/consignments');
    log('Unauth denied', u.status === 401, `status=${u.status}`);
  } catch (e) {
    log('Unauth denied', false, e.message);
  }

  // 3. Legacy login is disabled by default
  try {
    const l = await request('POST', '/api/auth/login', {
      email: 'returnorders@vbexports.co.in',
      password: process.env.ADMIN_PASSWORD || process.env.SMOKE_TEST_PASSWORD,
    });
    log('Legacy login disabled', l.status === 410, `status=${l.status} msg=${l.data?.error || ''}`);
  } catch (e) {
    log('Legacy login disabled', false, e.message);
  }

  // 4. Firebase login without token returns 400
  try {
    const fl = await request('POST', '/api/auth/firebase-login', {});
    log('Firebase login needs token', fl.status === 400, `status=${fl.status}`);
  } catch (e) {
    log('Firebase login needs token', false, e.message);
  }

  // 5. /api/auth/me without token
  try {
    const me = await request('GET', '/api/auth/me');
    log('Auth /me needs token', me.status === 401, `status=${me.status}`);
  } catch (e) {
    log('Auth /me needs token', false, e.message);
  }

  // 6. Generate a JWT directly for testing (bypass Firebase)
  let token = null;
  try {
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET required for API test');
    token = jwt.sign(
      {
        id: 'default-admin',
        email: 'returnorders@vbexports.co.in',
        name: 'Pawan Shukla',
        role: 'admin',
        permissions: {
          consignments: true, packing: true, productivity: true,
          marketplaces: true, users: true, auditLogs: true,
          deleteConsignments: true, deleteVideos: true,
        },
      },
      secret,
      { expiresIn: '1h' }
    );
    log('JWT generated', !!token, `length=${token.length}`);
  } catch (e) {
    log('JWT generated', false, e.message);
  }

  if (!token) {
    console.log('\n❌ Cannot continue without JWT\n');
    return;
  }

  // 7. Auth /me with token
  try {
    const me = await request('GET', '/api/auth/me', { _token: token });
    log('Auth /me valid', me.status === 200 && me.data?.user?.role === 'admin', `role=${me.data?.user?.role}`);
  } catch (e) {
    log('Auth /me valid', false, e.message);
  }

  // 8. GET consignments (paginated)
  try {
    const c = await request('GET', '/api/consignments?limit=5', { _token: token });
    log('List consignments', c.status === 200 && Array.isArray(c.data?.consignments),
      `count=${c.data?.count} total=${c.data?.total}`);
  } catch (e) {
    log('List consignments', false, e.message);
  }

  // 9. GET marketplaces
  try {
    const m = await request('GET', '/api/marketplaces', { _token: token });
    log('List marketplaces', m.status === 200, `count=${Array.isArray(m.data?.marketplaces) ? m.data.marketplaces.length : m.data?.length || '?'}`);
  } catch (e) {
    log('List marketplaces', false, e.message);
  }

  // 10. GET users
  try {
    const u = await request('GET', '/api/users', { _token: token });
    log('List users', u.status === 200, `count=${Array.isArray(u.data?.users) ? u.data.users.length : '?'}`);
  } catch (e) {
    log('List users', false, e.message);
  }

  // 11. GET audit logs
  try {
    const a = await request('GET', '/api/audit-logs', { _token: token });
    log('List audit logs', a.status === 200, `count=${a.data?.logs?.length || a.data?.length || '?'}`);
  } catch (e) {
    log('List audit logs', false, e.message);
  }

  // 12. GET docket companies
  try {
    const d = await request('GET', '/api/docket-companies', { _token: token });
    log('Docket companies', d.status === 200, `count=${Array.isArray(d.data) ? d.data.length : '?'}`);
  } catch (e) {
    log('Docket companies', false, e.message);
  }

  // 14. GET settings
  try {
    const s = await request('GET', '/api/settings', { _token: token });
    log('Settings', s.status === 200, `has data=${!!s.data}`);
  } catch (e) {
    log('Settings', false, e.message);
  }

  // 15. GET system health
  try {
    const sh = await request('GET', '/api/settings/system-health', { _token: token });
    log('System health', sh.status === 200,
      `pg=${sh.data?.postgres?.connected} firebase=${sh.data?.firebase?.initialized}`);
  } catch (e) {
    log('System health', false, e.message);
  }

  // 16. Packing resume session
  try {
    const ps = await request('GET', '/api/packing/resume-session', { _token: token });
    log('Packing resume', ps.status === 200, `available=${ps.data?.available}`);
  } catch (e) {
    log('Packing resume', false, e.message);
  }

  // 17. Packing productivity
  try {
    const pp = await request('GET', '/api/packing/productivity', { _token: token });
    log('Packing productivity', pp.status === 200,
      `boxes_today=${pp.data?.boxes_today} items_today=${pp.data?.items_today}`);
  } catch (e) {
    log('Packing productivity', false, e.message);
  }

  // 18. Sync changes
  try {
    const sc = await request('GET', '/api/sync/changes?since=2020-01-01T00:00:00Z', { _token: token });
    log('Sync changes', sc.status === 200 && sc.data?.serverTime, `changes=${sc.data?.changes?.length}`);
  } catch (e) {
    log('Sync changes', false, e.message);
  }

  // 19. Forgot password (generic response even for unknown emails)
  try {
    const fp = await request('POST', '/api/auth/forgot-password', { email: 'test@test.com' });
    log('Forgot password', fp.status === 200 && fp.data?.ok === true, `msg=${fp.data?.message || ''}`);
  } catch (e) {
    log('Forgot password', false, e.message);
  }

  // 20. Realtime token
  try {
    const rt = await request('GET', '/api/auth/realtime-token', { _token: token });
    const hasToken = rt.status === 200 && !!rt.data?.token;
    const noSecret = rt.status === 503;
    log('Realtime token', hasToken || noSecret,
      hasToken ? `expiresIn=${rt.data?.expiresIn}` : `status=${rt.status} (SUPABASE_JWT_SECRET not set)`);
  } catch (e) {
    log('Realtime token', false, e.message);
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${results.length} tests ===\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  ❌ ${r.label}: ${r.detail}`));
  }
}

run().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
