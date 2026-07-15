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

function isSheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

function parseServiceAccount() {
  let raw =
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
    '';
  if (!raw) return null;

  const trimmed = String(raw).trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('"')) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) raw = decoded;
    } catch (_) { /* keep original */ }
  }

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('Service account JSON missing client_email or private_key');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: ${err.message}`);
  }
}

async function getSheetsClient() {
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
  ];
  const sa = parseServiceAccount();
  let auth;
  if (sa) {
    auth = new google.auth.GoogleAuth({ credentials: sa, scopes });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes,
    });
  } else {
    throw new Error('Google Sheets credentials not configured');
  }
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
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
 * Read inventory rows from AutoFetch.
 * Blank inventory cells are returned as quantity null so sync can clear stale DB values.
 * @returns {{ rows: Array<{internalSku, quantity, displaySku}>, skipped: Array, meta: object }}
 */
async function fetchInventoryFromSheet(spreadsheetId, sheetName, options = {}) {
  if (!isSheetsConfigured()) {
    throw new Error('Google Sheets is not configured');
  }
  if (!spreadsheetId) throw new Error('Google Sheet ID is required');

  const sheets = await getSheetsClient();
  const title = sheetName || 'AutoFetch';
  const escaped = escapeSheetName(title);

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escaped}'`,
    majorDimension: 'ROWS',
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const values = read.data.values || [];
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

  const sample = rows
    .filter((r) => r.quantity != null)
    .slice(0, 5)
    .map((r) => ({ sku: r.displaySku, qty: r.quantity }));

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
      blankOrInvalidCount: rows.filter((r) => r.quantity == null || r.blank || r.invalid).length,
      skippedCount: skipped.length,
      sample,
      source: 'google_sheet',
    },
  };
}

module.exports = {
  isSheetsConfigured,
  parseServiceAccount,
  formatSheetDate,
  parseSheetDateLabel,
  resolveInventoryColumn,
  parseQuantityCell,
  fetchInventoryFromSheet,
};
