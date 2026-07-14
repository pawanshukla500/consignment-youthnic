/**
 * C2 env validation tests.
 * Run: node scripts/test-env-validation.js
 */
const assert = require('assert');
const { validateAdminBootstrapConfig } = require('../utils/envValidation');

const prevNodeEnv = process.env.NODE_ENV;
const prevAdminPassword = process.env.ADMIN_PASSWORD;

try {
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_PASSWORD;

  let result = validateAdminBootstrapConfig({ firebaseAdminExists: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('ADMIN_PASSWORD')));

  result = validateAdminBootstrapConfig({ firebaseAdminExists: true });
  assert.strictEqual(result.ok, true);

  process.env.ADMIN_PASSWORD = 'short';
  result = validateAdminBootstrapConfig({ firebaseAdminExists: false });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('12 characters')));

  process.env.NODE_ENV = 'development';
  process.env.ADMIN_PASSWORD = 'short';
  result = validateAdminBootstrapConfig({ firebaseAdminExists: false });
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('12 characters')));

  // Ensure no hardcoded legacy bootstrap password string remains in bootstrap helpers.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  // Reconstruct without embedding the historical secret as a source literal.
  const bannedLegacyPassword = Buffer.from('WGNoYW5nZUMk', 'base64').toString('utf8');
  const files = [
    'utils/defaultAdmin.js',
    'utils/adminBootstrap.js',
    'middleware/auth.js',
    'scripts/check-users.js',
    'scripts/test-endpoints.sh',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.strictEqual(
      text.includes(bannedLegacyPassword),
      false,
      `legacy password literal found in ${rel}`
    );
  }

  console.log('C2 env-validation tests passed.');
} finally {
  process.env.NODE_ENV = prevNodeEnv;
  if (prevAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = prevAdminPassword;
}
