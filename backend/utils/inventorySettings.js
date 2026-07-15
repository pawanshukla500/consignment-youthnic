/**
 * Inventory Planning Admin settings (documents collection settings/inventoryPlanning).
 * Secrets stay in env; this holds non-secret config + recipient lists + schedules.
 */

const { firestoreHelpers } = require('./helpers');

const SETTINGS_ID = 'inventoryPlanning';

const DEFAULT_INVENTORY_SETTINGS = {
  enabled: true,
  googleSheetId: process.env.INVENTORY_GOOGLE_SHEET_ID || '1tTOzLKp_Ybh3kIuQbzZOv6eTdVLMk-3EyzHcEjMQgk4',
  googleSheetName: process.env.INVENTORY_GOOGLE_SHEET_NAME || 'AutoFetch',
  syncHourUtc: 2,
  syncMinuteUtc: 0,
  syncEnabled: true,
  productionTeamEmails: [],
  inventoryTeamEmails: [],
  organisationHeadCcEmails: [],
  additionalCcEmails: [],
  bucketMap: {
    critical: 'critical',
    high: 'urgent',
    medium: 'normal',
    normal: 'normal',
    warning: 'urgent',
  },
  treatMissingInventoryAsZero: false,
  lowInventoryPct: 100,
  emailOnNewShortage: true,
  emailOnQuantityChange: true,
  emailOnPriorityChange: true,
  emailOnNewShortageFromSync: true,
  emailOnCriticalOrUrgent: true,
  emailOnResolvedShortage: true,
  emailDailyReport: true,
  emailDailyHourUtc: 3,
  emailMinIntervalMinutes: 30,
  reportRetentionDays: 90,
  openConsignmentStatuses: ['pending', 'in_progress'],
  excludedShipmentStatuses: ['Dispatched', 'Inwarded', 'Delivered', 'Cancelled'],
  dashboardPath: '/inventory-planning',
  lastSuccessfulSyncAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  lastEmailFingerprint: null,
  lastEmailSentAt: null,
};

function parseEmailList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  }
  return [];
}

function sanitizeBucketMap(input) {
  const base = { ...DEFAULT_INVENTORY_SETTINGS.bucketMap };
  if (!input || typeof input !== 'object') return base;
  for (const [k, v] of Object.entries(input)) {
    const bucket = String(v || '').toLowerCase();
    if (['critical', 'urgent', 'normal'].includes(bucket)) {
      base[String(k).toLowerCase()] = bucket;
    }
  }
  return base;
}

async function getInventorySettings() {
  const doc = await firestoreHelpers.getDocument('settings', SETTINGS_ID);
  if (!doc) return { ...DEFAULT_INVENTORY_SETTINGS };
  const { id, ...data } = doc;
  return {
    ...DEFAULT_INVENTORY_SETTINGS,
    ...data,
    productionTeamEmails: parseEmailList(data.productionTeamEmails ?? DEFAULT_INVENTORY_SETTINGS.productionTeamEmails),
    inventoryTeamEmails: parseEmailList(data.inventoryTeamEmails ?? DEFAULT_INVENTORY_SETTINGS.inventoryTeamEmails),
    organisationHeadCcEmails: parseEmailList(data.organisationHeadCcEmails ?? DEFAULT_INVENTORY_SETTINGS.organisationHeadCcEmails),
    additionalCcEmails: parseEmailList(data.additionalCcEmails ?? DEFAULT_INVENTORY_SETTINGS.additionalCcEmails),
    bucketMap: sanitizeBucketMap(data.bucketMap),
  };
}

async function saveInventorySettings(patch, userId = 'system') {
  const current = await getInventorySettings();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };

  if (patch.productionTeamEmails !== undefined) next.productionTeamEmails = parseEmailList(patch.productionTeamEmails);
  if (patch.inventoryTeamEmails !== undefined) next.inventoryTeamEmails = parseEmailList(patch.inventoryTeamEmails);
  if (patch.organisationHeadCcEmails !== undefined) next.organisationHeadCcEmails = parseEmailList(patch.organisationHeadCcEmails);
  if (patch.additionalCcEmails !== undefined) next.additionalCcEmails = parseEmailList(patch.additionalCcEmails);
  if (patch.bucketMap !== undefined) next.bucketMap = sanitizeBucketMap(patch.bucketMap);

  if (patch.syncHourUtc !== undefined) {
    const h = parseInt(patch.syncHourUtc, 10);
    if (Number.isNaN(h) || h < 0 || h > 23) throw new Error('syncHourUtc must be 0–23');
    next.syncHourUtc = h;
  }
  if (patch.syncMinuteUtc !== undefined) {
    const m = parseInt(patch.syncMinuteUtc, 10);
    if (Number.isNaN(m) || m < 0 || m > 59) throw new Error('syncMinuteUtc must be 0–59');
    next.syncMinuteUtc = m;
  }
  if (patch.reportRetentionDays !== undefined) {
    const d = parseInt(patch.reportRetentionDays, 10);
    if (Number.isNaN(d) || d < 7 || d > 730) throw new Error('reportRetentionDays must be 7–730');
    next.reportRetentionDays = d;
  }
  if (patch.emailMinIntervalMinutes !== undefined) {
    const mins = parseInt(patch.emailMinIntervalMinutes, 10);
    if (Number.isNaN(mins) || mins < 0 || mins > 1440) throw new Error('emailMinIntervalMinutes must be 0–1440');
    next.emailMinIntervalMinutes = mins;
  }

  // Never persist secrets in settings doc
  delete next.omsGuruApiKey;
  delete next.googleServiceAccountJson;

  await firestoreHelpers.setDocument('settings', SETTINGS_ID, next);
  return getInventorySettings();
}

function getConnectionStatus() {
  return {
    omsGuruConfigured: Boolean(
      process.env.OMSGURU_API_BASE_URL &&
      (process.env.OMSGURU_API_KEY || process.env.OMSGURU_API_TOKEN)
    ),
    googleSheetsConfigured: Boolean(
      process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),
    sheetIdFromEnv: process.env.INVENTORY_GOOGLE_SHEET_ID || null,
  };
}

module.exports = {
  SETTINGS_ID,
  DEFAULT_INVENTORY_SETTINGS,
  parseEmailList,
  sanitizeBucketMap,
  getInventorySettings,
  saveInventorySettings,
  getConnectionStatus,
};
