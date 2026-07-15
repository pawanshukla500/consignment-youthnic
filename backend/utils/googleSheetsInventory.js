/**
 * Google Sheets updater for OMSGuru AutoFetch inventory.
 *
 * Observed AutoFetch layout (not a static Col C quantity):
 *   Row 1: id | sku_code | <DD/MM/YYYY> | <DD/MM/YYYY> | …
 *   Row 2:    |          | Inventory    | Inventory    | …
 *
 * Strategy:
 * 1. Match rows by sku_code (column B) — never insert a duplicate SKU.
 * 2. Ensure today's date column exists (insert after sku_code when missing).
 * 3. Write quantity into today's Inventory cell.
 * 4. Skip blank/invalid quantities.
 */

const { google } = require('googleapis');

function isSheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

function parseServiceAccount() {
  const raw =
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS_JSON ||
    '';
  if (raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }
  return null;
}

async function getSheetsClient() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
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

function colIndexToA1(colIndex1Based) {
  let n = colIndex1Based;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeSheetName(name) {
  return String(name || 'AutoFetch').replace(/'/g, "''");
}

/**
 * Upsert inventory quantities into AutoFetch.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {Array<{internalSku: string, quantity: number}>} rows
 */
async function upsertInventoryToSheet(spreadsheetId, sheetName, rows) {
  if (!isSheetsConfigured()) {
    throw new Error('Google Sheets is not configured');
  }
  if (!spreadsheetId) throw new Error('Google Sheet ID is required');

  const sheets = await getSheetsClient();
  const title = sheetName || 'AutoFetch';
  const escaped = escapeSheetName(title);
  const todayLabel = formatSheetDate(new Date());

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escaped}'`,
    majorDimension: 'ROWS',
  });

  const values = read.data.values || [];
  const header = values[0] || ['id', 'sku_code'];
  const subHeader = values[1] || [];

  // Ensure id + sku_code headers
  if (!header[0]) header[0] = 'id';
  if (!header[1]) header[1] = 'sku_code';

  let dateColIndex = header.findIndex((h, idx) => idx >= 2 && String(h || '').trim() === todayLabel);
  const dataUpdates = [];
  let insertedColumn = false;

  if (dateColIndex < 0) {
    // Insert today's column at C (index 2)
    dateColIndex = 2;
    insertedColumn = true;
    // Shift existing headers in memory for local map; Sheets API insertDimension handles sheet
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const sheet = (meta.data.sheets || []).find((s) => s.properties.title === title);
    if (!sheet) throw new Error(`Sheet tab "${title}" not found`);
    const sheetId = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 2,
                endIndex: 3,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });

    // Re-read after insert
    const again = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${escaped}'!A1:ZZ2`,
      majorDimension: 'ROWS',
    });
    const h2 = again.data.values?.[0] || header;
    const s2 = again.data.values?.[1] || subHeader;
    h2[2] = todayLabel;
    s2[2] = 'Inventory';
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${escaped}'!A1:${colIndexToA1(Math.max(h2.length, 3))}2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [h2, s2] },
    });
  } else {
    // Ensure sub-header says Inventory
    if (String(subHeader[dateColIndex] || '').trim().toLowerCase() !== 'inventory') {
      dataUpdates.push({
        range: `'${escaped}'!${colIndexToA1(dateColIndex + 1)}2`,
        values: [['Inventory']],
      });
    }
  }

  // Build sku → row index map (1-based sheet rows). Data starts at row 3 typically.
  const refreshed = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escaped}'!A:B`,
    majorDimension: 'ROWS',
  });
  const ab = refreshed.data.values || [];
  const skuToRow = new Map();
  let maxId = 0;
  for (let i = 0; i < ab.length; i++) {
    const rowNum = i + 1;
    if (rowNum <= 2) {
      const maybeId = Number(ab[i]?.[0]);
      if (Number.isFinite(maybeId)) maxId = Math.max(maxId, maybeId);
      continue;
    }
    const idVal = Number(ab[i]?.[0]);
    if (Number.isFinite(idVal)) maxId = Math.max(maxId, idVal);
    const sku = String(ab[i]?.[1] || '').trim();
    if (sku && !skuToRow.has(sku)) skuToRow.set(sku, rowNum);
  }

  const colLetter = colIndexToA1(dateColIndex + 1);
  const valueData = [];
  const appendRows = [];
  let updated = 0;
  let appended = 0;
  let skipped = 0;

  for (const item of rows || []) {
    const sku = String(item.internalSku || '').trim();
    const qty = item.quantity;
    if (!sku) {
      skipped += 1;
      continue;
    }
    if (qty === null || qty === undefined || qty === '' || !Number.isFinite(Number(qty)) || Number(qty) < 0) {
      skipped += 1;
      continue;
    }
    const safeQty = Math.floor(Number(qty));
    const existingRow = skuToRow.get(sku);
    if (existingRow) {
      valueData.push({
        range: `'${escaped}'!${colLetter}${existingRow}`,
        values: [[safeQty]],
      });
      updated += 1;
    } else {
      maxId += 1;
      appendRows.push([maxId, sku, safeQty]);
      skuToRow.set(sku, ab.length + appendRows.length);
      appended += 1;
    }
  }

  if (valueData.length) {
    // batchUpdate in chunks
    const chunkSize = 400;
    for (let i = 0; i < valueData.length; i += chunkSize) {
      const chunk = valueData.slice(i, i + chunkSize);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        },
      });
    }
  }

  if (appendRows.length) {
    // Append with id, sku, and today qty in col C position — pad for dateColIndex
    const padded = appendRows.map(([id, sku, qty]) => {
      const row = [id, sku];
      while (row.length < dateColIndex) row.push('');
      row[dateColIndex] = qty;
      return row;
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${escaped}'!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: padded },
    });
  }

  if (dataUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: dataUpdates },
    });
  }

  return {
    updated,
    appended,
    skipped,
    insertedColumn,
    todayLabel,
    dateColumn: colLetter,
  };
}

module.exports = {
  isSheetsConfigured,
  formatSheetDate,
  colIndexToA1,
  upsertInventoryToSheet,
};
