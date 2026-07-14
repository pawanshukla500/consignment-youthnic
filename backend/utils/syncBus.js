/**
 * Cross-instance consignment change bus.
 * Local EventEmitter for same-process SSE clients + Postgres LISTEN/NOTIFY for Cloud Run scale-out.
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

const CHANNEL = 'consignment_changes';
let listenerStarted = false;
let listenerClient = null;
const recentEventIds = new Set();

function rememberEvent(eventId) {
  if (!eventId) return false;
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.add(eventId);
  setTimeout(() => recentEventIds.delete(eventId), 10000);
  return false;
}

function emitLocal(change) {
  if (!change?.id) return;
  if (rememberEvent(change._eventId)) return;
  bus.emit('consignment', {
    ...change,
    _ts: change._ts || new Date().toISOString(),
    _eventId: change._eventId || `${change.id}:${Date.now()}`,
  });
}

async function ensurePgListener() {
  if (listenerStarted) return;
  try {
    const { pgEnabled, getPool } = require('../config/database');
    if (!pgEnabled()) return;
    listenerStarted = true;
    listenerClient = await getPool().connect();
    await listenerClient.query(`LISTEN ${CHANNEL}`);
    listenerClient.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const change = JSON.parse(msg.payload);
        // Avoid re-broadcast loops: only fan out locally
        emitLocal({ ...change, _via: 'pg_notify' });
      } catch (error) {
        console.warn('[SyncBus] invalid NOTIFY payload:', error.message);
      }
    });
    listenerClient.on('error', (error) => {
      console.error('[SyncBus] listener error:', error.message);
      listenerStarted = false;
      try { listenerClient.release(); } catch (_) { /* ignore */ }
      listenerClient = null;
      setTimeout(() => { ensurePgListener().catch(() => {}); }, 3000);
    });
    console.log('[SyncBus] Postgres LISTEN started on', CHANNEL);
  } catch (error) {
    listenerStarted = false;
    console.warn('[SyncBus] LISTEN unavailable:', error.message);
  }
}

function emitConsignmentChange(change) {
  if (!change?.id) return;
  const payload = {
    ...change,
    _ts: new Date().toISOString(),
    _eventId: `${change.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  };
  emitLocal(payload);

  try {
    const { broadcastConsignmentChange } = require('./supabaseRealtime');
    broadcastConsignmentChange(payload).catch(() => {});
  } catch (error) {
    console.warn('[SyncBus] Supabase broadcast skipped:', error.message);
  }

  try {
    const { pgEnabled, getPool } = require('../config/database');
    if (!pgEnabled()) return;
    const json = JSON.stringify(payload);
    // NOTIFY payload limit ~8000 bytes — trim large fields if needed
    const safe = json.length > 7500
      ? JSON.stringify({
          id: payload.id,
          status: payload.status,
          shipmentStatus: payload.shipmentStatus,
          totalPackedQty: payload.totalPackedQty,
          totalRequiredQty: payload.totalRequiredQty,
          deleted: payload.deleted,
          realtimeType: payload.realtimeType,
          updatedAt: payload.updatedAt,
          _ts: payload._ts,
          _eventId: payload._eventId,
        })
      : json;
    getPool().query('SELECT pg_notify($1, $2)', [CHANNEL, safe]).catch((error) => {
      console.warn('[SyncBus] NOTIFY failed:', error.message);
    });
  } catch (error) {
    console.warn('[SyncBus] NOTIFY skipped:', error.message);
  }
}

function onConsignmentChange(handler) {
  ensurePgListener().catch(() => {});
  bus.on('consignment', handler);
  return () => bus.off('consignment', handler);
}

module.exports = { bus, emitConsignmentChange, onConsignmentChange, ensurePgListener };
