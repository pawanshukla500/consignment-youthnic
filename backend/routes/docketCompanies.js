const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requireAnyPermission } = require('../utils/permissions');
const { generateId, now, firestoreHelpers, addAuditLog } = require('../utils/helpers');

// Docket companies UI is also opened by admins without explicit consignments flag;
// admin role still bypasses requireAnyPermission.
router.get(
  '/',
  authenticateToken,
  requireAnyPermission(['consignments'], 'view docket companies'),
  async (req, res) => {
  try {
    const companies = await firestoreHelpers.getCollection('docketCompanies');
    companies.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ companies, count: companies.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create docket company
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { name, officialName, gst } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const id = generateId();
    const data = {
      id,
      name: name.trim(),
      officialName: String(officialName || '').trim(),
      gst: String(gst || '').trim(),
      createdAt: now(),
      updatedAt: now()
    };
    await firestoreHelpers.setDocument('docketCompanies', id, data);
    await addAuditLog('create', 'docket_company', id, req.user.id, { name: data.name, officialName: data.officialName, gst: data.gst });
    res.status(201).json({ company: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update docket company
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await firestoreHelpers.getDocument('docketCompanies', id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { name, officialName, gst } = req.body;
    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const updated = {
      ...existing,
      name: name !== undefined ? name.trim() : existing.name,
      officialName: officialName !== undefined ? String(officialName || '').trim() : (existing.officialName || ''),
      gst: gst !== undefined ? String(gst || '').trim() : (existing.gst || ''),
      updatedAt: now()
    };
    await firestoreHelpers.setDocument('docketCompanies', id, updated);
    await addAuditLog('update', 'docket_company', id, req.user.id, { name: updated.name, officialName: updated.officialName, gst: updated.gst });
    res.json({ company: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete docket company
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    await firestoreHelpers.deleteDocument('docketCompanies', id);
    await addAuditLog('delete', 'docket_company', id, req.user.id, {});
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
