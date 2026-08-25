/**
 * OpenWA Client for Youthnic
 * Handles sending messages/files to the WAHA (WhatsApp HTTP API) instance.
 */

function getOpenWAConfig() {
  const baseUrl = process.env.OPENWA_BASE_URL || 'https://wa.youthnic.shop';
  const session = process.env.OPENWA_SESSION_ID || '7fb5e522-6e31-424e-b596-9eb1fec10314';
  const groupId = process.env.OPENWA_GROUP_ID || '120363421287113344@g.us';
  
  return { baseUrl, session, groupId };
}

/**
 * Send a text message to a specific chat ID.
 * Defaults to the configured group ID if not provided.
 */
async function sendText(text, chatId = null) {
  const config = getOpenWAConfig();
  const targetChatId = chatId || config.groupId;

  if (!config.baseUrl) {
    console.warn('[OpenWA] Skipped sending text - OPENWA_BASE_URL not configured');
    return { ok: false, error: 'OPENWA_BASE_URL not configured' };
  }

  try {
    const response = await fetch(`${config.baseUrl}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: targetChatId,
        text,
        session: config.session,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenWA API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    console.error('[OpenWA] Failed to send text:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Send a file (image, video, document) via OpenWA.
 * Note: WAHA /api/sendFile expects a URL or base64 data.
 */
async function sendFile(fileUrl, filename, caption = '', chatId = null) {
  const config = getOpenWAConfig();
  const targetChatId = chatId || config.groupId;

  if (!config.baseUrl) {
    console.warn('[OpenWA] Skipped sending file - OPENWA_BASE_URL not configured');
    return { ok: false, error: 'OPENWA_BASE_URL not configured' };
  }

  try {
    // WAHA format for sending a file by URL
    const payload = {
      chatId: targetChatId,
      session: config.session,
      file: {
        mimetype: '', // Can be empty or inferred by WAHA
        filename: filename,
        url: fileUrl,
      },
      caption,
    };

    const response = await fetch(`${config.baseUrl}/api/sendFile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenWA API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    console.error('[OpenWA] Failed to send file:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  getOpenWAConfig,
  sendText,
  sendFile,
};
