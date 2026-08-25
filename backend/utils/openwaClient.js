/**
 * OpenWA Client Adapter for Youthnic
 * Handles sending messages/files to the OpenWA gateway securely.
 */

const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED !== 'false';
const BASE_URL = process.env.OPENWA_BASE_URL || 'https://wa.youthnic.shop';
const SESSION_ID = process.env.OPENWA_SESSION_ID || '7fb5e522-6e31-424e-b596-9eb1fec10314';
const GROUP_ID = process.env.OPENWA_GROUP_ID || '120363421287113344@g.us';
const API_KEY = process.env.OPENWA_API_KEY || '';

function isOpenWaConfigured() {
  return WHATSAPP_ENABLED && !!BASE_URL && !!SESSION_ID;
}

function getOpenWaStatus() {
  return {
    enabled: WHATSAPP_ENABLED,
    configured: isOpenWaConfigured(),
    baseHost: BASE_URL,
    sessionConfigured: !!SESSION_ID,
    groupConfigured: !!GROUP_ID,
  };
}

// Ensure OPENWA_API_KEY is not logged anywhere.
const getHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    // Standard auth header for API keys based on how OpenWA is deployed,
    // usually X-Api-Key or Authorization Bearer. We'll use X-Api-Key.
    headers['X-Api-Key'] = API_KEY;
  }
  return headers;
};

const handleFetch = async (url, options, timeoutMs = 15000) => {
  if (!isOpenWaConfigured()) {
    return { ok: false, error: 'OpenWA is not configured or disabled' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, headers: getHeaders(), signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const text = await res.text();
      // Classify error safely without leaking secrets
      let errorType = 'HTTP_ERROR';
      if (res.status === 401 || res.status === 403) errorType = 'AUTH_ERROR';
      if (res.status === 429) errorType = 'RATE_LIMIT';
      
      // We don't throw raw text in case it mirrors headers, though fetch bodies usually don't.
      return { ok: false, error: `OpenWA ${errorType}: ${res.status}`, status: res.status };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { ok: false, error: 'TIMEOUT', status: 408 };
    }
    return { ok: false, error: 'NETWORK_ERROR', status: 0 };
  }
};

async function healthCheck() {
  return handleFetch(`${BASE_URL}/api/health`, { method: 'GET' }, 5000);
}

async function sendText({ chatId = GROUP_ID, text }) {
  const payload = { chatId, text };
  return handleFetch(`${BASE_URL}/api/sessions/${SESSION_ID}/messages/send-text`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function sendImage({ chatId = GROUP_ID, url, base64, caption, mimetype }) {
  const payload = { chatId, caption };
  if (url) payload.file = { url, mimetype };
  else if (base64) payload.file = { data: base64, mimetype };

  return handleFetch(`${BASE_URL}/api/sessions/${SESSION_ID}/messages/send-image`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function sendDocument({ chatId = GROUP_ID, url, base64, filename, mimetype, caption }) {
  const payload = { chatId, caption };
  if (url) payload.file = { url, filename, mimetype };
  else if (base64) payload.file = { data: base64, filename, mimetype };

  return handleFetch(`${BASE_URL}/api/sessions/${SESSION_ID}/messages/send-document`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function getOpenWAConfig() {
  return {
    enabled: WHATSAPP_ENABLED,
    baseUrl: BASE_URL,
    session: SESSION_ID,
    groupId: GROUP_ID,
  };
}

module.exports = {
  isOpenWaConfigured,
  getOpenWaStatus,
  getOpenWAConfig,
  healthCheck,
  sendText,
  sendImage,
  sendDocument,
};
