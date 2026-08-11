/**
 * Resend email sender — shared by email routes, auth, and workflow automation.
 * Always inlines the Youthnic logo (CID) so branded templates render reliably.
 */
const fs = require('fs');
const { Resend } = require('resend');
const { getLogoFilePath, LOGO_CID } = require('./emailTemplates');

const API_KEY = () => process.env.RESEND_API_KEY || '';
const FROM_EMAIL = () => process.env.MAIL_FROM_EMAIL || 'consignment@youthnic.shop';
const FROM_NAME = () => process.env.MAIL_FROM_NAME || 'Consignment App';
// Not a Resend API parameter — Resend only needs the (dashboard-verified) FROM_EMAIL domain
// to send. This is purely used to guess a teammate's inbox from their first name
// (e.g. "Pawan" -> pawan@youthnic.shop) for the notify-consignment lookup helper.
const USER_DOMAIN = () => process.env.MAIL_USER_DOMAIN || FROM_EMAIL().split('@')[1] || 'youthnic.shop';

let resendClient = null;

function getClient() {
  if (!resendClient && API_KEY()) {
    resendClient = new Resend(API_KEY());
  }
  return resendClient;
}

function isResendConfigured() {
  const key = API_KEY();
  return Boolean(key && key !== 'your-resend-api-key' && key !== 're_your-resend-api-key');
}

function buildInlineLogo() {
  const logoPath = getLogoFilePath();
  if (!logoPath) {
    console.warn('[Resend] Email logo file missing — emails will send without CID logo');
    return null;
  }
  try {
    return {
      filename: LOGO_CID,
      content: fs.readFileSync(logoPath),
      content_id: LOGO_CID,
      content_type: 'image/png',
    };
  } catch (error) {
    console.warn('[Resend] Could not read email logo:', error.message);
    return null;
  }
}

/**
 * Send email via Resend.
 * Retries once on transient failures. Always attaches branded logo as inline CID.
 * Optional: cc, attachmentBuffers [{ filename, data, contentType }]
 */
async function sendViaResend({ to, cc, subject, html, text, tags = [], attachmentBuffers = [] }) {
  const client = getClient();
  if (!client) {
    throw new Error('Resend client not initialized (missing API key)');
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const ccRecipients = (Array.isArray(cc) ? cc : (cc ? [cc] : []))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((email) => !recipients.includes(email));

  if (!recipients.length) {
    throw new Error('No email recipients');
  }
  if (!subject) {
    throw new Error('Email subject is required');
  }
  if (!html && !text) {
    throw new Error('Email html or text body is required');
  }

  const buildMessageData = () => {
    const attachments = [];
    const logo = buildInlineLogo();
    if (logo) attachments.push(logo);
    if (Array.isArray(attachmentBuffers) && attachmentBuffers.length) {
      for (const item of attachmentBuffers) {
        attachments.push({
          filename: item.filename || 'attachment.bin',
          content: Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data),
          content_type: item.contentType || 'application/octet-stream',
        });
      }
    }

    const messageData = {
      from: `${FROM_NAME()} <${FROM_EMAIL()}>`,
      to: recipients,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      tags: (Array.isArray(tags) && tags.length ? tags : ['consignment-app']).map((name) => ({
        // Resend tags must be ASCII letters/numbers/underscores/dashes only.
        name: String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256),
        value: 'true',
      })),
    };
    if (ccRecipients.length) messageData.cc = ccRecipients;
    if (attachments.length) messageData.attachments = attachments;
    return messageData;
  };

  const attempt = async () => {
    const { data, error } = await client.emails.send(buildMessageData());
    if (error) throw new Error(error.message || 'Resend send failed');
    return data;
  };

  try {
    const res = await attempt();
    console.log(`[Resend] Sent "${subject}" → ${recipients.join(', ')} (${res?.id || 'ok'})`);
    return { statusCode: 200, body: res, recipients, cc: ccRecipients };
  } catch (firstError) {
    console.warn(`[Resend] First attempt failed: ${firstError.message} — retrying once`);
    try {
      const res = await attempt();
      console.log(`[Resend] Retry OK "${subject}" → ${recipients.join(', ')}`);
      return { statusCode: 200, body: res, recipients, cc: ccRecipients };
    } catch (secondError) {
      throw new Error(`Resend error: ${secondError.message}`);
    }
  }
}

module.exports = {
  API_KEY,
  FROM_EMAIL,
  FROM_NAME,
  USER_DOMAIN,
  isResendConfigured,
  sendViaResend,
};
