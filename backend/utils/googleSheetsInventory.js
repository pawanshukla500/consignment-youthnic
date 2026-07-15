/**
 * Google Sheets inventory reader for AutoFetch (manual OMSGuru paste).
 *
 * Observed AutoFetch layout:
 *   Row 1: id | sku_code | <DD/MM/YYYY> | <DD/MM/YYYY> | …
 *   Row 2:    |          | Inventory    | Inventory    | …
 *
 * Matching key: sku_code (column B), case-insensitive.
 * Inventory column: Column C by default (AutoFetch latest available qty).
 * Blank/zero cells clear stale DB stock — they do NOT leave the previous quantity.
 */

const { google } = require('googleapis');
const { normalizeSkuKey } = require('./inventoryPlanning');

function getSheetsJsonRaw() {
  return (
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
    ''
  );
}

function isSheetsEnvPresent() {
  return Boolean(String(getSheetsJsonRaw() || '').trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

/**
 * Parse GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON from Cloud Run / Secret Manager.
 * Handles: raw JSON, stringified JSON, base64 JSON, escaped newlines in private_key.
 */
function parseServiceAccount() {
  let raw = getSheetsJsonRaw();
  if (!raw || !String(raw).trim()) return null;

  let text = String(raw).trim();
  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1).trim();

  // Base64-encoded JSON (sometimes used in secret managers)
  if (!text.startsWith('{') && !text.startsWith('"') && !text.startsWith('[')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{') || decoded.startsWith('"')) text = decoded;
    } catch (_) { /* keep original */ }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: ${err.message}`);
  }

  // Double-encoded: "{"type":"service_account",...}"
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed.trim());
    } catch (err) {
      throw new Error(`Invalid GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON (double-encoded): ${err.message}`);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: expected a service-account object');
  }

  if (parsed.private_key && typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }
  return parsed;
}

/**
 * Inventory Planning requires an explicit Sheets service-account JSON
 * (the account the sheet is shared with). ADC alone is not enough.
 */
function getSheetsCredentialStatus() {
  const rawPresent = Boolean(String(getSheetsJsonRaw() || '').trim());
  const hasAdcPath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  let sheetsJsonValid = null;
  let sheetsClientEmail = null;
  let parseError = null;

  if (rawPresent) {
    try {
      const sa = parseServiceAccount();
      sheetsJsonValid = Boolean(sa?.client_email && sa?.private_key);
      sheetsClientEmail = sa?.client_email || null;
      if (!sheetsJsonValid) {
        parseError = 'Service account JSON missing client_email or private_key';
      }
    } catch (err) {
      sheetsJsonValid = false;
      parseError = err.message;
    }
  }

  const ready = sheetsJsonValid === true;
  let hint = null;
  if (!rawPresent && !hasAdcPath) {
    hint =
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is missing on the Cloud Run service. Add the GitHub secret and redeploy so it syncs to GCP Secret Manager and mounts on Cloud Run.';
  } else if (!rawPresent && hasAdcPath) {
    hint =
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not mounted. Inventory Planning needs that service-account JSON (the email shared on the Google Sheet), not only Application Default Credentials.';
  } else if (sheetsJsonValid === false) {
    hint =
      parseError ||
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is present but invalid JSON / missing client_email or private_key.';
  }

  return {
    ready,
    rawPresent,
    hasAdcPath,
    sheetsJsonValid,
    sheetsClientEmail,
    parseError,
    hint,
  };
}

function isSheetsConfigured() {
  // Preferred path: valid SA JSON. Fall back to ADC only when JSON is absent (local/dev).
  const status = getSheetsCredentialStatus();
  if (status.ready) return true;
  if (!status.rawPresent && status.hasAdcPath) return true;
  return false;
}

function isSheetsReady() {
  return getSheetsCredentialStatus().ready;
}

function formatGoogleSheetsApiError(err, { spreadsheetId, clientEmail } = {}) {
  const code = err?.code || err?.response?.status || err?.status;
  const message = String(err?.message || err || 'Unknown Google Sheets error');
  const lower = message.toLowerCase();
  const shareHint = clientEmail
    ? ` Share the spreadsheet with ${clientEmail} as Editor.`
    : ' Share the spreadsheet with the service-account email as Editor.';

  if (code === 403 || lower.includes('permission') || lower.includes('forbidden')) {
    return `Google Sheets access denied (403).${shareHint} Also enable the Google Sheets API on the GCP project that owns this service account.`;
  }
  if (code === 404 || lower.includes('not found')) {
    return `Google Sheet not found (404). Check Sheet ID ${spreadsheetId || '(missing)'} and that the AutoFetch tab exists.${shareHint}`;
  }
  if (lower.includes('api has not been used') || lower.includes('sheets.googleapis.com') || lower.includes('access not configured')) {
    return `Google Sheets API is not enabled for this GCP project. Enable "Google Sheets API" in Google Cloud Console, then retry Sync.`;
  }
  if (lower.includes('invalid_grant') || lower.includes('invalid jwt') || lower.includes('private key')) {
    return `Google Sheets service-account credentials are invalid (${message}). Re-paste GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON in GitHub secrets and redeploy.`;
  }
  return `Google Sheets error${code ? ` (${code})` : ''}: ${message}`;
}

async function getSheetsClient() {
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
  ];
  const status = getSheetsCredentialStatus();
  let auth;
  if (status.ready) {
    const sa = parseServiceAccount();
    auth = new google.auth.GoogleAuth({ credentials: sa, scopes });
  } else if (status.hasAdcPath && !status.rawPresent) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes,
    });
  } else if (status.rawPresent && status.sheetsJsonValid === false) {
    throw new Error(status.hint || 'Google Sheets service-account JSON is invalid');
  } else {
    throw new Error(
      status.hint ||
        'Google Sheets credentials are not configured. Mount GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON on Cloud Run.'
    );
  }
  try {
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (err) {
    throw new Error(formatGoogleSheetsApiError(err, { clientEmail: status.sheetsClientEmail }));
  }
}

function formatSheetDate(date = new Date()) {
  // Sheet headers use local office dates (India). Prefer Asia/Kolkata when possible.
  const d = date instanceof Date ? date : new Date(date);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.INVENTORY_SHEET_TIMEZONE || 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(d);
    const dd = parts.find((p) => p.type === 'day')?.value;
    const mm = parts.find((p) => p.type === 'month')?.value;
    const yyyy = parts.find((p) => p.type === 'year')?.value;
    if (dd && mm && yyyy) return `${dd}/${mm}/${yyyy}`;
  } catch (_) { /* fall through */ }
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function escapeSheetName(name) {
  return String(name || 'AutoFetch').replace(/'/g, "''");
}

function parseSheetDateLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Choose inventory quantity column.
 * Default / business rule: Column C (index 2) — AutoFetch latest available inventory.
 * When preferColumnC is false: today's date header if present, else newest date, else Col C.
 */
function resolveInventoryColumn(headerRow = [], todayLabel = formatSheetDate(), options = {}) {
  const preferColumnC = options.preferColumnC !== false && options.mode !== 'latest_date';

  if (preferColumnC && headerRow.length > 2) {
    const label = String(headerRow[2] || '').trim() || 'C';
    return { index: 2, label, reason: 'column_c' };
  }

  const candidates = [];
  for (let i = 2; i < headerRow.length; i++) {
    const label = String(headerRow[i] || '').trim();
    if (!label) continue;
    if (label === todayLabel) {
      return { index: i, label, reason: 'today' };
    }
    const parsed = parseSheetDateLabel(label);
    if (parsed) {
      candidates.push({ index: i, label, time: parsed.getTime() });
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.time - a.time || a.index - b.index);
    return { index: candidates[0].index, label: candidates[0].label, reason: 'latest_date' };
  }
  if (headerRow.length > 2) {
    return {
      index: 2,
      label: String(headerRow[2] || 'C').trim() || 'C',
      reason: 'fallback_column_c',
    };
  }
  return null;
}

function parseQuantityCell(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'blank' };
  const text = String(raw).trim();
  if (!text) return { ok: false, reason: 'blank' };
  const cleaned = text.replace(/,/g, '').replace(/%$/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, reason: 'non_numeric' };
  if (n < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value: Math.floor(n) };
}

/**
 * Lightweight auth + sheet access check used by status UI and before sync writes.
 */
async function probeSheetAccess(spreadsheetId, sheetName = 'AutoFetch') {
  const creds = getSheetsCredentialStatus();
  if (!creds.ready && !(creds.hasAdcPath && !creds.rawPresent)) {
    return {
      ok: false,
      error: creds.hint || 'Google Sheets credentials are not configured',
      connection: creds,
    };
  }
  if (!spreadsheetId) {
    return { ok: false, error: 'Google Sheet ID is not configured', connection: creds };
  }

  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,properties.title,sheets.properties.title',
    });
    const titles = (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
    const title = sheetName || 'AutoFetch';
    if (titles.length && !titles.includes(title)) {
      return {
        ok: false,
        error: `Tab "${title}" not found in spreadsheet. Available tabs: ${titles.join(', ') || '(none)'}`,
        connection: creds,
        spreadsheetTitle: meta.data.properties?.title || null,
        availableTabs: titles,
      };
    }

    // Read a small sample from Column C so operators can verify qty immediately
    const escaped = escapeSheetName(title);
    const sampleRead = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${escaped}'!A1:C12`,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const values = sampleRead.data.values || [];
    const sampleRows = [];
    for (let i = 1; i < values.length && sampleRows.length < 5; i++) {
      const row = values[i] || [];
      const sku = String(row[1] ?? '').trim();
      if (!sku || sku.toLowerCase() === 'sku_code' || sku.toLowerCase() === 'inventory') continue;
      const parsed = parseQuantityCell(row[2]);
      sampleRows.push({
        sku,
        columnC: parsed.ok ? parsed.value : null,
        blank: !parsed.ok,
      });
    }

    return {
      ok: true,
      connection: creds,
      spreadsheetTitle: meta.data.properties?.title || null,
      availableTabs: titles,
      sheetName: title,
      sampleRows,
    };
  } catch (err) {
    return {
      ok: false,
      error: formatGoogleSheetsApiError(err, {
        spreadsheetId,
        clientEmail: creds.sheetsClientEmail,
      }),
      connection: creds,
    };
  }
}

/**
 * Read inventory rows from AutoFetch.
 * Blank inventory cells are returned as quantity null so sync can clear stale DB values.
 * @returns {{ rows: Array<{internalSku, quantity, displaySku}>, skipped: Array, meta: object }}
 */
async function fetchInventoryFromSheet(spreadsheetId, sheetName, options = {}) {
  const creds = getSheetsCredentialStatus();
  if (!creds.ready && !(creds.hasAdcPath && !creds.rawPresent)) {
    throw new Error(creds.hint || 'Google Sheets credentials are not configured');
  }
  if (!spreadsheetId) throw new Error('Google Sheet ID is required');

  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (err) {
    throw new Error(formatGoogleSheetsApiError(err, {
      spreadsheetId,
      clientEmail: creds.sheetsClientEmail,
    }));
  }

  const title = sheetName || 'AutoFetch';
  const escaped = escapeSheetName(title);

  let values;
  try {
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${escaped}'`,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    values = read.data.values || [];
  } catch (err) {
    throw new Error(formatGoogleSheetsApiError(err, {
      spreadsheetId,
      clientEmail: creds.sheetsClientEmail,
    }));
  }

  if (values.length < 2) {
    throw new Error(`Sheet "${title}" has no header/data rows`);
  }

  const header = (values[0] || []).map((h) => (h == null ? '' : String(h)));
  const todayLabel = formatSheetDate(new Date());
  // Default true: match Admin UI / settings.preferSheetColumnC (Column C = available qty).
  const preferColumnC = options.preferColumnC !== false;
  const column = resolveInventoryColumn(header, todayLabel, {
    preferColumnC,
    mode: preferColumnC ? 'column_c' : 'latest_date',
  });
  if (!column) {
    throw new Error(`No inventory column found in sheet "${title}" (expected Column C)`);
  }

  const rows = [];
  const skipped = [];
  const seen = new Set();
  // Blank inventory cells default to 0 so Available matches the sheet (not a stale DB qty).
  const blankAsZero = options.blankAsZero !== false;

  // Data usually starts at row 3 (index 2). If row 2 is not "Inventory", still skip header-like rows.
  const startIdx = 1;
  for (let i = startIdx; i < values.length; i++) {
    const row = values[i] || [];
    const displaySku = String(row[1] ?? '').trim();
    const sku = normalizeSkuKey(displaySku);
    if (!sku) {
      // Skip pure header / empty rows
      if (i <= 2) continue;
      skipped.push({ row: i + 1, reason: 'missing_sku' });
      continue;
    }
    // Skip sub-header row ("Inventory" under dates)
    if (sku === 'sku_code' || sku === 'inventory') continue;

    if (seen.has(sku)) {
      skipped.push({ row: i + 1, internalSku: displaySku, reason: 'duplicate_sku_in_sheet' });
      continue;
    }
    seen.add(sku);

    const rawQty = row[column.index];
    const parsed = parseQuantityCell(rawQty);
    if (!parsed.ok) {
      // Blank/invalid → still emit a row so sync clears stale DB quantities.
      rows.push({
        internalSku: sku,
        displaySku: displaySku || sku,
        quantity: blankAsZero ? 0 : null,
        blank: parsed.reason === 'blank',
        invalid: parsed.reason !== 'blank',
        raw: rawQty,
      });
      if (parsed.reason !== 'blank') {
        skipped.push({
          row: i + 1,
          internalSku: displaySku,
          reason: parsed.reason,
          raw: rawQty,
          clearedStale: true,
        });
      }
      continue;
    }

    rows.push({
      internalSku: sku,
      displaySku: displaySku || sku,
      quantity: parsed.value,
      blank: false,
      invalid: false,
      raw: rawQty,
    });
  }

  const withQty = rows.filter((r) => Number(r.quantity) > 0).length;
  const sample = rows
    .slice(0, 8)
    .map((r) => ({ sku: r.displaySku, qty: r.quantity, blank: Boolean(r.blank) }));

  return {
    rows,
    skipped,
    meta: {
      fetchedAt: new Date().toISOString(),
      sheetName: title,
      spreadsheetId,
      inventoryColumnLabel: column.label,
      inventoryColumnIndex: column.index,
      inventoryColumnLetter: String.fromCharCode(65 + column.index),
      columnReason: column.reason,
      todayLabel,
      rowCount: rows.length,
      positiveQtyCount: withQty,
      blankOrInvalidCount: rows.filter((r) => r.quantity == null || r.blank || r.invalid).length,
      skippedCount: skipped.length,
      sample,
      source: 'google_sheet',
      serviceAccountEmail: creds.sheetsClientEmail,
    },
  };
}

module.exports = {
  isSheetsConfigured,
  isSheetsReady,
  isSheetsEnvPresent,
  getSheetsCredentialStatus,
  parseServiceAccount,
  formatSheetDate,
  parseSheetDateLabel,
  resolveInventoryColumn,
  parseQuantityCell,
  formatGoogleSheetsApiError,
  probeSheetAccess,
  fetchInventoryFromSheet,
};
