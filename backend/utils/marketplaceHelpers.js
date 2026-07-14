/**
 * Marketplace warehouse model — supports legacy string[] and { name, transitDays, address, gst }[].
 */

function normalizeWarehouses(warehouses) {
  if (!Array.isArray(warehouses)) return [];
  return warehouses
    .map((w) => {
      if (typeof w === 'string') {
        const name = w.trim();
        return name ? { name, transitDays: 0, address: '', gst: '' } : null;
      }
      if (w && typeof w === 'object') {
        const name = String(w.name || '').trim();
        if (!name) return null;
        const transitDays = Math.max(0, parseInt(w.transitDays, 10) || 0);
        const address = String(w.address || '').trim();
        const gst = String(w.gst || '').trim();
        return { name, transitDays, address, gst };
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
};
