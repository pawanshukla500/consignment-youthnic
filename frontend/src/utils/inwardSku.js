const STATUS_LABELS = {
  not_inwarded: 'Not inwarded',
  fully_inwarded: 'Fully inwarded',
  partially_inwarded: 'Partially inwarded',
  short_received: 'Short received',
  excess_received: 'Excess received',
}

export function inwardStatusLabel(status) {
  return STATUS_LABELS[status] || status || 'Not inwarded'
}

export function inwardStatusClass(status) {
  switch (status) {
    case 'fully_inwarded':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'partially_inwarded':
      return 'bg-amber-50 text-amber-800 border-amber-200'
    case 'short_received':
      return 'bg-orange-50 text-orange-800 border-orange-200'
    case 'excess_received':
      return 'bg-violet-50 text-violet-800 border-violet-200'
    default:
      return 'bg-slate-50 text-slate-600 border-slate-200'
  }
}
