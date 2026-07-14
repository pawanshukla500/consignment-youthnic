/**
 * Password reset — Firebase link generation + branded Mailgun email
 */
const { admin, firebaseInitialized } = require('../config/firebase');
const { buildPasswordResetEmail, buildAppPasswordResetUrl } = require('./emailTemplates');
const { sendViaMailgun, isMailgunConfigured, FROM_EMAIL } = require('./mailgun');
const { normalizeEmail } = require('./defaultAdmin');
const { firestoreHelpers } = require('./helpers');

function getAppUrl() {
  return (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
}

/**
 * Firebase only accepts continue URLs on authorized domains (firebaseapp.com is always allowed).
 * We generate the link with that domain, then rewrite the email link to the real app URL.
 */
function getFirebaseAuthorizedContinueUrl() {
  const authDomain = (
    process.env.FIREBASE_AUTH_DOMAIN
    || `${process.env.FIREBASE_PROJECT_ID || 'consignment-packing-app'}.firebaseapp.com`
  ).replace(/^https?:\/\//, '');
  return `https://${authDomain}`;
}

function resolveAppUrl(appOrigin) {
  const fallback = getAppUrl();
  if (!appOrigin || typeof appOrigin !== 'string') return fallback;

  const origin = appOrigin.replace(/\/$/, '');
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;

    const allowed = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (allowed.includes(origin)) return origin;

    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return origin;
    }

    // Cloud Run preview URL and custom Youthnic domains
    if (parsed.hostname.endsWith('.run.app') || parsed.hostname.endsWith('youthnic.shop') || parsed.hostname.endsWith('youthnic-studio.shop')) {
      return origin;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function resolveUserName(email) {
  try {
    const users = await firestoreHelpers.getCollection('users');
    const user = users.find((u) => normalizeEmail(u.email) === email);
    return user?.name || email;
  } catch (error) {
    console.warn('[Auth] Could not resolve user name for reset email:', error.message);
    return email;
  }
}

async function generateResetLink(email, appOrigin) {
  if (!firebaseInitialized || !admin?.auth) {
    const err = new Error('Firebase Auth not configured on the server.');
    err.code = 'firebase_not_configured';
    throw err;
  }

  const appUrl = resolveAppUrl(appOrigin);
  const firebaseContinueUrl = getFirebaseAuthorizedContinueUrl();

  const firebaseLink = await admin.auth().generatePasswordResetLink(email, {
    url: firebaseContinueUrl,
    handleCodeInApp: false,
  });

  return buildAppPasswordResetUrl(firebaseLink, appUrl);
}

async function sendPasswordResetEmail(email, appOrigin) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const err = new Error('A valid email is required.');
    err.code = 'invalid_email';
    throw err;
  }

  const resetUrl = await generateResetLink(normalized, appOrigin);
  const name = await resolveUserName(normalized);
  const { subject, html, text } = buildPasswordResetEmail({
    name,
    email: normalized,
    resetUrl,
    fromEmail: FROM_EMAIL(),
  });

  if (!isMailgunConfigured()) {
    console.warn(`[Auth] MAILGUN_API_KEY not set — password reset link for ${normalized}:`);
    console.warn(resetUrl);
    return { sent: false, resetUrl, reason: 'email_not_configured' };
  }

  await sendViaMailgun({ to: normalized, subject, html, text });
  console.log(`[Auth] Branded password reset email sent to ${normalized}`);
  return { sent: true, resetUrl };
}

module.exports = {
  generateResetLink,
  sendPasswordResetEmail,
  getAppUrl,
  resolveAppUrl,
  getFirebaseAuthorizedContinueUrl,
};
