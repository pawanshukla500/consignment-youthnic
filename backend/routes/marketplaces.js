const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../utils/permissions');
const { generateId, now, addAuditLog, firestoreHelpers } = require('../utils/helpers');
const {
  sanitizeMarketplacePayload,
  normalizeWarehouses,
  validateWarehouseFields,
} = require('../utils/marketplaceHelpers');
const { buildMarketplaceMap } = require('../utils/dispatchPlanning');
const { invalidateMarketplaceCache } = require('../utils/reportingCache');
const { pgEnabled, getPool } = require('../config/database');

async function marketplaceInUse(marketplaceId) {
  if (pgEnabled()) {
    try {
      const { rows } = await getPool().query(
        `SELECT 1 AS ok
         FROM documents
         WHERE collection = 'consignments'
           AND data->>'marketplaceId' = $1
         LIMIT 1`,
        [marketplaceId]
      );
      return rows.length > 0;
    } catch (e) {
      console.warn('[Marketplaces] in-use SQL check failed, falling back:', e.message);
    }
  }
  const consignments = await firestoreHelpers.getCollection('consignments');
  return consignments.some((c) => c.marketplaceId === marketplaceId);
}

// Get all marketplaces (managers OR consignment editors for form dropdowns)
router.get('/', authenticateToken, requireAnyPermission(['marketplaces', 'consignments'], 'view marketplaces'), async (req, res) => {
  try {
    // Reuse short TTL map cache shared with consignment enrichment (login path untouched).
    const map = await buildMarketplaceMap(firestoreHelpers);
    const normalized = Object.values(map).map((m) => ({
      ...m,
      warehouses: normalizeWarehouses(m.warehouses),
    }));
    normalized.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ marketplaces: normalized, count: normalized.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create marketplace
router.post('/', authenticateToken, requirePermission('marketplaces', 'manage marketplaces'), async (req, res) => {
  try {
    const { name, billTo, warehouses } = sanitizeMarketplacePayload(req.body);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const fieldCheck = validateWarehouseFields(warehouses);
    if (!fieldCheck.ok) return res.status(400).json({ error: fieldCheck.error });

    const id = generateId();
    const data = {
      id,
      name,
      billTo,
      warehouses,
      createdAt: now(),
      updatedAt: now(),
    };
    await firestoreHelpers.setDocument('marketplaces', id, data);
    invalidateMarketplaceCache();
    await addAuditLog('create', 'marketplace', id, req.user.id, { name, warehouseCount: warehouses.length });
    res.status(201).json({ marketplace: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update marketplace
router.put('/:id', authenticateToken, requirePermission('marketplaces', 'manage marketplaces'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await firestoreHelpers.getDocument('marketplaces', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const payload = sanitizeMarketplacePayload({ ...existing, ...req.body });
    if (!payload.name) return res.status(400).json({ error: 'Name is required' });
    const warehouses = req.body.warehouses !== undefined
      ? payload.warehouses
      : normalizeWarehouses(existing.warehouses);
    const fieldCheck = validateWarehouseFields(warehouses);
    if (!fieldCheck.ok) return res.status(400).json({ error: fieldCheck.error });

    const updated = {
      ...existing,
      name: payload.name,
      billTo: payload.billTo,
      warehouses,
      updatedAt: now(),
    };
    await firestoreHelpers.setDocument('marketplaces', id, updated);
    invalidateMarketplaceCache();
    await addAuditLog('update', 'marketplace', id, req.user.id, { name: updated.name });
    res.json({ marketplace: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete marketplace
router.delete('/:id', authenticateToken, requirePermission('marketplaces', 'manage marketplaces'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await firestoreHelpers.getDocument('marketplaces', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (await marketplaceInUse(id)) {
      return res.status(409).json({ error: 'Cannot delete — consignments are linked to this marketplace' });
    }

    await firestoreHelpers.deleteDocument('marketplaces', id);
    invalidateMarketplaceCache();
    await addAuditLog('delete', 'marketplace', id, req.user.id, {});
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
