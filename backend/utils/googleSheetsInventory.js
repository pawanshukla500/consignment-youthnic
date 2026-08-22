/**
 * Google Sheets inventory reader.
 *
 * Supported layouts (same workbook):
 *
 * A) Date meta + Inventory header (FC inventory / Total Inventory):
 *   Row 1:        | Date     | 15/07/2026
 *   Row 2: id     | sku_code | Inventory
 *   Row n: 21591169 | EJ1201-16001 | 955
 *
 * B) AutoFetch multi-date:
 *   Row 1: id | sku_code | <DD/MM/YYYY> | <DD/MM/YYYY> | …
 *   Row 2:    |          | Inventory    | Inventory    | …
 *
 * Matching key: Column B sku_code (case-insensitive).
 * Quantity: Column C by default, or the column whose header is "Inventory".
 */

const { google } = require('googleapis');
const { normalizeSkuKey } = require('./inventoryPlanning');

const DEFAULT_SHEET_CANDIDATES = [
  'AutoFetch',
  'Total Inventory',
  'FC inventory and In-Transit',
  'Inventory',
  'FC Inventory',
];

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
      'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is missing on the Cloud Run service. Add the GitHub secret GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON and redeploy so it is set as a Cloud Run env var.';
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
    return `Google Sheet not found (404). Check Sheet ID ${spreadsheetId || '(missing)'} and that the inventory tab exists.${shareHint}`;
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

function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isSkuHeaderCell(value) {
  const t = cellText(value).toLowerCase().replace(/\s+/g, '_');
  return t === 'sku_code' || t === 'sku' || t === 'internal_sku' || t === 'internal sku';
}

function isInventoryHeaderCell(value) {
  const t = cellText(value).toLowerCase();
  return (
    t === 'inventory' ||
    t === 'available' ||
    t === 'available inventory' ||
    t === 'stock' ||
    t === 'qty' ||
    t === 'quantity'
  );
}

/**
 * Choose inventory quantity column from a header row.
 * Prefers an "Inventory" header, otherwise Column C.
 */
function resolveInventoryColumn(headerRow = [], todayLabel = formatSheetDate(), options = {}) {
  const preferColumnC = options.preferColumnC !== false && options.mode !== 'latest_date';

  for (let i = 2; i < headerRow.length; i++) {
    if (isInventoryHeaderCell(headerRow[i])) {
      return {
        index: i,
        label: cellText(headerRow[i]) || 'Inventory',
        reason: i === 2 ? 'column_c_inventory' : 'inventory_header',
      };
    }
  }

  if (preferColumnC && headerRow.length > 2) {
    const label = cellText(headerRow[2]) || 'C';
    return { index: 2, label, reason: 'column_c' };
  }

  const candidates = [];
  for (let i = 2; i < headerRow.length; i++) {
    const label = cellText(headerRow[i]);
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
      label: cellText(headerRow[2]) || 'C',
      reason: 'fallback_column_c',
    };
  }
  return null;
}

/**
 * Locate the header row that contains sku_code (may not be row 1 when Date meta sits above it).
 */
function findHeaderRow(values = []) {
  const maxScan = Math.min(values.length, 10);
  for (let i = 0; i < maxScan; i++) {
    const row = values[i] || [];
    if (isSkuHeaderCell(row[1]) || isSkuHeaderCell(row[0])) {
      return {
        index: i,
        row: row.map((h) => (h == null ? '' : String(h))),
      };
    }
  }
  return {
    index: 0,
    row: (values[0] || []).map((h) => (h == null ? '' : String(h))),
  };
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
 * Pure parser — unit-testable without Google APIs.
 */
function parseInventorySheetValues(values = [], options = {}) {
  if (!values.length) {
    return { rows: [], skipped: [], meta: { rowCount: 0, positiveQtyCount: 0 } };
  }

  const todayLabel = options.todayLabel || formatSheetDate(new Date());
  const preferColumnC = options.preferColumnC !== false;
  const blankAsZero = options.blankAsZero !== false;
  const headerInfo = findHeaderRow(values);
  const header = headerInfo.row;
  const column = resolveInventoryColumn(header, todayLabel, {
    preferColumnC,
    mode: preferColumnC ? 'column_c' : 'latest_date',
  });
  if (!column) {
    throw new Error('No inventory column found (expected Column C / Inventory)');
  }

  let skuIndex = 1;
  if (isSkuHeaderCell(header[0]) && !isSkuHeaderCell(header[1])) skuIndex = 0;
  else if (isSkuHeaderCell(header[1])) skuIndex = 1;

  const rows = [];
  const skipped = [];
  const seen = new Set();
  const startIdx = headerInfo.index + 1;

  for (let i = startIdx; i < values.length; i++) {
    const row = values[i] || [];
    const displaySku = cellText(row[skuIndex]);
    const sku = normalizeSkuKey(displaySku);
    if (!sku) {
      if (i <= headerInfo.index + 2) continue;
      skipped.push({ row: i + 1, reason: 'missing_sku' });
      continue;
    }
    if (sku === 'SKU_CODE' || sku === 'INVENTORY' || sku === 'SKU' || sku === 'DATE') continue;
    if (isInventoryHeaderCell(displaySku)) continue;

    if (seen.has(sku)) {
      skipped.push({ row: i + 1, internalSku: displaySku, reason: 'duplicate_sku_in_sheet' });
      continue;
    }
    seen.add(sku);

    const rawQty = row[column.index];
    const parsed = parseQuantityCell(rawQty);
    if (!parsed.ok) {
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
      headerRowIndex: headerInfo.index,
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
    },
  };
}

function scoreParsedInventory(parsed) {
  if (!parsed?.rows?.length) return -1;
  const positive = Number(parsed.meta?.positiveQtyCount || 0);
  const rows = Number(parsed.meta?.rowCount || 0);
  // Never prefer a tab of all zeros/blanks over a tab that actually has stock.
  if (positive <= 0) return rows > 0 ? 1 : -1;
  return positive * 1000 + rows;
}

function buildSheetCandidates(preferredName, availableTabs = []) {
  const preferred = String(preferredName || '').trim();
  const ordered = [];
  const push = (name) => {
    const n = String(name || '').trim();
    if (!n) return;
    if (!ordered.some((x) => x.toLowerCase() === n.toLowerCase())) ordered.push(n);
  };
  push(preferred);
  for (const name of DEFAULT_SHEET_CANDIDATES) push(name);
  for (const title of availableTabs) {
    const lower = String(title || '').toLowerCase();
    if (
      lower.includes('inventory') ||
      lower.includes('autofetch') ||
      lower.includes('stock') ||
      lower.includes('fc')
    ) {
      push(title);
    }
  }
  if (availableTabs.length) {
    const byLower = new Map(availableTabs.map((t) => [String(t).toLowerCase(), t]));
    return ordered
      .map((name) => byLower.get(name.toLowerCase()) || null)
      .filter(Boolean);
  }
  return ordered;
}

async function listSpreadsheetTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'spreadsheetId,properties.title,sheets.properties.title',
  });
  const titles = (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
  return {
    spreadsheetTitle: meta.data.properties?.title || null,
    availableTabs: titles,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 3, delayMs = 2000, label = 'operation' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[InventorySheets] ${label} attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

async function readSheetValues(sheets, spreadsheetId, sheetName, { previewRows = null } = {}) {
  const escaped = escapeSheetName(sheetName);
  // Only A:C — AutoFetch can have dozens of date columns; full-sheet reads time out on Cloud Run.
  const range = previewRows
    ? `'${escaped}'!A1:C${Math.max(20, previewRows)}`
    : `'${escaped}'!A:C`;
  const read = await withRetry(
    () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    }),
    { label: `read ${sheetName} ${range}` }
  );
  return read.data.values || [];
}

/**
 * Fetch inventory sheet in batches of `batchSize` rows with `pauseMs` between batches.
 * Prevents Google API rate limits on large AutoFetch / Total Inventory tabs.
 */
async function readSheetValuesBatched(sheets, spreadsheetId, sheetName, {
  batchSize = 2000,
  pauseMs = 2000,
  maxRows = 200000,
} = {}) {
  const size = Math.max(100, Math.min(5000, Number(batchSize) || 2000));
  const pause = Math.max(0, Number(pauseMs) || 0);
  const escaped = escapeSheetName(sheetName);
  const all = [];
  let start = 1;
  let batchIndex = 0;

  while (start <= maxRows) {
    if (batchIndex > 0 && pause > 0) {
      await sleep(pause);
    }
    const end = start + size - 1;
    const range = `'${escaped}'!A${start}:C${end}`;
    const values = await withRetry(
      async () => {
        const read = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          majorDimension: 'ROWS',
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'FORMATTED_STRING',
        });
        return read.data.values || [];
      },
      { retries: 4, delayMs: Math.max(2000, pause || 2000), label: `batch ${sheetName} ${range}` }
    );

    if (!values.length) break;
    all.push(...values);
    batchIndex += 1;
    console.log(
      `[InventorySheets] ${sheetName} batch ${batchIndex}: rows ${start}-${start + values.length - 1} (got ${values.length})`
    );
    // Partial batch ⇒ end of sheet
    if (values.length < size) break;
    start += size;
  }

  return {
    values: all,
    batchCount: batchIndex,
    batchSize: size,
    pauseMs: pause,
  };
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
    const { spreadsheetTitle, availableTabs } = await listSpreadsheetTabs(sheets, spreadsheetId);
    const candidates = buildSheetCandidates(sheetName, availableTabs);
    if (!candidates.length) {
      return {
        ok: false,
        error: `No inventory tabs found. Available tabs: ${availableTabs.join(', ') || '(none)'}`,
        connection: creds,
        spreadsheetTitle,
        availableTabs,
      };
    }

    let best = null;
    const tried = [];
    // Read A:C only (not every date column) so 10k-row tabs stay fast on Cloud Run.
    for (const title of candidates.slice(0, 8)) {
      try {
        const values = await readSheetValues(sheets, spreadsheetId, title);
        const parsed = parseInventorySheetValues(values, { preferColumnC: true, blankAsZero: true });
        const score = scoreParsedInventory(parsed);
        const sampleRows = (parsed.rows || [])
          .filter((r) => Number(r.quantity) > 0)
          .slice(0, 5)
          .map((r) => ({ sku: r.displaySku, columnC: r.quantity, blank: false }));
        const ej = (parsed.rows || []).find((r) => r.internalSku === 'EJ1201-16001');
        if (ej && !sampleRows.some((s) => normalizeSkuKey(s.sku) === 'EJ1201-16001')) {
          sampleRows.unshift({ sku: ej.displaySku, columnC: ej.quantity, blank: Boolean(ej.blank) });
        }
        const entry = {
          sheetName: title,
          score,
          rowCount: parsed.meta.rowCount,
          positiveQtyCount: parsed.meta.positiveQtyCount,
          sampleRows,
          columnReason: parsed.meta.columnReason,
          inventoryColumnLabel: parsed.meta.inventoryColumnLabel,
        };
        tried.push(entry);
        if (!best || entry.score > best.score) best = entry;
      } catch (err) {
        tried.push({ sheetName: title, error: err.message, score: -1 });
      }
    }

    if (!best || best.score < 0) {
      return {
        ok: false,
        error: `Could not read inventory from tabs: ${candidates.join(', ')}. Available: ${availableTabs.join(', ') || '(none)'}`,
        connection: creds,
        spreadsheetTitle,
        availableTabs,
        tried,
      };
    }

    if ((best.positiveQtyCount || 0) <= 0) {
      return {
        ok: false,
        error:
          `Connected to "${spreadsheetTitle || spreadsheetId}" but Column C has no positive stock on tabs tried (${tried.map((t) => t.sheetName).filter(Boolean).join(', ') || 'none'}). ` +
          'Open the workbook tab where EJ1201-16001 = 955 (sku_code + Inventory columns) and set that tab name in Inventory Planning → Admin Settings, then Sync again.',
        connection: creds,
        spreadsheetTitle,
        availableTabs,
        sheetName: best.sheetName,
        sampleRows: best.sampleRows || [],
        tried,
      };
    }

    return {
      ok: true,
      connection: creds,
      spreadsheetTitle,
      availableTabs,
      sheetName: best.sheetName,
      sampleRows: best.sampleRows,
      positiveQtyCount: best.positiveQtyCount,
      rowCount: best.rowCount,
      tried,
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
 * Read inventory rows from the best matching workbook tab.
 * Large tabs are fetched in batches of 2000 rows with a 2s pause between batches.
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

  let availableTabs = [];
  let spreadsheetTitle = null;
  try {
    const meta = await listSpreadsheetTabs(sheets, spreadsheetId);
    availableTabs = meta.availableTabs;
    spreadsheetTitle = meta.spreadsheetTitle;
  } catch (err) {
    throw new Error(formatGoogleSheetsApiError(err, {
      spreadsheetId,
      clientEmail: creds.sheetsClientEmail,
    }));
  }

  const preferColumnC = options.preferColumnC !== false;
  const blankAsZero = options.blankAsZero !== false;
  const batchSize = options.batchSize || Number(process.env.INVENTORY_SHEET_BATCH_SIZE) || 2000;
  const pauseMs = options.pauseMs != null
    ? Number(options.pauseMs)
    : Number(process.env.INVENTORY_SHEET_BATCH_PAUSE_MS || 2000);
  const candidates = buildSheetCandidates(sheetName || 'AutoFetch', availableTabs);
  if (!candidates.length) {
    throw new Error(
      `No inventory tabs found in spreadsheet${spreadsheetTitle ? ` "${spreadsheetTitle}"` : ''}.`
    );
  }

  // 1) Score tabs using a fast sample (first 500 rows) — then fully batch-read the winner.
  let bestTitle = null;
  let bestSampleScore = -1;
  const tried = [];
  for (const title of candidates.slice(0, 8)) {
    try {
      const sampleValues = await readSheetValues(sheets, spreadsheetId, title, { previewRows: 500 });
      if (sampleValues.length < 2) {
        tried.push({ sheetName: title, error: 'too few rows', score: -1, phase: 'sample' });
        continue;
      }
      const sampleParsed = parseInventorySheetValues(sampleValues, { preferColumnC, blankAsZero });
      const score = scoreParsedInventory(sampleParsed);
      tried.push({
        sheetName: title,
        score,
        rowCount: sampleParsed.meta.rowCount,
        positiveQtyCount: sampleParsed.meta.positiveQtyCount,
        columnReason: sampleParsed.meta.columnReason,
        phase: 'sample',
      });
      if (score > bestSampleScore) {
        bestSampleScore = score;
        bestTitle = title;
      }
    } catch (err) {
      tried.push({ sheetName: title, error: err.message, score: -1, phase: 'sample' });
    }
  }

  if (!bestTitle) {
    throw new Error(
      `No inventory SKU rows found. Tried tabs: ${candidates.join(', ')}. ` +
        'Check sku_code (Column B) and Inventory (Column C).'
    );
  }

  // 2) Full batched read of the winning tab
  let batched;
  try {
    batched = await readSheetValuesBatched(sheets, spreadsheetId, bestTitle, {
      batchSize,
      pauseMs,
    });
  } catch (err) {
    throw new Error(formatGoogleSheetsApiError(err, {
      spreadsheetId,
      clientEmail: creds.sheetsClientEmail,
    }));
  }

  if ((batched.values || []).length < 2) {
    throw new Error(`Sheet "${bestTitle}" has no header/data rows after batched read`);
  }

  const parsed = parseInventorySheetValues(batched.values, { preferColumnC, blankAsZero });
  const score = scoreParsedInventory(parsed);
  tried.push({
    sheetName: bestTitle,
    score,
    rowCount: parsed.meta.rowCount,
    positiveQtyCount: parsed.meta.positiveQtyCount,
    columnReason: parsed.meta.columnReason,
    phase: 'full_batched',
    batchCount: batched.batchCount,
  });

  if (!parsed.rows.length) {
    throw new Error(
      `No inventory SKU rows found on "${bestTitle}". Check sku_code (Column B) and Inventory (Column C).`
    );
  }

  if ((parsed.meta.positiveQtyCount || 0) === 0) {
    console.warn(
      `[InventorySheets] Selected tab "${bestTitle}" has 0 positive qty across ${parsed.meta.rowCount} SKUs. Tried: ${JSON.stringify(tried)}`
    );
  }

  return {
    rows: parsed.rows,
    skipped: parsed.skipped,
    meta: {
      ...parsed.meta,
      fetchedAt: new Date().toISOString(),
      sheetName: bestTitle,
      requestedSheetName: sheetName || null,
      spreadsheetId,
      spreadsheetTitle,
      availableTabs,
      triedTabs: tried,
      batchCount: batched.batchCount,
      batchSize: batched.batchSize,
      pauseMs: batched.pauseMs,
      serviceAccountEmail: creds.sheetsClientEmail,
    },
  };
}

module.exports = {
  getSheetsClient,
  escapeSheetName,
  withRetry,
  isSheetsConfigured,
  isSheetsReady,
  isSheetsEnvPresent,
  getSheetsCredentialStatus,
  parseServiceAccount,
  formatSheetDate,
  parseSheetDateLabel,
  resolveInventoryColumn,
  findHeaderRow,
  parseQuantityCell,
  parseInventorySheetValues,
  buildSheetCandidates,
  formatGoogleSheetsApiError,
  probeSheetAccess,
  fetchInventoryFromSheet,
  readSheetValuesBatched,
  DEFAULT_SHEET_CANDIDATES,
};
