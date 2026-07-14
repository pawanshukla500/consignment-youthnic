/**
 * Durable HMAC share tokens for video/document links.
 * Tokens do not expire; deleting the file makes the link return 404.
 */
const crypto = require('crypto');

function getShareSecret() {
  const secret = String(process.env.SHARE_LINK_SECRET || process.env.JWT_SECRET || '').trim();
  if (!secret) {
    const err = new Error('SHARE_LINK_SECRET or JWT_SECRET is required for durable share links.');
    err.statusCode = 503;
    throw err;
  }
  return secret;
}

function getPublicApiBase(req) {
  const configured = String(process.env.PUBLIC_API_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function createShareToken(fileId, type = 'video') {
  if (!fileId) throw new Error('fileId is required');
  const secret = getShareSecret();
  const payload = Buffer.from(JSON.stringify({
    f: String(fileId),
    t: String(type || 'video'),
    v: 1,
  }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyShareToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const secret = getShareSecret();
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.f || data.v !== 1) return null;
    return { fileId: String(data.f), type: String(data.t || 'video') };
  } catch {
    return null;
  }
}

function buildDurableShareUrl(req, fileId, type = 'video') {
  const token = createShareToken(fileId, type);
  const apiBase = getPublicApiBase(req);
  const appBase = String(process.env.APP_URL || apiBase).trim().replace(/\/$/, '') || apiBase;
  const encoded = encodeURIComponent(token);
  return {
    token,
    // Human-friendly dispute page (preferred for sharing with marketplaces / customers)
    shareUrl: `${appBase}/share/video/${encoded}`,
    // Raw stream from Cloudflare R2 via backend (no login)
    streamUrl: `${apiBase}/api/uploads/s/${encoded}`,
    path: `/share/video/${encoded}`,
    streamPath: `/api/uploads/s/${encoded}`,
  };
}

module.exports = {
  createShareToken,
  verifyShareToken,
  buildDurableShareUrl,
  getPublicApiBase,
};
