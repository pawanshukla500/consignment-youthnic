/**
 * Email routes — powered by Mailgun
 * Configure MAILGUN_API_KEY, MAILGUN_DOMAIN, MAIL_FROM_EMAIL, MAIL_FROM_NAME
 *
 * Security: never email plaintext passwords. Welcome/invite mails use a
 * Firebase password-setup link instead.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requireAnyPermission } = require('../utils/permissions');
const { addAuditLog } = require('../utils/helpers');
const { sendViaMailgun, isMailgunConfigured, DOMAIN, FROM_EMAIL } = require('../utils/mailgun');
const { sendPasswordResetEmail } = require('../utils/passwordReset');
const { normalizeEmail } = require('../utils/defaultAdmin');

const APP_URL = () => process.env.APP_URL || 'http://localhost:5173';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

/** "Pawan Shukla" → "pawan@youthnic.shop" */
function nameToEmail(name) {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!first) return null;
  return `${first}@${DOMAIN()}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Welcome email — invite/setup link only (no password in the body).
 */
function buildWelcomeEmail({ name, email, role, setupUrl }) {
  const loginUrl = `${APP_URL()}/login`;
  const firstName = escapeHtml(String(name || '').split(' ')[0] || 'there');
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name);
  const permLabel = role === 'admin' ? 'Administrator (full access)' : 'Standard User';
  const setupHref = setupUrl || loginUrl;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to Consignment App</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:32px 16px">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%">
        <tr><td style="background:#0f172a;border-radius:16px 16px 0 0;padding:32px;text-align:center">
          <p style="margin:0;font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">Consignment App</p>
          <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.65);letter-spacing:1px;text-transform:uppercase">Youthnic Packing</p>
        </td></tr>
        <tr><td style="background:#fff;padding:36px 40px">
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">Welcome, ${firstName}</p>
          <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.6">
            Your account has been created on the <strong>Consignment App</strong>.
            Use the secure link below to set your own password, then sign in with <strong>${safeEmail}</strong>.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
            style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:28px">
            <tr><td style="padding:20px 24px">
              <p style="margin:0 0 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8">Account</p>
              <p style="margin:0 0 8px;font-size:13px;color:#0f172a"><strong>Name:</strong> ${safeName}</p>
              <p style="margin:0 0 8px;font-size:13px;color:#0f172a"><strong>Email:</strong> ${safeEmail}</p>
              <p style="margin:0;font-size:13px;color:#0f172a"><strong>Role:</strong> ${escapeHtml(permLabel)}</p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px">
            <tr><td align="center">
              <a href="${escapeHtml(setupHref)}"
                style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 36px;border-radius:10px">
                Set your password
              </a>
            </td></tr>
          </table>
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6">
            If you did not expect this email, contact your administrator at
            <a href="mailto:${escapeHtml(FROM_EMAIL())}" style="color:#4f46e5">${escapeHtml(FROM_EMAIL())}</a>.
          </p>
        </td></tr>
        <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">
            © ${new Date().getFullYear()} Youthnic Exports Pvt. Ltd. · Packing Station
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Welcome to Consignment App, ${String(name || '').split(' ')[0] || 'there'}!

Your account (${email}) has been created with role: ${permLabel}.

Set your password: ${setupHref}
Then sign in: ${loginUrl}

If you did not expect this email, contact ${FROM_EMAIL()}.`;

  return { html, text };
}

router.post('/send', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { to, toName, subject, html, text } = req.body;
    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({ error: 'to, subject, and html/text are required.' });
    }
    if (!isValidEmail(to)) {
      return res.status(400).json({ error: 'A valid recipient email is required.' });
    }
    if (!isMailgunConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on the server.' });
    }

    await sendViaMailgun({
      to,
      toName: toName || to,
      subject,
      html: html || `<p>${escapeHtml(text)}</p>`,
      text,
    });

    await addAuditLog('email_sent', 'email', to, req.user.id, { subject });
    res.json({ ok: true, to, subject });
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    res.status(500).json({ error: 'Email could not be sent.' });
  }
});

/**
 * POST /api/email/welcome
 * Body: { name, email, role?, setupUrl? }
 * Prefer calling /api/auth/send-password-link — this endpoint will generate a setup link when setupUrl is omitted.
 */
router.post('/welcome', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { name, email, role, setupUrl, password } = req.body;
    if (password) {
      return res.status(400).json({
        error: 'Plaintext passwords cannot be emailed. Omit password and use a setup link instead.',
      });
    }
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required.' });
    }
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!isMailgunConfigured()) {
      return res.json({ ok: false, reason: 'Email not configured' });
    }

    let link = typeof setupUrl === 'string' && setupUrl.startsWith('http') ? setupUrl : null;
    if (!link) {
      const result = await sendPasswordResetEmail(normalized);
      if (!result.sent) {
        return res.status(503).json({
          ok: false,
          error: 'Welcome email could not be sent. Password setup link generation or delivery failed.',
        });
      }
      // sendPasswordResetEmail already delivered the branded reset mail.
      await addAuditLog('welcome_email_sent', 'user', normalized, req.user.id, { name, role, via: 'password_reset' });
      return res.json({ ok: true, to: normalized, via: 'password_reset' });
    }

    const { html, text } = buildWelcomeEmail({
      name,
      email: normalized,
      role: role || 'user',
      setupUrl: link,
    });
    await sendViaMailgun({
      to: normalized,
      toName: name,
      subject: 'Welcome to Consignment App — Set your password',
      html,
      text,
    });

    await addAuditLog('welcome_email_sent', 'user', normalized, req.user.id, { name, role });
    res.json({ ok: true, to: normalized });
  } catch (err) {
    console.error('[Email] Welcome email error:', err.message);
    res.status(500).json({ ok: false, error: 'Welcome email could not be sent.' });
  }
});

router.post('/notify-consignment', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'send consignment notifications'), async (req, res) => {
  try {
    const { consignmentId, internalShipmentNo, event, recipientName } = req.body;
    if (!isMailgunConfigured()) return res.json({ ok: false, reason: 'Email not configured' });

    const senderName = recipientName || req.user.name || req.user.email;
    const toEmail = nameToEmail(senderName);
    if (!toEmail) return res.status(400).json({ error: 'Cannot resolve email from name' });

    const labels = {
      box_saved: 'Box Saved',
      consignment_finished: 'Consignment Completed',
      consignment_created: 'Consignment Created',
    };
    const label = labels[event] || escapeHtml(event || 'Update');
    const subject = `[Youthnic] ${label}: ${escapeHtml(internalShipmentNo || consignmentId || '')}`;
    const html = `<p><strong>${label}</strong></p>
      <p>Consignment: ${escapeHtml(internalShipmentNo || consignmentId || 'n/a')}</p>
      <p>By: ${escapeHtml(req.user.name || req.user.email)}</p>`;

    await sendViaMailgun({ to: toEmail, toName: senderName, subject, html });
    await addAuditLog('consignment_email', 'consignment', consignmentId || 'unknown', req.user.id, { event, toEmail });
    res.json({ ok: true, to: toEmail });
  } catch (err) {
    console.error('[Email] Notify error:', err.message);
    res.status(500).json({ error: 'Notification email could not be sent.' });
  }
});

router.get('/resolve-address', authenticateToken, requireAnyPermission(['consignments', 'packing', 'users'], 'resolve email addresses'), (req, res) => {
  const name = req.query.name || req.user?.name;
  const email = nameToEmail(name);
  if (!email) return res.status(400).json({ error: 'Cannot resolve email from name' });
  res.json({ email, name });
});

module.exports = router;
module.exports.buildWelcomeEmail = buildWelcomeEmail;
module.exports.isValidEmail = isValidEmail;
module.exports.escapeHtml = escapeHtml;
