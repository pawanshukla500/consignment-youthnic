/**
 * UI helpers for shipment criticality — row highlights, badges, progress bars.
 */

export function getDisplayLabel(priority) {
  if (!priority) return 'On Track'
  if (priority.displayLabel) return priority.displayLabel
  const level = priority.level
  const days = priority.daysUntilDispatch ?? null
  if (level === 'critical') return days !== null && days < 0 ? 'Delayed' : 'Critical'
  if (level === 'high') return 'At Risk'
  if (level === 'medium') return 'Attention'
  return priority.label || 'On Track'
}

export function getCriticalityRowClass(priority, { selected, editing } = {}) {
  if (selected) return 'bg-slate-100/90'
  if (editing) return 'bg-slate-50/80'
  const level = priority?.level
  if (level === 'critical') return 'bg-red-50/90 hover:bg-red-50 animate-critical-row border-l-[3px] border-l-red-500'
  if (level === 'high') return 'bg-orange-50/70 hover:bg-orange-50/90 border-l-[3px] border-l-orange-400'
  if (level === 'medium') return 'bg-amber-50/60 hover:bg-amber-50/80 border-l-[3px] border-l-amber-400'
  return 'hover:bg-slate-50/80'
}

export function getCriticalityCardClass(priority) {
  const level = priority?.level
  if (level === 'critical') return 'border-red-200 bg-red-50/50 hover:border-red-300 animate-critical-row'
  if (level === 'high') return 'border-orange-200 bg-orange-50/40 hover:border-orange-300'
  if (level === 'medium') return 'border-amber-200 bg-amber-50/40 hover:border-amber-300'
  return 'border-slate-100 bg-slate-50/50 hover:border-primary-200'
}

export function getProgressBarColor(priority) {
  const level = priority?.level
  if (level === 'critical') return 'bg-red-500'
  if (level === 'high') return 'bg-orange-500'
  if (level === 'medium') return 'bg-amber-500'
  if ((priority?.packingPercent ?? 0) >= 100) return 'bg-emerald-500'
  return 'bg-primary-500'
}

export function getUnitsProgressPercent(consignment) {
  if (consignment?.packingPercent != null) return consignment.packingPercent
  const required = consignment?.totalRequiredQty || 0
  const packed = consignment?.totalPackedQty || 0
  if (required <= 0) return consignment?.status === 'completed' ? 100 : 0
  return Math.min(100, Math.round((packed / required) * 100))
}
