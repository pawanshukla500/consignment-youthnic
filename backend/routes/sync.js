const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireAnyPermission } = require('../utils/permissions');
const { firestoreHelpers, now } = require('../utils/helpers');
const { pgEnabled } = require('../config/database');
const pgHelpers = require('../utils/pgHelpers');
const { onConsignmentChange } = require('../utils/syncBus');

function mapChange(c) {
  return {
    id: c.id,
    status: c.status,
    shipmentStatus: c.shipmentStatus,
    totalPackedQty: c.totalPackedQty,
    totalRequiredQty: c.totalRequiredQty,
    boxIds: c.boxIds,
    updatedAt: c.updatedAt,
    internalShipmentNo: c.internalShipmentNo,
  };
}

async function fetchChangesSince(sinceMs) {
  if (pgEnabled()) {
    try {
      const sinceIso = new Date(sinceMs).toISOString();
      const items = await pgHelpers.getConsignmentsUpdatedSince(sinceIso);
      return items.map(mapChange);
    } catch (e) {
      console.warn('[Sync] PG since-query failed, falling back:', e.message);
    }
  }

  const all = await firestoreHelpers.getCollection('consignments');
  return all
    .filter((c) => {
      const t = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
      return t > sinceMs;
    })
    .map(mapChange)
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
}

/**
 * Polling fallback — GET /api/sync/changes?since=ISO8601
 */
router.get('/changes', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'sync consignment changes'), async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since).getTime() : 0;
    const sinceMs = Number.isFinite(since) ? since : 0;
    const changes = await fetchChangesSince(sinceMs);
    res.json({ changes, serverTime: now() });
  } catch (error) {
    console.error('[Sync] changes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Server-Sent Events — instant cross-client push.
 * GET /api/sync/events?token=<jwt>
 */
router.get('/events', authenticateToken, requireAnyPermission(['consignments', 'packing'], 'subscribe to sync events'), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'connected', serverTime: now() });

  const handler = (change) => send({ type: 'consignment_updated', ...change });
  const unsub = onConsignmentChange(handler);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      unsub();
    }
  }, 15000);

  // Keep the socket from going idle behind proxies
  if (typeof req.socket?.setTimeout === 'function') {
    req.socket.setTimeout(0);
  }
  if (typeof res.socket?.setKeepAlive === 'function') {
    res.socket.setKeepAlive(true);
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
});

module.exports = router;
