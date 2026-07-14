const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { firestoreHelpers } = require('../utils/helpers');

const ACTION_LABELS = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  pack: 'Packed SKU',
  save_box: 'Saved Box',
  finish: 'Finished Packing',
  login: 'Signed in',
  logout: 'Signed out',
  upload: 'Uploaded file',
  permission_change: 'Changed permissions',
  logout_all_devices: 'Logged out all devices',
  change_password: 'Changed password',
  update_profile: 'Updated profile',
  cleanup: 'Ran cleanup',
  reconcile: 'Checked data integrity',
  migrate: 'Imported legacy data',
  email_sent: 'Sent email',
  welcome_email_sent: 'Sent welcome email',
  email_notification: 'Sent notification email',
};

const ENTITY_LABELS = {
  consignment: 'consignment',
  user: 'user',
  video: 'video',
  document: 'document',
  box: 'box',
  sku: 'SKU',
  skuCatalog: 'SKU catalog item',
  marketplace: 'marketplace',
  docket_company: 'docket company',
  settings: 'settings',
  email: 'email',
  file: 'file',
};

const DETAIL_LABELS = {
  internalShipmentNo: 'Shipment number',
  skuCount: 'SKU count',
  boxNo: 'Box number',
  quantity: 'Quantity',
  itemCount: 'Item count',
  weight: 'Weight',
  weightUnit: 'Weight unit',
  email: 'Email',
  name: 'Name',
  role: 'Role',
  self: 'Own account',
  revoked: 'Access revoked',
  permissionChanges: 'Permission changes',
  deletedStorageFiles: 'Deleted files',
  consignmentId: 'Consignment ID',
  subject: 'Subject',
  toEmail: 'To email',
  event: 'Event',
  via: 'Login method',
};

function prettifyKey(key) {
  return DETAIL_LABELS[key] || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, nestedValue]) => `${prettifyKey(key)}: ${formatValue(nestedValue)}`)
      .join('; ');
  }
  return String(value);
}

function buildSummary(log, userName) {
  const action = ACTION_LABELS[log.action] || prettifyKey(log.action || 'Activity');
  const entity = ENTITY_LABELS[log.entityType] || prettifyKey(log.entityType || 'record').toLowerCase();
  const idText = log.entityId ? ` (${log.entityId})` : '';
  const detailEntries = Object.entries(log.details || {}).filter(([, value]) => value !== undefined && value !== '');
  const detailText = detailEntries.length
    ? ` Details: ${detailEntries.map(([key, value]) => `${prettifyKey(key)}: ${formatValue(value)}`).join('; ')}.`
    : '';
  return `${userName || 'Unknown user'} ${action.toLowerCase()} ${entity}${idText}.${detailText}`;
}

function endOfDay(dateText) {
  if (!dateText) return null;
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function filterLogs(logs, query) {
  const { userId, action, entityType, startDate, endDate } = query;
  let filtered = [...logs];
  if (userId) filtered = filtered.filter(l => l.userId === userId);
  if (action) filtered = filtered.filter(l => l.action === action);
  if (entityType) filtered = filtered.filter(l => l.entityType === entityType);
  if (startDate) {
    const sd = new Date(startDate).getTime();
    if (!Number.isNaN(sd)) filtered = filtered.filter(l => new Date(l.timestamp).getTime() >= sd);
  }
  if (endDate) {
    const ed = endOfDay(endDate);
    if (ed) filtered = filtered.filter(l => new Date(l.timestamp).getTime() <= ed);
  }
  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return filtered;
}

async function userNameMap() {
  const users = await firestoreHelpers.getCollection('users').catch(() => []);
  return users.reduce((map, user) => {
    map[user.id] = user.name || user.email || user.id;
    return map;
  }, {});
}

function enrichLogs(logs, names) {
  return logs.map(log => {
    const userName = names[log.userId] || log.userName || log.userId || 'Unknown user';
    return {
      ...log,
      userName,
      actionLabel: ACTION_LABELS[log.action] || prettifyKey(log.action || 'Activity'),
      entityLabel: ENTITY_LABELS[log.entityType] || prettifyKey(log.entityType || 'record'),
      summary: buildSummary(log, userName),
    };
  });
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function getAuditLogRetentionDays() {
  const settings = await firestoreHelpers.getDocument('settings', 'retention').catch(() => null);
  return settings?.auditLogRetentionDays || 400;
}

// Get all audit logs (admin only). Audit logs are protected from manual deletion and retained for at least 400 days.
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { limit = 250 } = req.query;
    const pageSize = Math.min(parseInt(limit, 10) || 250, 5000);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || ((page - 1) * pageSize), 0);
    const [names, retentionDays] = await Promise.all([userNameMap(), getAuditLogRetentionDays()]);
    let logs = filterLogs(await firestoreHelpers.getCollection('auditLogs'), req.query);
    const total = logs.length;
    logs = logs.slice(offset, offset + pageSize);
    res.json({ logs: enrichLogs(logs, names), count: logs.length, total, page, pageSize, hasMore: offset + logs.length < total, retentionDays, longTerm: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/export', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const exportLimit = Math.min(parseInt(req.query.limit, 10) || 10000, 50000);
    const names = await userNameMap();
    const logs = enrichLogs(filterLogs(await firestoreHelpers.getCollection('auditLogs'), req.query).slice(0, exportLimit), names);
    const rows = [
      ['Date and time', 'User', 'Action', 'Area', 'Record ID', 'Plain English summary'],
      ...logs.map(log => [
        log.timestamp ? new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
        log.userName,
        log.actionLabel,
        log.entityLabel,
        log.entityId || '',
        log.summary,
      ]),
    ];
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
    const suffix = [req.query.startDate, req.query.endDate].filter(Boolean).join('_to_') || 'all-dates';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${suffix}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current user's own activity (accessible to all authenticated users)
router.get('/my-activity', authenticateToken, async (req, res) => {
  try {
    const names = await userNameMap();
    let logs = await firestoreHelpers.queryCollection('auditLogs', 'userId', '==', req.user.id);
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    logs = logs.slice(0, 50);
    res.json({ logs: enrichLogs(logs, names), count: logs.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
