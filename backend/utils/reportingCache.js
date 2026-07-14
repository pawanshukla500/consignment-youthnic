/**
 * Lightweight in-process caches for reporting endpoints.
 * Cloud Run instances each hold their own cache; TTLs are short by design.
 */

const dashboardCache = { payload: null, expiresAt: 0 };
const marketplaceCache = { map: null, expiresAt: 0 };

const DASHBOARD_TTL_MS = 30_000;
const MARKETPLACE_TTL_MS = 120_000;

function getDashboardCache() {
  if (dashboardCache.payload && Date.now() < dashboardCache.expiresAt) {
    return dashboardCache.payload;
  }
  return null;
}

function setDashboardCache(payload) {
  dashboardCache.payload = payload;
  dashboardCache.expiresAt = Date.now() + DASHBOARD_TTL_MS;
}

function invalidateDashboardCache() {
  dashboardCache.payload = null;
  dashboardCache.expiresAt = 0;
}

function getMarketplaceCache() {
  if (marketplaceCache.map && Date.now() < marketplaceCache.expiresAt) {
    return marketplaceCache.map;
  }
  return null;
}

function setMarketplaceCache(map) {
  marketplaceCache.map = map;
  marketplaceCache.expiresAt = Date.now() + MARKETPLACE_TTL_MS;
}

function invalidateMarketplaceCache() {
  marketplaceCache.map = null;
  marketplaceCache.expiresAt = 0;
}

module.exports = {
  DASHBOARD_TTL_MS,
  getDashboardCache,
  setDashboardCache,
  invalidateDashboardCache,
  getMarketplaceCache,
  setMarketplaceCache,
  invalidateMarketplaceCache,
};
