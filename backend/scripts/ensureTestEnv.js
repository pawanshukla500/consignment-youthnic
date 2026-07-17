/**
 * Load a safe test-only JWT secret (and related defaults) before importing auth modules.
 * Never use these values in production.
 */
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-ci-do-not-use-in-production';
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET,
};
