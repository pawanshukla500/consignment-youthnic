/**
 * Shipment criticality — combines dispatch deadline, transit planning, and packing progress.
 */

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function getPackingPercent(consignment) {
  const required = consignment?.totalRequiredQty || 0;
  const packed = consignment?.totalPackedQty || 0;
  if (required <= 0) {
    return consignment?.status === 'completed' ? 100 : 0;
  }
  return Math.min(100, Math.round((packed / required) * 100));
}

function getDaysUntilDispatch(consignment) {
  const dispatchDate =
    consignment?.requiredDispatchDate ||
    consignment?.scheduledDispatchDate ||
    '';
  if (!dispatchDate) return null;
  const today = parseDateOnly(new Date());
  const dispatch = parseDateOnly(dispatchDate);
  if (!today || !dispatch) return null;
  return Math.round((dispatch - today) / 86400000);
}

const LEVEL_META = {
  critical: {
    label: 'Critical',
    badgeClass: 'bg-red-100 text-red-800 border-red-200',
    dotClass: 'bg-red-500',
    sortBase: -2000,
  },
  high: {
    label: 'High Priority',
    badgeClass: 'bg-orange-100 text-orange-800 border-orange-200',
    dotClass: 'bg-orange-500',
    sortBase: -500,
  },
  medium: {
    label: 'Medium Priority',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
    dotClass: 'bg-amber-500',
    sortBase: 50,
  },
  normal: {
    label: 'Normal',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-400',
    sortBase: 500,
  },
};

function getDisplayLabel(level, daysUntil) {
  if (level === 'critical') return daysUntil !== null && daysUntil < 0 ? 'Delayed' : 'Critical';
  if (level === 'high') return 'At Risk';
  if (level === 'medium') return 'Attention';
  return LEVEL_META[level]?.label || 'On Track';
}

function buildSublabel(level, daysUntil, packingPercent) {
  if (daysUntil === null) return `Packed ${packingPercent}%`;
  if (daysUntil < 0) return `${Math.abs(daysUntil)}d overdue · ${packingPercent}% packed`;
  if (daysUntil === 0) return `Dispatch today · ${packingPercent}% packed`;
  if (level === 'critical') return `Dispatch in ${daysUntil}d · ${packingPercent}% packed`;
  if (level === 'high') return `Dispatch in ${daysUntil}d · ${packingPercent}% packed`;
  if (level === 'medium') return `Dispatch in ${daysUntil}d · ${packingPercent}% packed`;
  return `Dispatch in ${daysUntil}d · on track`;
}

function getShipmentCriticality(consignment) {
  const packingPercent = getPackingPercent(consignment);
  const daysUntil = getDaysUntilDispatch(consignment);

  if (consignment?.status === 'completed') {
    const meta = LEVEL_META.normal;
    return {
      level: 'normal',
      label: meta.label,
      displayLabel: 'On Track',
      isCritical: false,
      packingPercent,
      daysUntilDispatch: daysUntil,
      sublabel: 'Fully packed',
      sort: meta.sortBase,
      badgeClass: meta.badgeClass,
      dotClass: meta.dotClass,
    };
  }

  if (daysUntil === null) {
    const meta = LEVEL_META.normal;
    return {
      level: 'normal',
      label: meta.label,
      displayLabel: 'On Track',
      daysUntilDispatch: null,
      sublabel: packingPercent > 0 ? `${packingPercent}% packed · no dispatch date` : 'No dispatch deadline',
      sort: meta.sortBase + (100 - packingPercent),
      badgeClass: meta.badgeClass,
      dotClass: meta.dotClass,
    };
  }

  let level = 'normal';

  if (daysUntil < 0 || (daysUntil <= 2 && packingPercent < 100)) {
    level = 'critical';
  } else if ((daysUntil <= 4 && packingPercent < 80) || (daysUntil <= 3 && packingPercent < 100)) {
    level = 'high';
  } else if (daysUntil <= 7 || (daysUntil <= 5 && packingPercent < 50)) {
    level = 'medium';
  }

  const meta = LEVEL_META[level];
  const sort =
    meta.sortBase +
    daysUntil +
    (100 - packingPercent) * 0.05;

  return {
    level,
    label: meta.label,
    displayLabel: getDisplayLabel(level, daysUntil),
    isCritical: level === 'critical',
    packingPercent,
    daysUntilDispatch: daysUntil,
    sublabel: buildSublabel(level, daysUntil, packingPercent),
    sort,
    badgeClass: meta.badgeClass,
    dotClass: meta.dotClass,
  };
}

function sortByCriticality(consignments) {
  return [...consignments].sort((a, b) => {
    const ca = a.criticalitySort ?? getShipmentCriticality(a).sort;
    const cb = b.criticalitySort ?? getShipmentCriticality(b).sort;
    if (ca !== cb) return ca - cb;
    const da = a.requiredDispatchDate ? new Date(a.requiredDispatchDate).getTime() : Infinity;
    const db = b.requiredDispatchDate ? new Date(b.requiredDispatchDate).getTime() : Infinity;
    if (da !== db) return da - db;
    return (a.internalShipmentNo || a.id || '').localeCompare(b.internalShipmentNo || b.id || '');
  });
}

module.exports = {
  getPackingPercent,
  getDaysUntilDispatch,
  getShipmentCriticality,
  sortByCriticality,
  LEVEL_META,
};
