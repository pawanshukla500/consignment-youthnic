const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../utils/permissions');
const { generateId, now, addAuditLog, firestoreHelpers } = require('../utils/helpers');
const { sanitizeMarketplacePayload, normalizeWarehouses } = require('../utils/marketplaceHelpers');

// Get all marketplaces (managers OR consignment editors for form dropdowns)
router.get('/', authenticateToken, requireAnyPermission(['marketplaces', 'consignments'], 'view marketplaces'), async (req, res) => {
  try {
    const marketplaces = await firestoreHelpers.getCollection('marketplaces');
    const normalized = marketplaces.map((m) => ({
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

    const updated = {
      ...existing,
      name: payload.name,
      billTo: payload.billTo,
      warehouses: req.body.warehouses !== undefined ? payload.warehouses : normalizeWarehouses(existing.warehouses),
      updatedAt: now(),
    };
    await firestoreHelpers.setDocument('marketplaces', id, updated);
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

    const consignments = await firestoreHelpers.getCollection('consignments');
    const inUse = consignments.some((c) => c.marketplaceId === id);
    if (inUse) {
      return res.status(409).json({ error: 'Cannot delete — consignments are linked to this marketplace' });
    }

    await firestoreHelpers.deleteDocument('marketplaces', id);
    await addAuditLog('delete', 'marketplace', id, req.user.id, {});
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
