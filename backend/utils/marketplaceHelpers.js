/**
 * Marketplace warehouse model — supports legacy string[] and
 * { name, transitDays, address, state, gst }[].
 */

/** Common Indian state / UT names and short codes (soft validation). */
const INDIAN_STATES = new Set([
  'andaman and nicobar islands', 'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar',
  'chandigarh', 'chhattisgarh', 'dadra and nagar haveli and daman and diu', 'delhi',
  'goa', 'gujarat', 'haryana', 'himachal pradesh', 'jammu and kashmir', 'jharkhand',
  'karnataka', 'kerala', 'ladakh', 'lakshadweep', 'madhya pradesh', 'maharashtra',
  'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'puducherry', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh',
  'uttarakhand', 'west bengal',
  'an', 'ap', 'ar', 'as', 'br', 'ch', 'ct', 'dn', 'dd', 'dl', 'ga', 'gj', 'hr', 'hp',
  'jk', 'jh', 'ka', 'kl', 'la', 'ld', 'mp', 'mh', 'mn', 'ml', 'mz', 'nl', 'or', 'py',
  'pb', 'rj', 'sk', 'tn', 'tg', 'tr', 'up', 'uk', 'wb',
]);

/** GSTIN: 15 chars — state(2) + PAN(10) + entity(1) + Z + checksum(1). */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;

function normalizeWarehouses(warehouses) {
  if (!Array.isArray(warehouses)) return [];
  return warehouses
    .map((w) => {
      if (typeof w === 'string') {
        const name = w.trim();
        return name ? { name, transitDays: 0, address: '', state: '', gst: '' } : null;
      }
      if (w && typeof w === 'object') {
        const name = String(w.name || '').trim();
        if (!name) return null;
        const transitDays = Math.max(0, parseInt(w.transitDays, 10) || 0);
        const address = String(w.address || '').trim();
        const state = String(w.state || '').trim();
        const gst = String(w.gst || '').trim().toUpperCase();
        return { name, transitDays, address, state, gst };
      }
      return null;
    })
    .filter(Boolean);
}

function getWarehouseNames(warehouses) {
  return normalizeWarehouses(warehouses).map((w) => w.name);
}

function getTransitDays(marketplace, warehouseName) {
  if (!marketplace || !warehouseName) return 0;
  const wh = normalizeWarehouses(marketplace.warehouses).find((w) => w.name === warehouseName);
  return wh?.transitDays ?? 0;
}

function isValidGstin(gst) {
  const value = String(gst || '').trim();
  if (!value) return true;
  return GSTIN_RE.test(value);
}

function isRecognizedState(state) {
  const value = String(state || '').trim().toLowerCase();
  if (!value) return true;
  if (value.length > 48) return false;
  return INDIAN_STATES.has(value);
}

/**
 * Soft validation for warehouse address fields.
 * GST must match GSTIN when provided. State max length enforced.
 */
function validateWarehouseFields(warehouses) {
  const list = normalizeWarehouses(warehouses);
  for (const w of list) {
    if (w.gst && !isValidGstin(w.gst)) {
      return {
        ok: false,
        error: `Invalid GSTIN for warehouse "${w.name}". Use a 15-character GST number (e.g. 29AAAAA0000A1Z5).`,
      };
    }
    if (w.state && w.state.trim().length > 48) {
      return {
        ok: false,
        error: `State for warehouse "${w.name}" is too long (max 48 characters).`,
      };
    }
  }
  return { ok: true };
}

function sanitizeMarketplacePayload(body) {
  const warehouses = normalizeWarehouses(body.warehouses || []);
  return {
    name: String(body.name || '').trim(),
    billTo: String(body.billTo || '').trim(),
    warehouses,
  };
}

module.exports = {
  normalizeWarehouses,
  getWarehouseNames,
  getTransitDays,
  sanitizeMarketplacePayload,
  validateWarehouseFields,
  isValidGstin,
  isRecognizedState,
  GSTIN_RE,
};
