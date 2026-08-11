/**
 * Startup environment validation.
 * Fail closed in production when required secrets are missing.
 */

const { isResendConfigured } = require('./resend');

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function requireJwtSecret() {
  if (!process.env.JWT_SECRET || !String(process.env.JWT_SECRET).trim()) {
    throw new Error('[SECURITY] JWT_SECRET environment variable is required.');
  }
}

/**
 * Production rules for admin bootstrap credentials:
 * - ADMIN_PASSWORD is optional when the Firebase admin account already exists
 *   (Firebase Auth is the password source of truth).
 * - ADMIN_PASSWORD is required only for first-time Firebase admin creation
 *   (checked in adminBootstrap, not here).
 * - Never ship a hardcoded fallback password.
 */
function validateAdminBootstrapConfig({ firebaseAdminExists = null } = {}) {
  const warnings = [];
  const errors = [];

  if (isProduction() && firebaseAdminExists === false && !process.env.ADMIN_PASSWORD) {
    errors.push(
      'ADMIN_PASSWORD is required in production for first-time admin bootstrap, ' +
      'or create the admin in Firebase Console before deploy.'
    );
  }

  if (process.env.ADMIN_PASSWORD && String(process.env.ADMIN_PASSWORD).length < 12) {
    const msg = 'ADMIN_PASSWORD should be at least 12 characters when set.';
    if (isProduction()) errors.push(msg);
    else warnings.push(msg);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Resend is required for branded password-reset / invite emails.
 * Missing config is a warning in development and a hard error in production
 * unless EMAIL_OPTIONAL=true (explicit opt-out).
 */
function validateResendConfig() {
  const warnings = [];
  const errors = [];
  const configured = isResendConfigured();

  if (!configured) {
    const msg = 'RESEND_API_KEY is not configured — password reset and invite emails will fail.';
    if (isProduction() && process.env.EMAIL_OPTIONAL !== 'true') {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  return { ok: errors.length === 0, configured, errors, warnings };
}

function assertEnvAtModuleLoad() {
  requireJwtSecret();
}

function logStartupEmailStatus() {
  const result = validateResendConfig();
  for (const warning of result.warnings) {
    console.warn(`[Email] ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`[Email] ${error}`);
  }
  if (result.configured) {
    console.log('[Email] Resend configured');
  }
  if (!result.ok && isProduction()) {
    throw new Error(result.errors[0] || 'Resend configuration invalid.');
  }
  return result;
}

module.exports = {
  isProduction,
  requireJwtSecret,
  validateAdminBootstrapConfig,
  validateResendConfig,
  assertEnvAtModuleLoad,
  logStartupEmailStatus,
};
