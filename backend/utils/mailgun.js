/**
 * Mailgun email sender — shared by email routes, auth, and workflow automation.
 * Always inlines the Youthnic logo (CID) so branded templates render reliably.
 */
const fs = require('fs');
const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const { getLogoFilePath, LOGO_CID } = require('./emailTemplates');

const API_KEY = () => process.env.MAILGUN_API_KEY || '';
const DOMAIN = () => process.env.MAILGUN_DOMAIN || '';
const FROM_EMAIL = () => process.env.MAIL_FROM_EMAIL || 'consignment@youthnic.shop';
const FROM_NAME = () => process.env.MAIL_FROM_NAME || 'Youthnic Packing Station';

let mgClient = null;

function getClient() {
  if (!mgClient && API_KEY()) {
    mgClient = mailgun.client({ username: 'api', key: API_KEY() });
  }
  return mgClient;
}

function isMailgunConfigured() {
  const key = API_KEY();
  const domain = DOMAIN();
  return Boolean(key && domain && key !== 'your-mailgun-api-key');
}

function buildInlineLogo() {
  const logoPath = getLogoFilePath();
  if (!logoPath) {
    console.warn('[Mailgun] Email logo file missing — emails will send without CID logo');
    return null;
  }
  try {
    return {
      filename: LOGO_CID,
      data: fs.createReadStream(logoPath),
      contentType: 'image/png',
    };
  } catch (error) {
    console.warn('[Mailgun] Could not read email logo:', error.message);
    return null;
  }
}

/**
 * Send email via Mailgun.
 * Retries once on transient failures. Always attaches branded logo as inline CID.
 */
async function sendViaMailgun({ to, subject, html, text, tags = [] }) {
  const client = getClient();
  if (!client) {
    throw new Error('Mailgun client not initialized (missing API key)');
  }
  if (!DOMAIN()) {
    throw new Error('MAILGUN_DOMAIN is not set');
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  if (!recipients.length) {
    throw new Error('No email recipients');
  }
  if (!subject) {
    throw new Error('Email subject is required');
  }
  if (!html && !text) {
    throw new Error('Email html or text body is required');
  }

  const messageData = {
    from: `${FROM_NAME()} <${FROM_EMAIL()}>`,
    to: recipients,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    'o:tag': Array.isArray(tags) && tags.length ? tags : ['consignment-app'],
    'o:tracking': 'no',
  };

  const logo = buildInlineLogo();
  if (logo) {
    messageData.inline = [logo];
  }

  const attempt = async () => client.messages.create(DOMAIN(), messageData);

  try {
    const res = await attempt();
    console.log(`[Mailgun] Sent "${subject}" → ${recipients.join(', ')} (${res?.id || 'ok'})`);
    return { statusCode: 200, body: res, recipients };
  } catch (firstError) {
    console.warn(`[Mailgun] First attempt failed: ${firstError.message} — retrying once`);
    // Rebuild stream for retry (streams are consumed on first attempt)
    if (logo) {
      const again = buildInlineLogo();
      if (again) messageData.inline = [again];
      else delete messageData.inline;
    }
    try {
      const res = await attempt();
      console.log(`[Mailgun] Retry OK "${subject}" → ${recipients.join(', ')}`);
      return { statusCode: 200, body: res, recipients };
    } catch (secondError) {
      throw new Error(`Mailgun error: ${secondError.message}`);
    }
  }
}

module.exports = {
  API_KEY,
  DOMAIN,
  FROM_EMAIL,
  FROM_NAME,
  isMailgunConfigured,
  sendViaMailgun,
};
