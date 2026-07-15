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
  // Daily morning sync at 10:30 Asia/Kolkata (India) → then email the full report
  syncTimezone: process.env.INVENTORY_SYNC_TIMEZONE || 'Asia/Kolkata',
  syncHourLocal: Number(process.env.INVENTORY_SYNC_HOUR_LOCAL || 10),
  syncMinuteLocal: Number(process.env.INVENTORY_SYNC_MINUTE_LOCAL || 30),
  // Legacy UTC fields kept for older Admin UIs (10:30 IST = 05:00 UTC)
  syncHourUtc: 5,
  syncMinuteUtc: 30,
  syncEnabled: true,
  sheetFetchBatchSize: Number(process.env.INVENTORY_SHEET_BATCH_SIZE || 2000),
  sheetFetchPauseMs: Number(process.env.INVENTORY_SHEET_BATCH_PAUSE_MS || 2000),
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
  emailAfterDailySync: true,
  emailDailyHourUtc: 5,
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
    emailAfterDailySync: data.emailAfterDailySync !== false,
    emailDailyReport: data.emailDailyReport !== false,
    syncTimezone: data.syncTimezone || DEFAULT_INVENTORY_SETTINGS.syncTimezone,
    syncHourLocal: Number.isFinite(Number(data.syncHourLocal))
      ? Number(data.syncHourLocal)
      : DEFAULT_INVENTORY_SETTINGS.syncHourLocal,
    syncMinuteLocal: Number.isFinite(Number(data.syncMinuteLocal))
      ? Number(data.syncMinuteLocal)
      : DEFAULT_INVENTORY_SETTINGS.syncMinuteLocal,
    sheetFetchBatchSize: Number(data.sheetFetchBatchSize) > 0
      ? Number(data.sheetFetchBatchSize)
      : DEFAULT_INVENTORY_SETTINGS.sheetFetchBatchSize,
    sheetFetchPauseMs: Number.isFinite(Number(data.sheetFetchPauseMs))
      ? Number(data.sheetFetchPauseMs)
      : DEFAULT_INVENTORY_SETTINGS.sheetFetchPauseMs,
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
  if (patch.syncHourLocal !== undefined) {
    const h = parseInt(patch.syncHourLocal, 10);
    if (Number.isNaN(h) || h < 0 || h > 23) throw new Error('syncHourLocal must be 0–23');
    next.syncHourLocal = h;
  }
  if (patch.syncMinuteLocal !== undefined) {
    const m = parseInt(patch.syncMinuteLocal, 10);
    if (Number.isNaN(m) || m < 0 || m > 59) throw new Error('syncMinuteLocal must be 0–59');
    next.syncMinuteLocal = m;
  }
  if (patch.syncTimezone !== undefined) {
    next.syncTimezone = String(patch.syncTimezone || 'Asia/Kolkata').trim() || 'Asia/Kolkata';
  }
  if (patch.sheetFetchBatchSize !== undefined) {
    const n = parseInt(patch.sheetFetchBatchSize, 10);
    if (Number.isNaN(n) || n < 100 || n > 5000) throw new Error('sheetFetchBatchSize must be 100–5000');
    next.sheetFetchBatchSize = n;
  }
  if (patch.sheetFetchPauseMs !== undefined) {
    const n = parseInt(patch.sheetFetchPauseMs, 10);
    if (Number.isNaN(n) || n < 0 || n > 30000) throw new Error('sheetFetchPauseMs must be 0–30000');
    next.sheetFetchPauseMs = n;
  }
  if (patch.emailAfterDailySync !== undefined) {
    next.emailAfterDailySync = Boolean(patch.emailAfterDailySync);
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
  const {
    getSheetsCredentialStatus,
  } = require('./googleSheetsInventory');
  const creds = getSheetsCredentialStatus();

  let mailgunConfigured = false;
  try {
    mailgunConfigured = require('./mailgun').isMailgunConfigured();
  } catch (_) { /* ignore */ }

  return {
    // Ready = valid Sheets SA JSON the sheet can be shared with
    googleSheetsConfigured: creds.ready,
    googleSheetsJsonPresent: creds.rawPresent,
    googleSheetsJsonValid: creds.sheetsJsonValid,
    googleSheetsClientEmail: creds.sheetsClientEmail,
    googleApplicationCredentialsSet: creds.hasAdcPath,
    sheetIdFromEnv: process.env.INVENTORY_GOOGLE_SHEET_ID || null,
    inventorySource: 'google_sheet_column_c',
    mailgunConfigured,
    parseError: creds.parseError || null,
    hint: creds.hint,
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
  getZonedDateParts,
  isDailySyncSlot,
};

/**
 * Clock parts in a target IANA timezone (default Asia/Kolkata).
 */
function getZonedDateParts(date = new Date(), timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hourRaw = get('hour');
  // Some environments return "24" for midnight
  const hour = hourRaw === '24' ? 0 : Number(hourRaw);
  return {
    timeZone,
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: Number(get('minute')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function isDailySyncSlot(settings, date = new Date()) {
  const tz = settings?.syncTimezone || 'Asia/Kolkata';
  const parts = getZonedDateParts(date, tz);
  const hour = Number(settings?.syncHourLocal ?? 10);
  const minute = Number(settings?.syncMinuteLocal ?? 30);
  return parts.hour === hour && parts.minute === minute;
}
