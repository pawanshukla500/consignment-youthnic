/**
 * Google Sheets inventory reader for AutoFetch (manual OMSGuru paste).
 *
 * Observed AutoFetch layout:
 *   Row 1: id | sku_code | <DD/MM/YYYY> | <DD/MM/YYYY> | …
 *   Row 2:    |          | Inventory    | Inventory    | …
 *
 * The team pastes inventory into the sheet. This module only READS it.
 * Matching key: sku_code (column B). Latest inventory = preferred date column.
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

  // Allow base64-encoded JSON (sometimes used in secret managers)
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
  const d = date instanceof Date ? date : new Date(date);
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
  // DD/MM/YYYY or D/M/YYYY
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
 * Business rule: Column C (index 2) holds the latest available inventory
 * (today’s date column on AutoFetch, or a static latest qty).
 */
function resolveInventoryColumn(headerRow = [], todayLabel = formatSheetDate(), options = {}) {
  const preferColumnC = options.preferColumnC !== false;

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
  if (!candidates.length) {
    if (headerRow.length > 2) {
      return {
        index: 2,
        label: String(headerRow[2] || 'C').trim() || 'C',
        reason: 'fallback_column_c',
      };
    }
    return null;
  }
  candidates.sort((a, b) => b.time - a.time || a.index - b.index);
  return { index: candidates[0].index, label: candidates[0].label, reason: 'latest_date' };
}

function parseQuantityCell(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'blank' };
  const text = String(raw).trim();
  if (!text) return { ok: false, reason: 'blank' };
  const cleaned = text.replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, reason: 'non_numeric' };
  if (n < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value: Math.floor(n) };
}

/**
 * Read latest inventory rows from AutoFetch.
 * @returns {{ rows: Array<{internalSku, quantity}>, skipped: Array, meta: object }}
 */
async function fetchInventoryFromSheet(spreadsheetId, sheetName) {
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
  });

  const values = read.data.values || [];
  if (values.length < 2) {
    throw new Error(`Sheet "${title}" has no header/data rows`);
  }

  const header = values[0] || [];
  const todayLabel = formatSheetDate(new Date());
  // Prefer Column C = latest available inventory (Internal SKU in Column B)
  const column = resolveInventoryColumn(header, todayLabel, { preferColumnC: true });
  if (!column) {
    throw new Error(`No inventory column found in sheet "${title}" (expected Column C)`);
  }

  const rows = [];
  const skipped = [];
  const seen = new Set();

  for (let i = 2; i < values.length; i++) {
    const row = values[i] || [];
    const sku = normalizeSkuKey(row[1]);
    if (!sku) {
      skipped.push({ row: i + 1, reason: 'missing_sku' });
      continue;
    }
    if (seen.has(sku)) {
      skipped.push({ row: i + 1, internalSku: sku, reason: 'duplicate_sku_in_sheet' });
      continue;
    }
    seen.add(sku);

    const parsed = parseQuantityCell(row[column.index]);
    if (!parsed.ok) {
      skipped.push({
        row: i + 1,
        internalSku: sku,
        reason: parsed.reason,
        raw: row[column.index],
      });
      continue;
    }

    rows.push({
      internalSku: sku,
      quantity: parsed.value,
      productName: '',
    });
  }

  return {
    rows,
    skipped,
    meta: {
      fetchedAt: new Date().toISOString(),
      sheetName: title,
      spreadsheetId,
      inventoryColumnLabel: column.label,
      inventoryColumnIndex: column.index,
      columnReason: column.reason,
      rowCount: rows.length,
      skippedCount: skipped.length,
      source: 'google_sheet',
    },
  };
}

module.exports = {
  isSheetsConfigured,
  formatSheetDate,
  parseSheetDateLabel,
  resolveInventoryColumn,
  parseQuantityCell,
  fetchInventoryFromSheet,
};
