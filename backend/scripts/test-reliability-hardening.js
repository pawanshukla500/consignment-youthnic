/**
 * Tests for security / reliability hardening (auth, email, SSL, rate-limit wiring).
 * Run: node scripts/test-reliability-hardening.js
 */
require('./ensureTestEnv');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isLocalOrPrivateHost,
  shouldUseSsl,
  buildPoolConfig,
} = require('../utils/dbConnection');
const {
  validateMailgunConfig,
} = require('../utils/envValidation');
const emailRoute = require('../routes/email');
const { deriveBackupKey, encryptBuffer, decryptBuffer } = require('../utils/backupCrypto');

assert.strictEqual(isLocalOrPrivateHost('192.168.56.40'), true);
assert.strictEqual(isLocalOrPrivateHost('10.0.0.5'), true);
assert.strictEqual(isLocalOrPrivateHost('127.0.0.1'), true);
assert.strictEqual(isLocalOrPrivateHost('8.8.8.8'), false);

const prevSsl = process.env.DB_SSL;
const prevNode = process.env.NODE_ENV;
const prevReject = process.env.DB_SSL_REJECT_UNAUTHORIZED;
try {
  delete process.env.DB_SSL;
  delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
  process.env.NODE_ENV = 'production';
  assert.strictEqual(shouldUseSsl('postgresql://u:p@8.8.8.8:5432/db', '8.8.8.8'), true);
  assert.strictEqual(shouldUseSsl('postgresql://u:p@192.168.56.40:5432/db', '192.168.56.40'), false);
  process.env.DB_SSL = 'false';
  assert.strictEqual(shouldUseSsl('postgresql://u:p@8.8.8.8:5432/db', '8.8.8.8'), false);

  // Managed Cockroach URLs must force verify-full (not require) to silence pg SECURITY WARNING.
  process.env.DB_SSL = 'true';
  const cockroachCfg = buildPoolConfig(
    'postgresql://u:p@consignment-18271.jxf.gcp-europe-west1.cockroachlabs.cloud:26257/defaultdb?sslmode=require'
  );
  assert.ok(String(cockroachCfg.connectionString).includes('sslmode=verify-full'), 'Cockroach pool URL must use sslmode=verify-full');
  assert.ok(!String(cockroachCfg.connectionString).includes('sslmode=require'), 'Cockroach pool URL must not keep sslmode=require');
  assert.strictEqual(cockroachCfg.ssl.rejectUnauthorized, true, 'Cockroach should verify TLS certificates by default');
} finally {
  if (prevSsl === undefined) delete process.env.DB_SSL;
  else process.env.DB_SSL = prevSsl;
  if (prevReject === undefined) delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
  else process.env.DB_SSL_REJECT_UNAUTHORIZED = prevReject;
  if (prevNode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNode;
}

assert.strictEqual(emailRoute.isValidEmail('a@b.com'), true);
assert.strictEqual(emailRoute.isValidEmail('not-an-email'), false);
assert.ok(!/Password:\s+\S/.test(emailRoute.buildWelcomeEmail({
  name: 'Test User',
  email: 't@example.com',
  role: 'packer',
  setupUrl: 'https://example.com/reset',
}).text), 'welcome email must not include a plaintext password value');

const authSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
assert.ok(/router\.get\(\s*'\/me'\s*,\s*authenticateToken/.test(authSrc), '/me must use authenticateToken');
assert.ok(!/adminEmail:\s*normalizeEmail/.test(authSrc), 'public /status must not leak adminEmail');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(serverSrc.includes("'/api/email'"), 'emailLimiter must cover /api/email');
assert.ok(serverSrc.includes('send-password-link'), 'emailLimiter must cover send-password-link');

const deploySrc = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
assert.ok(deploySrc.includes('MAILGUN_API_KEY'), 'deploy must provision Mailgun');
assert.ok(!deploySrc.includes('RESEND_API_KEY'), 'deploy must not reference Resend');
assert.ok(!deploySrc.includes('sync-secrets-to-gcp.sh'), 'deploy must not sync to GCP Secret Manager');
assert.ok(deploySrc.includes('gcloud-deploy.sh'), 'deploy must use gcloud-deploy.sh');

const deployScriptSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'gcloud-deploy.sh'), 'utf8');
assert.ok(deployScriptSrc.includes('MAILGUN_API_KEY'), 'gcloud-deploy must set MAILGUN_API_KEY as env');
assert.ok(deployScriptSrc.includes('--env-vars-file'), 'gcloud-deploy must use Cloud Run env vars file');
assert.ok(deployScriptSrc.includes('--clear-secrets'), 'gcloud-deploy must clear legacy Secret Manager mounts');
assert.ok(!deployScriptSrc.includes('RESEND_API_KEY'), 'gcloud-deploy must not reference Resend');

const syncSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'sync-secrets-to-gcp.sh'), 'utf8');
assert.ok(syncSrc.includes('DEPRECATED'), 'sync-secrets-to-gcp.sh must be marked deprecated');
assert.ok(!/sync_secret\s+"MAILGUN_API_KEY"/.test(syncSrc), 'deprecated sync script must not actively sync Mailgun');
assert.ok(!syncSrc.includes('RESEND_API_KEY'));

const key = deriveBackupKey('x'.repeat(32));
const roundTrip = decryptBuffer(encryptBuffer(Buffer.from('youthnic-backup-ok'), key), key).toString('utf8');
assert.strictEqual(roundTrip, 'youthnic-backup-ok');

const prevMailKey = process.env.MAILGUN_API_KEY;
const prevMailDomain = process.env.MAILGUN_DOMAIN;
const prevEmailOptional = process.env.EMAIL_OPTIONAL;
try {
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.EMAIL_OPTIONAL;
  process.env.NODE_ENV = 'development';
  const dev = validateMailgunConfig();
  assert.strictEqual(dev.ok, true);
  assert.ok(dev.warnings.length >= 1);

  process.env.NODE_ENV = 'production';
  const prod = validateMailgunConfig();
  assert.strictEqual(prod.ok, false);
} finally {
  if (prevMailKey === undefined) delete process.env.MAILGUN_API_KEY;
  else process.env.MAILGUN_API_KEY = prevMailKey;
  if (prevMailDomain === undefined) delete process.env.MAILGUN_DOMAIN;
  else process.env.MAILGUN_DOMAIN = prevMailDomain;
  if (prevEmailOptional === undefined) delete process.env.EMAIL_OPTIONAL;
  else process.env.EMAIL_OPTIONAL = prevEmailOptional;
  if (prevNode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNode;
}

console.log('Reliability hardening tests passed.');
