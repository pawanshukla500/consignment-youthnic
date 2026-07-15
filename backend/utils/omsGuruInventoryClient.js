/**
 * OMSGuru inventory API client.
 *
 * Official public inventory endpoint shapes vary by tenant. Configure via env:
 *   OMSGURU_API_BASE_URL
 *   OMSGURU_API_KEY / OMSGURU_API_TOKEN
 *   OMSGURU_INVENTORY_PATH (default /api/v1/inventory)
 *   OMSGURU_AUTH_HEADER (default Authorization)
 *   OMSGURU_AUTH_SCHEME (default Bearer) — set empty for raw key header
 *
 * Response rows are normalized to { internalSku, quantity, productName }.
 * Invalid / blank quantities are skipped (never overwrite good stock with blank).
 */

const { normalizeSkuKey, toNonNegInt } = require('./inventoryPlanning');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfigured() {
  return Boolean(
    process.env.OMSGURU_API_BASE_URL &&
    (process.env.OMSGURU_API_KEY || process.env.OMSGURU_API_TOKEN)
  );
}

function buildAuthHeaders() {
  const key = process.env.OMSGURU_API_KEY || process.env.OMSGURU_API_TOKEN || '';
  const headerName = process.env.OMSGURU_AUTH_HEADER || 'Authorization';
  const scheme = process.env.OMSGURU_AUTH_SCHEME;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (!key) return headers;
  if (scheme === '' || scheme === 'none') {
    headers[headerName] = key;
  } else {
    headers[headerName] = `${scheme || 'Bearer'} ${key}`.trim();
  }
  return headers;
}

function pickField(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function parseQuantity(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'blank' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'non_numeric' };
  if (n < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value: Math.floor(n) };
}

function normalizeInventoryRows(payload) {
  let rows = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    rows =
      payload.data ||
      payload.items ||
      payload.inventory ||
      payload.results ||
      payload.skus ||
      payload.records ||
      [];
  }
  if (!Array.isArray(rows)) return { rows: [], skipped: [{ reason: 'invalid_payload' }] };

  const out = [];
  const skipped = [];
  const seen = new Set();

  for (const item of rows) {
    if (!item || typeof item !== 'object') {
      skipped.push({ reason: 'invalid_row' });
      continue;
    }
    const skuRaw = pickField(item, [
      'internalSku',
      'internal_sku',
      'sku_code',
      'skuCode',
      'sku',
      'SKU',
      'SellerSku',
      'seller_sku',
    ]);
    const internalSku = normalizeSkuKey(skuRaw);
    if (!internalSku) {
      skipped.push({ reason: 'missing_sku', item });
      continue;
    }
    const qtyRaw = pickField(item, [
      'quantity',
      'inventory',
      'available',
      'availableQty',
      'available_qty',
      'qty',
      'stock',
      'onHand',
      'on_hand',
      'total_quantity',
      'totalQuantity',
    ]);
    const parsed = parseQuantity(qtyRaw);
    if (!parsed.ok) {
      skipped.push({ internalSku, reason: parsed.reason, raw: qtyRaw });
      continue;
    }
    if (seen.has(internalSku)) {
      // Prefer first valid row; avoid double-counting same SKU
      skipped.push({ internalSku, reason: 'duplicate_sku_in_response' });
      continue;
    }
    seen.add(internalSku);
    const productName = pickField(item, ['productName', 'product_name', 'name', 'title', 'description']) || '';
    out.push({
      internalSku,
      quantity: parsed.value,
      productName: String(productName || ''),
    });
  }

  return { rows: out, skipped };
}

async function fetchWithRetry(url, options, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 || res.status === 429) {
        const text = await res.text().catch(() => '');
        throw new Error(`OMSGuru HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`OMSGuru HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        err.fatal = res.status === 401 || res.status === 403;
        throw err;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      await sleep(500 * attempt * attempt);
    }
  }
  throw lastError;
}

/**
 * Fetch full inventory catalog from OMSGuru.
 * @returns {{ rows: Array<{internalSku, quantity, productName}>, skipped: Array, meta: object }}
 */
async function fetchOmsGuruInventory() {
  if (!isConfigured()) {
    throw new Error('OMSGuru API is not configured (set OMSGURU_API_BASE_URL and OMSGURU_API_KEY)');
  }

  const base = String(process.env.OMSGURU_API_BASE_URL).replace(/\/+$/, '');
  const path = process.env.OMSGURU_INVENTORY_PATH || '/api/v1/inventory';
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  const res = await fetchWithRetry(url, {
    method: 'GET',
    headers: buildAuthHeaders(),
  });

  const contentType = res.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('json')) {
    payload = await res.json();
  } else {
    const text = await res.text();
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('OMSGuru inventory response was not JSON');
    }
  }

  const { rows, skipped } = normalizeInventoryRows(payload);
  return {
    rows,
    skipped,
    meta: {
      fetchedAt: new Date().toISOString(),
      url,
      rowCount: rows.length,
      skippedCount: skipped.length,
    },
  };
}

module.exports = {
  isConfigured,
  parseQuantity,
  normalizeInventoryRows,
  fetchOmsGuruInventory,
  toNonNegInt,
};
