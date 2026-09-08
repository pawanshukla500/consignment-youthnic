const { getTransitDays } = require('./marketplaceHelpers');
const { getShipmentCriticality, sortByCriticality } = require('./criticality');

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateOnly(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function subtractDays(dateStr, days) {
  const d = parseDateOnly(dateStr);
  if (!d || !days) return '';
  d.setDate(d.getDate() - days);
  return formatDateOnly(d);
}

function computeRequiredDispatchDate(appointmentDate, transitDays) {
  if (!appointmentDate || !transitDays) return '';
  return subtractDays(appointmentDate, transitDays);
}

function getDispatchPriorityMeta(consignment) {
  const c = getShipmentCriticality(consignment);
  return {
    level: c.level,
    label: c.label,
    sublabel: c.sublabel,
    sort: c.sort,
    daysUntilDispatch: c.daysUntilDispatch,
    isCritical: c.isCritical,
    packingPercent: c.packingPercent,
  };
}

function enrichConsignment(consignment, marketplaceMap = {}) {
  if (!consignment) return consignment;
  const marketplace = marketplaceMap[consignment.marketplaceId] || null;
  const transitDays = getTransitDays(marketplace, consignment.warehouse);
  const computedDispatch = computeRequiredDispatchDate(consignment.appointmentDate, transitDays);

  const requiredDispatchDate = computedDispatch || consignment.requiredDispatchDate || consignment.scheduledDispatchDate || '';
  const scheduledDispatchDate = computedDispatch || consignment.scheduledDispatchDate || '';

  const planning = {
    transitDays,
    requiredDispatchDate,
    scheduledDispatchDate: scheduledDispatchDate || consignment.scheduledDispatchDate || '',
    marketplaceName: marketplace?.name || '',
  };

  const withPlanning = { ...consignment, ...planning };
  const criticality = getShipmentCriticality(withPlanning);

  return {
    ...withPlanning,
    packingPercent: criticality.packingPercent,
    isCritical: criticality.isCritical,
    criticalityLevel: criticality.level,
    criticalityLabel: criticality.label,
    criticalityDisplayLabel: criticality.displayLabel,
    criticalitySublabel: criticality.sublabel,
    criticalitySort: criticality.sort,
    priorityLevel: criticality.level,
    priorityLabel: criticality.label,
    priorityDisplayLabel: criticality.displayLabel,
    prioritySublabel: criticality.sublabel,
    daysUntilDispatch: criticality.daysUntilDispatch,
    readinessStatus:
      consignment.status === 'completed'
        ? 'ready'
        : (consignment.totalPackedQty || 0) > 0
          ? 'packing'
          : 'awaiting_pack',
  };
}

const { getMarketplaceCache, setMarketplaceCache } = require('./reportingCache');

async function buildMarketplaceMap(firestoreHelpers) {
  const cached = getMarketplaceCache();
  if (cached) return cached;

  const marketplaces = await firestoreHelpers.getCollection('marketplaces');
  const map = {};
  marketplaces.forEach((m) => { map[m.id] = m; });
  setMarketplaceCache(map);
  return map;
}

function sortByDispatchPriority(consignments) {
  return sortByCriticality(consignments);
}

module.exports = {
  computeRequiredDispatchDate,
  getDispatchPriorityMeta,
  enrichConsignment,
  buildMarketplaceMap,
  sortByDispatchPriority,
  formatDateOnly,
};
