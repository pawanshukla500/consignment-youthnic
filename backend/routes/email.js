/**
 * Email routes — powered by Resend
 * Configure RESEND_API_KEY, MAIL_FROM_EMAIL, MAIL_FROM_NAME, MAIL_USER_DOMAIN
 *
 * Security: never email plaintext passwords. Welcome/invite mails use a
 * Firebase password-setup link instead.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requireAnyPermission } = require('../utils/permissions');
const { addAuditLog, firestoreHelpers } = require('../utils/helpers');
const { sendViaResend, isResendConfigured, USER_DOMAIN, FROM_EMAIL } = require('../utils/resend');
const { buildWorkflowEmail, emailShell, ctaButton, BRAND, getAppUrl } = require('../utils/emailTemplates');
const { sendPasswordResetEmail } = require('../utils/passwordReset');
const { normalizeEmail } = require('../utils/defaultAdmin');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

/** "Pawan Shukla" → "pawan@youthnic.shop" */
function nameToEmail(name) {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!first) return null;
  return `${first}@${USER_DOMAIN()}`;
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
  const loginUrl = `${getAppUrl()}/login`;
  const firstName = escapeHtml(String(name || '').split(' ')[0] || 'there');
  const safeEmail = escapeHtml(email);
  const safeName = escapeHtml(name || email);
  const permLabel = role === 'admin' ? 'Administrator (full access)' : (role === 'packer' ? 'Packing Station Operator' : 'Standard User');
  const setupHref = setupUrl || loginUrl;
  const subject = 'Welcome to Consignment App — Set your password';

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">Welcome, ${firstName}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.65">
      Your account has been created on the <strong>${escapeHtml(BRAND || 'Consignment App')}</strong>.
      Use the button below to choose your password and sign in with <span style="font-weight:600;color:#0f172a">${safeEmail}</span>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 24px">
      <tr><td style="padding:18px 20px">
        <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8">Account Details</p>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="padding:6px 0;font-size:12.5px;color:#64748b;width:35%;border-bottom:1px solid #f1f5f9">Name</td>
            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;border-bottom:1px solid #f1f5f9">${safeName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:12.5px;color:#64748b;border-bottom:1px solid #f1f5f9">Email</td>
            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;border-bottom:1px solid #f1f5f9">${safeEmail}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:12.5px;color:#64748b">Role</td>
            <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600">${escapeHtml(permLabel)}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    ${ctaButton(setupHref, 'Set your password')}

    <p style="margin:18px 0 8px;font-size:12px;color:#94a3b8;line-height:1.6">
      If the button does not work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 20px;font-size:11px;color:#E11D48;word-break:break-all;line-height:1.5">
      ${escapeHtml(setupHref)}
    </p>

    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;line-height:1.6">
      If you did not expect this email, contact your administrator at
      <a href="mailto:${escapeHtml(FROM_EMAIL())}" style="color:#E11D48;text-decoration:none">${escapeHtml(FROM_EMAIL())}</a>.
    </p>
  `;

  const html = emailShell({
    title: subject,
    preheader: `Welcome to Consignment App · Set your password to get started`,
    bodyHtml,
    accent: '#6A040F',
  });

  const text = `Welcome to Consignment App, ${String(name || '').split(' ')[0] || 'there'}!\n\nYour account (${email}) has been created with role: ${permLabel}.\n\nSet your password: ${setupHref}\nThen sign in: ${loginUrl}\n\nIf you did not expect this email, contact ${FROM_EMAIL()}.`;

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
    if (!isResendConfigured()) {
      return res.status(503).json({ error: 'Email is not configured on the server.' });
    }

    await sendViaResend({
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
    if (!isResendConfigured()) {
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
    await sendViaResend({
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
    if (!isResendConfigured()) return res.json({ ok: false, reason: 'Email not configured' });

    const senderName = recipientName || req.user.name || req.user.email;
    const toEmail = nameToEmail(senderName);
    if (!toEmail) return res.status(400).json({ error: 'Cannot resolve email from name' });

    const labels = {
      box_saved: 'Box Saved',
      consignment_finished: 'Consignment Completed',
      consignment_created: 'Consignment Created',
    };
    const label = labels[event] || String(event || 'Update').replace(/_/g, ' ');
    const actorName = req.user.name || req.user.email;

    let consignment = null;
    if (consignmentId) {
      try {
        consignment = await firestoreHelpers.getDocument('consignments', consignmentId);
      } catch (_) {
        consignment = null;
      }
    }
    const cidLabel = (consignment && (consignment.internalShipmentNo || consignment.id))
      || internalShipmentNo || consignmentId || 'n/a';

    const { subject, html, text } = buildWorkflowEmail({
      title: label,
      headline: label,
      intro: `${escapeHtml(actorName)} just completed <strong>${escapeHtml(label)}</strong> on consignment <strong>${escapeHtml(cidLabel)}</strong>.`,
      consignment: consignment || { id: consignmentId, internalShipmentNo },
      stageLabel: label,
      accent: '#0f172a',
    });

    await sendViaResend({ to: toEmail, subject, html, text, tags: ['consignment-notify', event || 'update'] });
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
