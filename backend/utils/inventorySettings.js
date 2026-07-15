/**
 * Inventory Planning Admin settings (documents collection settings/inventoryPlanning).
 * Secrets stay in env; this holds non-secret config + recipient lists + schedules.
 */

const { firestoreHelpers } = require('./helpers');

const SETTINGS_ID = 'inventoryPlanning';

const DEFAULT_PRODUCTION_TEAM_EMAILS = [
  'production@vbexports.co.in',
  'dispatches@vbexports.co.in',
];

function parseEmailList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  }
  return [];
}

const DEFAULT_INVENTORY_SETTINGS = {
  enabled: true,
  googleSheetId: process.env.INVENTORY_GOOGLE_SHEET_ID || '1tTOzLKp_Ybh3kIuQbzZOv6eTdVLMk-3EyzHcEjMQgk4',
  googleSheetName: process.env.INVENTORY_GOOGLE_SHEET_NAME || 'AutoFetch',
  preferSheetColumnC: true,
  syncHourUtc: 2,
  syncMinuteUtc: 0,
  syncEnabled: true,
  productionTeamEmails: [...DEFAULT_PRODUCTION_TEAM_EMAILS],
  inventoryTeamEmails: [],
  organisationHeadCcEmails: parseEmailList(process.env.INVENTORY_ORG_HEAD_CC || ''),
  additionalCcEmails: [],
  autoCcOrganisationHeadUsers: true,
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

function withProductionDefaults(emails) {
  const list = parseEmailList(emails);
  return list.length ? list : [...DEFAULT_PRODUCTION_TEAM_EMAILS];
}

/**
 * Resolve Organisation Head CC:
 * 1) Admin-configured organisationHeadCcEmails
 * 2) Else (when autoCcOrganisationHeadUsers) active users with role organization_head
 */
async function resolveOrganisationHeadCcEmails(settings) {
  const configured = parseEmailList(settings?.organisationHeadCcEmails);
  if (configured.length) return configured;
  if (settings?.autoCcOrganisationHeadUsers === false) return [];

  try {
    const users = await firestoreHelpers.getCollection('users');
    return parseEmailList(
      (users || [])
        .filter((u) => u.role === 'organization_head' && u.isActive !== false && u.email)
        .map((u) => u.email)
    );
  } catch (err) {
    console.warn('[InventorySettings] org-head CC lookup failed:', err.message);
    return [];
  }
}

async function getInventorySettings() {
  const doc = await firestoreHelpers.getDocument('settings', SETTINGS_ID);
  if (!doc) {
    return {
      ...DEFAULT_INVENTORY_SETTINGS,
      productionTeamEmails: [...DEFAULT_PRODUCTION_TEAM_EMAILS],
    };
  }
  const { id, ...data } = doc;
  return {
    ...DEFAULT_INVENTORY_SETTINGS,
    ...data,
    productionTeamEmails: withProductionDefaults(
      data.productionTeamEmails ?? DEFAULT_INVENTORY_SETTINGS.productionTeamEmails
    ),
    inventoryTeamEmails: parseEmailList(data.inventoryTeamEmails ?? DEFAULT_INVENTORY_SETTINGS.inventoryTeamEmails),
    organisationHeadCcEmails: parseEmailList(
      data.organisationHeadCcEmails ?? DEFAULT_INVENTORY_SETTINGS.organisationHeadCcEmails
    ),
    additionalCcEmails: parseEmailList(data.additionalCcEmails ?? DEFAULT_INVENTORY_SETTINGS.additionalCcEmails),
    bucketMap: sanitizeBucketMap(data.bucketMap),
    autoCcOrganisationHeadUsers: data.autoCcOrganisationHeadUsers !== false,
    preferSheetColumnC: data.preferSheetColumnC !== false,
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

  if (patch.productionTeamEmails !== undefined) {
    next.productionTeamEmails = withProductionDefaults(patch.productionTeamEmails);
  }
  if (patch.inventoryTeamEmails !== undefined) next.inventoryTeamEmails = parseEmailList(patch.inventoryTeamEmails);
  if (patch.organisationHeadCcEmails !== undefined) {
    next.organisationHeadCcEmails = parseEmailList(patch.organisationHeadCcEmails);
  }
  if (patch.additionalCcEmails !== undefined) next.additionalCcEmails = parseEmailList(patch.additionalCcEmails);
  if (patch.bucketMap !== undefined) next.bucketMap = sanitizeBucketMap(patch.bucketMap);
  if (patch.autoCcOrganisationHeadUsers !== undefined) {
    next.autoCcOrganisationHeadUsers = Boolean(patch.autoCcOrganisationHeadUsers);
  }
  if (patch.preferSheetColumnC !== undefined) {
    next.preferSheetColumnC = Boolean(patch.preferSheetColumnC);
  }

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

  delete next.omsGuruApiKey;
  delete next.googleServiceAccountJson;

  await firestoreHelpers.setDocument('settings', SETTINGS_ID, next);
  return getInventorySettings();
}

function getConnectionStatus() {
  return {
    googleSheetsConfigured: Boolean(
      process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),
    sheetIdFromEnv: process.env.INVENTORY_GOOGLE_SHEET_ID || null,
    inventorySource: 'google_sheet_column_c',
  };
}

module.exports = {
  SETTINGS_ID,
  DEFAULT_PRODUCTION_TEAM_EMAILS,
  DEFAULT_INVENTORY_SETTINGS,
  parseEmailList,
  sanitizeBucketMap,
  withProductionDefaults,
  resolveOrganisationHeadCcEmails,
  getInventorySettings,
  saveInventorySettings,
  getConnectionStatus,
};
