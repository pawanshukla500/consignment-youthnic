/** Client-side consignment workflow list priority + badge styles. */

export const STAGE_ORDER = [
  'packing_completed',
  'ready_for_invoice',
  'invoice_created',
  'ready_for_dispatch',
  'dispatched',
  'inward_completed',
]

export const STAGE_LABELS = {
  packing_completed: 'Packing completed',
  ready_for_invoice: 'Ready for invoice',
  invoice_created: 'Invoice created',
  ready_for_dispatch: 'Ready for dispatch',
  dispatched: 'Dispatched',
  inward_completed: 'Inward completed',
}

/** Stage → departments that may confirm (mirrors backend/utils/departments.js). */
export const STAGE_DEPARTMENTS = {
  packing_completed: ['packing', 'ground_team', 'management'],
  ready_for_invoice: ['invoice', 'management'],
  invoice_created: ['invoice', 'management'],
  ready_for_dispatch: ['dispatch', 'ground_team', 'management'],
  dispatched: ['dispatch', 'ground_team', 'management'],
  inward_completed: ['inward', 'management'],
}

export const DEPARTMENT_OPTIONS = [
  { key: 'packing', label: 'Packing Team' },
  { key: 'ground_team', label: 'Ground Team' },
  { key: 'invoice', label: 'Invoice Creation Team' },
  { key: 'dispatch', label: 'Dispatch Team' },
  { key: 'inward', label: 'Inward Tracking Team' },
  { key: 'management', label: 'Admin / Management' },
]

export function getUserDepartmentsClient(user) {
  if (!user) return []
  if (Array.isArray(user.departments) && user.departments.length) {
    return [...new Set(user.departments.map((d) => String(d || '').toLowerCase()).filter(Boolean))]
  }
  if (user.department) return [String(user.department).toLowerCase()]
  if (user.role === 'admin' || user.role === 'organization_head') return ['management']
  return []
}

export function userCanConfirmStageClient(user, stage, consignment = null) {
  if (!user) return false
  if (user.role === 'admin' || user.role === 'organization_head') return true
  const depts = getUserDepartmentsClient(user)
  if (depts.includes('management')) return true
  const allowed = STAGE_DEPARTMENTS[stage] || []
  if (depts.some((dept) => allowed.includes(dept))) return true
  if (consignment?.groundTeamUserId && consignment.groundTeamUserId === user.id) {
    return ['packing_completed', 'ready_for_dispatch', 'dispatched'].includes(stage)
  }
  return false
}

export const WORKFLOW_BUCKET_ORDER = [
  'new',
  'active',
  'packed_pending_invoice',
  'ready_for_dispatch',
  'shipped',
  'inward_pending',
  'inwarded',
  'archived',
]

export const WORKFLOW_BUCKET_LABELS = {
  new: 'New',
  active: 'In progress',
  packed_pending_invoice: 'Packed · pending invoice',
  ready_for_dispatch: 'Ready for dispatch',
  shipped: 'Shipped',
  inward_pending: 'Inward pending',
  inwarded: 'Inwarded / done',
  archived: 'Archived',
}

/** Short labels for filter chips */
export const WORKFLOW_BUCKET_SHORT = {
  new: 'New',
  active: 'Active',
  packed_pending_invoice: 'Pending invoice',
  ready_for_dispatch: 'Ready dispatch',
  shipped: 'Shipped',
  inward_pending: 'Inward',
  inwarded: 'Inwarded',
  archived: 'Archived',
}

export const WORKFLOW_BUCKET_FILTER_VARIANT = {
  new: 'info',
  active: 'primary',
  packed_pending_invoice: 'warning',
  ready_for_dispatch: 'success',
  shipped: 'default',
  inward_pending: 'warning',
  inwarded: 'default',
  archived: 'default',
}

export const WORKFLOW_BUCKET_CLASS = {
  new: 'bg-sky-100 text-sky-800 border-sky-200',
  active: 'bg-blue-100 text-blue-800 border-blue-200',
  packed_pending_invoice: 'bg-amber-100 text-amber-900 border-amber-200',
  ready_for_dispatch: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  shipped: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  inward_pending: 'bg-violet-100 text-violet-800 border-violet-200',
  inwarded: 'bg-slate-100 text-slate-600 border-slate-200',
  archived: 'bg-slate-200 text-slate-700 border-slate-300',
}

export function getWorkflowBucket(c) {
  if (c?.operationalStatus === 'archived' || c?.isArchived) return 'archived'
  if (c?.listPriorityBucket) return c.listPriorityBucket
  const ship = c?.shipmentStatus || 'Planned'
  const pack = c?.status || 'pending'
  if (c?.stageConfirmations?.inward_completed?.confirmedAt || c?.dateOfInward || ship === 'Missed') return 'inwarded'
  if (['In Transit', 'Forwarded'].includes(ship) || c?.stageConfirmations?.dispatched?.confirmedAt) return 'inward_pending'
  if (ship === 'Ready' || c?.stageConfirmations?.ready_for_dispatch?.confirmedAt) return 'ready_for_dispatch'
  if (pack === 'completed' || c?.stageConfirmations?.packing_completed?.confirmedAt) return 'packed_pending_invoice'
  if (pack === 'in_progress' || ship === 'Under Packing') return 'active'
  return 'new'
}

export function sortByWorkflowPriority(items = []) {
  const rank = (c) => {
    const b = getWorkflowBucket(c)
    const idx = WORKFLOW_BUCKET_ORDER.indexOf(b)
    return idx < 0 ? 99 : idx + 1
  }
  return [...items].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    const ea = a.isEscalated ? 0 : 1
    const eb = b.isEscalated ? 0 : 1
    if (ea !== eb) return ea - eb
    const da = a.requiredDispatchDate || a.scheduledDispatchDate || a.appointmentDate || ''
    const db = b.requiredDispatchDate || b.scheduledDispatchDate || b.appointmentDate || ''
    if (da && db && da !== db) return String(da).localeCompare(String(db))
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
}

export function shipStatusClass(st) {
  if (st === 'Planned' || st === 'Scheduled') return 'bg-slate-100 text-slate-700'
  if (st === 'Under Packing') return 'bg-orange-100 text-orange-800'
  if (st === 'Ready') return 'bg-emerald-100 text-emerald-800'
  if (st === 'In Transit' || st === 'Forwarded') return 'bg-indigo-100 text-indigo-800'
  if (st === 'Inwarded') return 'bg-slate-200 text-slate-800'
  if (st === 'Missed') return 'bg-red-100 text-red-800'
  return 'bg-slate-100 text-slate-700'
}

export function packStatusClass(st) {
  if (st === 'completed') return 'bg-emerald-100 text-emerald-800'
  if (st === 'in_progress') return 'bg-blue-100 text-blue-800'
  return 'bg-amber-100 text-amber-800'
}
