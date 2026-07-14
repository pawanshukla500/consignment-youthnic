/**
 * Supabase Realtime Broadcast publisher (live sync only).
 *
 * Does NOT use Supabase Postgres or Storage. Operational data stays on
 * DATABASE_URL / local Postgres; files stay on Cloudflare R2.
 *
 * Publishes via Realtime HTTP Broadcast so free-tier DB/storage stay empty.
 */
const CHANNEL_TOPIC = 'consignment-lifecycle';
const EVENT_NAME = 'consignment_updated';

function getConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || ''
  ).trim();
  return { url, key, enabled: Boolean(url && key) };
}

function trimBroadcastPayload(change) {
  if (!change?.id) return null;
  return {
    type: 'consignment_updated',
    id: change.id,
    status: change.status,
    shipmentStatus: change.shipmentStatus,
    totalPackedQty: change.totalPackedQty,
    totalRequiredQty: change.totalRequiredQty,
    deleted: change.deleted === true,
    realtimeType: change.realtimeType || null,
    updatedAt: change.updatedAt || change._ts || new Date().toISOString(),
    _eventId: change._eventId || null,
    realtimeSource: 'supabase_broadcast',
  };
}

async function broadcastConsignmentChange(change) {
  const { url, key, enabled } = getConfig();
  if (!enabled) return { skipped: true, reason: 'not_configured' };

  const payload = trimBroadcastPayload(change);
  if (!payload) return { skipped: true, reason: 'empty_payload' };

  const endpoint = `${url}/realtime/v1/api/broadcast`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            topic: CHANNEL_TOPIC,
            event: EVENT_NAME,
            payload,
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(
        `[SupabaseRealtime] broadcast failed (${response.status}):`,
        text.slice(0, 200) || response.statusText
      );
      return { ok: false, status: response.status };
    }

    return { ok: true };
  } catch (error) {
    console.warn('[SupabaseRealtime] broadcast error:', error.message);
    return { ok: false, error: error.message };
  }
}

function getRealtimeStatus() {
  const { url, enabled } = getConfig();
  return {
    provider: 'Supabase Realtime',
    mode: 'broadcast',
    configured: enabled,
    url: url || null,
    topic: CHANNEL_TOPIC,
    event: EVENT_NAME,
    usesSupabaseDatabase: false,
    usesSupabaseStorage: false,
    note: enabled
      ? 'Live sync via Broadcast only — no Supabase DB or Storage usage.'
      : 'Set SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY) for live sync.',
  };
}

module.exports = {
  CHANNEL_TOPIC,
  EVENT_NAME,
  broadcastConsignmentChange,
  getRealtimeStatus,
  getConfig,
};
