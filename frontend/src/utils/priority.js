/**
 * Shipment criticality — dispatch deadline + transit + packing progress.
 */

export function getPackingPercent(consignment) {
  const required = consignment?.totalRequiredQty || 0
  const packed = consignment?.totalPackedQty || 0
  if (required <= 0) return consignment?.status === 'completed' ? 100 : 0
  return Math.min(100, Math.round((packed / required) * 100))
}

const LEVEL_STYLES = {
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
  warning: {
    label: 'High Priority',
    badgeClass: 'bg-orange-100 text-orange-800 border-orange-200',
    dotClass: 'bg-orange-500',
    sortBase: -500,
  },
}

function parseDaysUntil(consignment) {
  if (consignment?.daysUntilDispatch !== undefined && consignment?.daysUntilDispatch !== null) {
    return consignment.daysUntilDispatch
  }
  const dispatchDate =
    consignment?.requiredDispatchDate ||
    consignment?.scheduledDispatchDate ||
    ''
  if (!dispatchDate) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dispatch = new Date(dispatchDate)
  if (Number.isNaN(dispatch.getTime())) return null
  dispatch.setHours(0, 0, 0, 0)
  return Math.round((dispatch - today) / 86400000)
}

function getDisplayLabel(level, daysUntil) {
  if (level === 'critical') return daysUntil !== null && daysUntil < 0 ? 'Delayed' : 'Critical'
  if (level === 'high') return 'At Risk'
  if (level === 'medium') return 'Attention'
  return 'On Track'
}

function buildSublabel(level, daysUntil, packingPercent) {
  if (daysUntil === null) return `Packed ${packingPercent}%`
  if (daysUntil < 0) return `${Math.abs(daysUntil)}d overdue · ${packingPercent}% packed`
  if (daysUntil === 0) return `Dispatch today · ${packingPercent}% packed`
  return `Dispatch in ${daysUntil}d · ${packingPercent}% packed`
}

export function getShipmentPriority(consignment) {
  const packingPercent = consignment?.packingPercent ?? getPackingPercent(consignment)
  const daysUntil = parseDaysUntil(consignment)

  const levelKey = consignment?.criticalityLevel || consignment?.priorityLevel
  if (levelKey && (consignment?.criticalityLabel || consignment?.priorityLabel)) {
    const level = levelKey === 'warning' ? 'high' : levelKey
    const styles = LEVEL_STYLES[level] || LEVEL_STYLES.normal
    return {
      level,
      label: consignment.criticalityLabel || consignment.priorityLabel,
      displayLabel: consignment.criticalityDisplayLabel || consignment.priorityDisplayLabel || getDisplayLabel(level, daysUntil),
      sublabel: consignment.criticalitySublabel || consignment.prioritySublabel || '',
      sort: consignment.criticalitySort ?? consignment.daysUntilDispatch ?? styles.sortBase,
      isCritical: consignment.isCritical ?? level === 'critical',
      packingPercent,
      daysUntilDispatch: daysUntil,
      badgeClass: styles.badgeClass,
      dotClass: styles.dotClass,
    }
  }

  if (consignment?.status === 'completed') {
    const styles = LEVEL_STYLES.normal
    return {
      level: 'normal',
      label: styles.label,
      displayLabel: 'On Track',
      sublabel: 'Fully packed',
      sort: styles.sortBase,
      isCritical: false,
      packingPercent,
      daysUntilDispatch: daysUntil,
      badgeClass: styles.badgeClass,
      dotClass: styles.dotClass,
    }
  }

  if (daysUntil === null) {
    const styles = LEVEL_STYLES.normal
    return {
      level: 'normal',
      label: styles.label,
      displayLabel: 'On Track',
      sublabel: packingPercent > 0 ? `${packingPercent}% packed · no dispatch date` : 'No dispatch deadline',
      sort: styles.sortBase + (100 - packingPercent),
      isCritical: false,
      packingPercent,
      daysUntilDispatch: null,
      badgeClass: styles.badgeClass,
      dotClass: styles.dotClass,
    }
  }

  let level = 'normal'
  if (daysUntil < 0 || (daysUntil <= 2 && packingPercent < 100)) {
    level = 'critical'
  } else if ((daysUntil <= 4 && packingPercent < 80) || (daysUntil <= 3 && packingPercent < 100)) {
    level = 'high'
  } else if (daysUntil <= 7 || (daysUntil <= 5 && packingPercent < 50)) {
    level = 'medium'
  }

  const styles = LEVEL_STYLES[level]
  return {
    level,
    label: styles.label,
    displayLabel: getDisplayLabel(level, daysUntil),
    sublabel: buildSublabel(level, daysUntil, packingPercent),
    sort: styles.sortBase + daysUntil + (100 - packingPercent) * 0.05,
    isCritical: level === 'critical',
    packingPercent,
    daysUntilDispatch: daysUntil,
    badgeClass: styles.badgeClass,
    dotClass: styles.dotClass,
  }
}

export function sortByPriority(consignments) {
  return [...consignments].sort((a, b) => {
    const pa = getShipmentPriority(a)
    const pb = getShipmentPriority(b)
    if (pa.sort !== pb.sort) return pa.sort - pb.sort
    const da = a.requiredDispatchDate ? new Date(a.requiredDispatchDate).getTime() : Infinity
    const db = b.requiredDispatchDate ? new Date(b.requiredDispatchDate).getTime() : Infinity
    if (da !== db) return da - db
    return (a.internalShipmentNo || a.id || '').localeCompare(b.internalShipmentNo || b.id || '')
  })
}

export function formatAppointmentDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return d
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDispatchDate(d) {
  return formatAppointmentDate(d)
}
