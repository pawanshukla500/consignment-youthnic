/**
 * Client-side dispatch planning (mirrors backend/utils/dispatchPlanning.js).
 */

export function normalizeWarehouses(warehouses) {
  if (!Array.isArray(warehouses)) return []
  return warehouses
    .map((w) => {
      if (typeof w === 'string') {
        const name = w.trim()
        return name ? { name, transitDays: 0, address: '', state: '', gst: '' } : null
      }
      if (w && typeof w === 'object') {
        const name = String(w.name || '').trim()
        if (!name) return null
        return {
          name,
          transitDays: Math.max(0, parseInt(w.transitDays, 10) || 0),
          address: String(w.address || '').trim(),
          state: String(w.state || '').trim(),
          gst: String(w.gst || '').trim(),
        }
      }
      return null
    })
    .filter(Boolean)
}

export function getTransitDays(marketplace, warehouseName) {
  if (!marketplace || !warehouseName) return 0
  const wh = normalizeWarehouses(marketplace.warehouses).find((w) => w.name === warehouseName)
  return wh?.transitDays ?? 0
}

function parseDateOnly(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return new Date(value.getFullYear(), value.getMonth(), value.getDate())
  }
  const text = String(value).trim()
  const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (parts) {
    const d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
}

function formatDateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function computeRequiredDispatchDate(appointmentDate, transitDays) {
  if (!appointmentDate || !transitDays) return ''
  const d = parseDateOnly(appointmentDate)
  if (!d) return ''
  d.setDate(d.getDate() - transitDays)
  return formatDateOnly(d)
}

export function applyDispatchDates(form, marketplaces = []) {
  const mp = (marketplaces || []).find((m) => m.id === form.marketplaceId)
  const transitDays = getTransitDays(mp, form.warehouse)
  const scheduledDispatchDate = computeRequiredDispatchDate(form.appointmentDate, transitDays)
  return { ...form, scheduledDispatchDate: scheduledDispatchDate || '' }
}

export function enrichConsignmentPlanning(consignment, marketplaces = []) {
  if (!consignment) return consignment
  const marketplace = marketplaces.find((m) => m.id === consignment.marketplaceId)
  const transitDays = getTransitDays(marketplace, consignment.warehouse)
  const computedDispatch = computeRequiredDispatchDate(consignment.appointmentDate, transitDays)
  const hasWarehouse = Boolean(String(consignment.warehouse || '').trim())
  const requiredDispatchDate = computedDispatch
    || (hasWarehouse ? (consignment.requiredDispatchDate || consignment.scheduledDispatchDate || '') : '')
    || ''

  return {
    ...consignment,
    transitDays,
    requiredDispatchDate,
    scheduledDispatchDate: computedDispatch || (hasWarehouse ? (consignment.scheduledDispatchDate || '') : '') || '',
    marketplaceName: marketplace?.name || consignment.marketplaceName || '',
  }
}
