import { useEffect, useState } from 'react'
import { workflowAPI, docketCompaniesAPI } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import {
  STAGE_LABELS,
  STAGE_ORDER,
  WORKFLOW_BUCKET_LABELS,
  WORKFLOW_BUCKET_CLASS,
  getWorkflowBucket,
  userCanConfirmStageClient,
  DISPUTE_RESOLUTION_TYPES,
} from '../utils/workflowPriority'
import {
  CheckCircle2, Loader2, AlertTriangle, Clock, Ticket, ShieldCheck,
  PackageCheck, FileText, Truck, Warehouse, Archive, ChevronDown, ChevronUp,
  RefreshCw, User, Check, ArrowRight, Info, Copy
} from 'lucide-react'

const AUTO_STAGES = new Set(['ready_for_invoice', 'ready_for_dispatch'])

// Map workflow stages to user-friendly milestone icons and titles
const MILESTONES = [
  { key: 'packing_completed', title: 'Packing', icon: PackageCheck, desc: 'Pack SKUs & verify box quantities' },
  { key: 'invoice_created', title: 'Invoice', icon: FileText, desc: 'Generate & attach billing invoice' },
  { key: 'dispatched', title: 'Dispatch', icon: Truck, desc: 'Log courier docket & handover' },
  { key: 'inward_completed', title: 'Inward', icon: Warehouse, desc: 'Destination warehouse inward verification' },
  { key: 'archived', title: 'Archived', icon: Archive, desc: 'Shipment completed & records archived' },
]

/** One dispute row inside the Inward Dispute card — qty breakdown, ticket entry, resolve action. */
function DisputeRow({ dispute, canAct, ticketDraft, onTicketDraftChange, onSaveTicket, savingTicket, onOpenResolve, onCopyTicket }) {
  const d = dispute
  const isOpen = d.status === 'open'
  const varianceLabel = d.varianceType === 'excess' ? 'Excess' : 'Short'
  return (
    <div className={`rounded-xl border p-4 text-xs transition-all ${isOpen ? 'border-red-200 bg-red-50/20' : 'border-emerald-200 bg-emerald-50/30'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${isOpen ? 'bg-red-100 text-red-800 border border-red-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'}`}>
            {isOpen ? 'Open Dispute' : 'Resolved'}
          </span>
          <span className="font-semibold text-slate-800 text-sm">
            {varianceLabel} {d.disputedQty} unit{d.disputedQty === 1 ? '' : 's'}
          </span>
          <span className="text-slate-500 font-medium">
            (Shipped: {d.shippedQty} · Inward: {d.inwardQty})
          </span>
        </div>
        <span className="text-slate-400 text-[11px]">
          Raised {d.raisedAt ? new Date(d.raisedAt).toLocaleDateString() : '—'}
          {d.raisedByName ? ` by ${d.raisedByName}` : ''}
        </span>
      </div>
      {d.reason && <div className="text-slate-600 mb-1"><strong className="text-slate-700">Reason:</strong> {d.reason}</div>}
      {d.disputeDetails && <div className="text-slate-600 mb-2"><strong className="text-slate-700">Details:</strong> {d.disputeDetails}</div>}

      {isOpen ? (
        <div className="flex flex-wrap items-end gap-2.5 mt-3 pt-3 border-t border-red-100/80">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Marketplace Ticket / Case ID {d.ticketId ? '(update)' : '*'}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={ticketDraft ?? d.ticketId ?? ''}
                onChange={(e) => onTicketDraftChange(e.target.value)}
                placeholder="e.g. FK-DISPUTE-9842"
                className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
                disabled={!canAct}
              />
              {d.ticketId && (
                <button
                  type="button"
                  onClick={() => onCopyTicket?.(d.ticketId)}
                  title="Copy Ticket ID"
                  className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-slate-200 rounded-lg bg-white shrink-0 transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {canAct && (
            <button
              type="button"
              onClick={onSaveTicket}
              disabled={savingTicket}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              {savingTicket ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ticket className="w-3.5 h-3.5" />}
              {d.ticketId ? 'Update Ticket' : 'Save Ticket ID'}
            </button>
          )}
          {canAct && (
            <button
              type="button"
              onClick={onOpenResolve}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Resolve Dispute
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-emerald-100 space-y-1.5 bg-white/60 p-3 rounded-lg">
          {d.ticketId && (
            <div className="flex items-center gap-2 text-slate-600">
              <strong className="text-slate-700">Ticket ID:</strong>
              <span className="font-mono text-slate-800 bg-slate-100 px-2 py-0.5 rounded font-bold">{d.ticketId}</span>
              <button
                type="button"
                onClick={() => onCopyTicket?.(d.ticketId)}
                title="Copy Ticket ID"
                className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded transition-colors"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="text-emerald-800 font-medium">
            <strong>Resolution:</strong> {DISPUTE_RESOLUTION_TYPES[d.resolution?.type] || d.resolution?.type || '—'}
          </div>
          {d.resolution?.remark && <div className="text-slate-600"><strong className="text-slate-700">Remark:</strong> {d.resolution.remark}</div>}
          <div className="text-slate-400 text-[11px]">
            Resolved by {d.resolution?.resolvedByName || 'Team'} · {d.resolution?.resolvedAt ? new Date(d.resolution.resolvedAt).toLocaleString() : ''}
          </div>
        </div>
      )}
    </div>
  )
}

/** Resolution type + mandatory remark modal — required to close any inward dispute. */
function ResolveDisputeModal({ resolutionType, remark, onResolutionTypeChange, onRemarkChange, onCancel, onConfirm, busy }) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 w-full max-w-md p-6 overflow-hidden">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-slate-900">Resolve Inward Dispute</h3>
        </div>
        <p className="text-xs text-slate-500 mb-5 leading-relaxed">
          Select the agreed dispute resolution type and enter mandatory remarks. Once all open disputes are resolved, the consignment automatically advances to Archive.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
              Resolution Type *
            </label>
            <select
              value={resolutionType}
              onChange={(e) => onResolutionTypeChange(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
            >
              <option value="">Select resolution type…</option>
              {Object.entries(DISPUTE_RESOLUTION_TYPES).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
              Resolution Remark *
            </label>
            <textarea
              value={remark}
              onChange={(e) => onRemarkChange(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 outline-none transition-all min-h-[90px]"
              placeholder="Explain how the discrepancy was settled or credited…"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2.5 mt-6 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !resolutionType || !remark.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 shadow-sm transition-all disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            Confirm Resolution
          </button>
        </div>
      </div>
    </div>
  )
}

function emptyForms(consignment) {
  const planned = Number(consignment?.totalRequiredQty) || 0
  const packed = Number(consignment?.totalPackedQty) || 0
  return {
    packing_completed: {
      actualPackedQty: packed || '',
      allowShortPack: packed > 0 && packed < planned,
      shortReason: '',
      note: '',
    },
    invoice_created: {
      invoiceNumber: consignment?.forwardInvoiceNo || consignment?.invoice?.number || '',
      invoiceDate: consignment?.invoice?.date || new Date().toISOString().slice(0, 10),
      invoiceAmount: consignment?.invoice?.amount ?? '',
      invoiceDocumentId: consignment?.invoiceDocumentId || '',
      note: '',
    },
    dispatched: {
      docketNo: consignment?.docketNo || '',
      docketCompany: consignment?.docketCompany || '',
      dispatchDate: consignment?.actualDispatchDate || new Date().toISOString().slice(0, 10),
      boxCount: consignment?.boxCount || consignment?.boxes?.length || '',
      dispatchedQty: consignment?.totalPackedQty || '',
      docketDocumentId: consignment?.docketDocumentId || '',
      note: '',
    },
    inward_completed: {
      inwardQty: consignment?.unitsInwarded || consignment?.inwardSummary?.totalInwardQty || '',
      inwardDate: consignment?.dateOfInward || new Date().toISOString().slice(0, 10),
      inwardVarianceReason: '',
      disputeDetails: '',
      note: '',
    },
  }
}

export default function ConsignmentWorkflowPanel({ consignment, onUpdated }) {
  const { addToast } = useToast()
  const { user } = useAuth()
  const [assignees, setAssignees] = useState([])
  const [couriers, setCouriers] = useState([])
  const [selectedUserId, setSelectedUserId] = useState(consignment?.groundTeamUserId || '')
  const [busyStage, setBusyStage] = useState(null)
  const [assigning, setAssigning] = useState(false)
  const [forms, setForms] = useState(() => emptyForms(consignment))
  const [resyncingTaskflow, setResyncingTaskflow] = useState(false)
  const [ticketDrafts, setTicketDrafts] = useState({})
  const [savingTicketId, setSavingTicketId] = useState(null)
  const [resolveModal, setResolveModal] = useState({ open: false, disputeId: null, resolutionType: '', remark: '' })
  const [resolvingDispute, setResolvingDispute] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [showAssignDropdown, setShowAssignDropdown] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [inspectedMilestone, setInspectedMilestone] = useState(null)

  const isElevated = user?.role === 'admin' || user?.role === 'organization_head'
  const canAssign = isElevated || user?.permissions?.consignments === true
  const isArchived = consignment?.isArchived || consignment?.operationalStatus === 'archived'
  const canActOnDispute = userCanConfirmStageClient(user, 'inward_completed', consignment)
  const inwardDisputes = consignment?.inwardDisputes || []
  const openDisputes = inwardDisputes.filter((d) => d.status === 'open')

  const handleCopyTicket = (ticketId) => {
    if (!ticketId) return
    navigator.clipboard?.writeText(ticketId)
    addToast('Ticket ID copied to clipboard', 'success')
  }

  useEffect(() => {
    setSelectedUserId(consignment?.groundTeamUserId || '')
    setForms(emptyForms(consignment))
  }, [consignment])

  useEffect(() => {
    if (!canAssign) return
    workflowAPI.getAssignees()
      .then((res) => setAssignees(res.data?.users || []))
      .catch(() => {})
  }, [canAssign])

  useEffect(() => {
    docketCompaniesAPI.getAll()
      .then((res) => setCouriers(res.data?.companies || res.data || []))
      .catch(() => {})
  }, [])

  const confirmations = consignment?.stageConfirmations || {}
  const nextStage = STAGE_ORDER.find((s) => !confirmations[s]?.confirmedAt)
  const bucket = getWorkflowBucket(consignment)
  const plannedQty = Number(consignment?.totalRequiredQty) || 0
  const packedQty = Number(consignment?.totalPackedQty) || 0
  const shortQty = Math.max(0, plannedQty - packedQty)
  const completedMilestoneCount = MILESTONES.filter(
    (m) => Boolean(confirmations[m.key]?.confirmedAt) || (m.key === 'archived' && isArchived)
  ).length

  const invoiceDocs = (consignment?.documents || []).filter((d) => {
    const purpose = String(d.purpose || d.description || '').toLowerCase()
    return purpose.includes('invoice') || d.id === consignment?.invoiceDocumentId
  })
  const docketDocs = (consignment?.documents || []).filter((d) => {
    const purpose = String(d.purpose || d.description || '').toLowerCase()
    return purpose.includes('docket') || d.id === consignment?.docketDocumentId
  })

  const updateForm = (stage, patch) => {
    setForms((prev) => ({ ...prev, [stage]: { ...prev[stage], ...patch } }))
  }

  const handleAssign = async () => {
    if (!selectedUserId) {
      addToast('Select a team member', 'warning')
      return
    }
    setAssigning(true)
    try {
      const res = await workflowAPI.assignGroundTeam(consignment.id, { userId: selectedUserId })
      onUpdated?.(res.data.consignment)
      setShowAssignDropdown(false)
      addToast('Team member assigned successfully', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Assign failed', 'error')
    } finally {
      setAssigning(false)
    }
  }

  const handleTaskflowResync = async () => {
    setResyncingTaskflow(true)
    try {
      const res = await workflowAPI.taskflowResync(consignment.id)
      onUpdated?.(res.data.consignment)
      const wfId = res.data?.result?.createdResult?.workflowId
        || res.data?.result?.stagesResult?.workflowId
        || consignment?.taskflow?.workflowId
      addToast(wfId ? `TaskFlow synced (${wfId.slice(0, 8)}…)` : 'TaskFlow synced', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'TaskFlow resync failed', 'error')
    } finally {
      setResyncingTaskflow(false)
    }
  }

  const handleSaveTicket = async (disputeId) => {
    const ticketId = (ticketDrafts[disputeId] ?? '').trim()
    if (!ticketId) {
      addToast('Enter a Ticket / Case ID', 'warning')
      return
    }
    setSavingTicketId(disputeId)
    try {
      const res = await workflowAPI.recordDisputeTicket(consignment.id, disputeId, { ticketId })
      onUpdated?.(res.data.consignment)
      setTicketDrafts((prev) => ({ ...prev, [disputeId]: undefined }))
      addToast('Ticket / Case ID saved', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Could not save ticket ID', 'error')
    } finally {
      setSavingTicketId(null)
    }
  }

  const openResolveModal = (disputeId) => {
    setResolveModal({ open: true, disputeId, resolutionType: '', remark: '' })
  }

  const handleResolveDispute = async () => {
    const { disputeId, resolutionType, remark } = resolveModal
    if (!resolutionType || !remark.trim()) {
      addToast('Resolution type and remark are both required', 'warning')
      return
    }
    setResolvingDispute(true)
    try {
      const res = await workflowAPI.resolveDispute(consignment.id, disputeId, { resolutionType, remark: remark.trim() })
      onUpdated?.(res.data.consignment)
      setResolveModal({ open: false, disputeId: null, resolutionType: '', remark: '' })
      addToast(
        res.data.archived
          ? 'Dispute resolved — consignment moved to Archive'
          : 'Dispute resolved — other dispute(s) still open',
        'success'
      )
    } catch (e) {
      addToast(e.response?.data?.error || 'Could not resolve dispute', 'error')
    } finally {
      setResolvingDispute(false)
    }
  }

  const buildPayload = (stage) => {
    const f = forms[stage] || {}
    if (stage === 'packing_completed') {
      const actual = f.actualPackedQty !== '' ? Number(f.actualPackedQty) : packedQty
      const allowShort = Boolean(f.allowShortPack) || (actual < plannedQty && plannedQty > 0)
      return {
        stage,
        note: f.note || undefined,
        actualPackedQty: actual,
        allowShortPack: allowShort,
        shortReason: allowShort ? (f.shortReason || '') : undefined,
      }
    }
    if (stage === 'invoice_created') {
      return {
        stage,
        note: f.note || undefined,
        invoiceNumber: f.invoiceNumber,
        invoiceDate: f.invoiceDate || undefined,
        invoiceAmount: f.invoiceAmount !== '' ? Number(f.invoiceAmount) : undefined,
        invoiceDocumentId: f.invoiceDocumentId || consignment?.invoiceDocumentId || undefined,
      }
    }
    if (stage === 'dispatched') {
      return {
        stage,
        note: f.note || undefined,
        docketNo: f.docketNo,
        docketCompany: f.docketCompany,
        dispatchDate: f.dispatchDate || undefined,
        boxCount: f.boxCount !== '' ? Number(f.boxCount) : undefined,
        dispatchedQty: f.dispatchedQty !== '' ? Number(f.dispatchedQty) : undefined,
        docketDocumentId: f.docketDocumentId || undefined,
      }
    }
    if (stage === 'inward_completed') {
      return {
        stage,
        note: f.note || undefined,
        inwardQty: f.inwardQty !== '' ? Number(f.inwardQty) : undefined,
        inwardDate: f.inwardDate || undefined,
        inwardVarianceReason: f.inwardVarianceReason || undefined,
        disputeDetails: f.disputeDetails || undefined,
        dispatchedQty: Number(consignment?.dispatchDetails?.dispatchedQty || consignment?.totalPackedQty) || undefined,
      }
    }
    return { stage, note: f.note || undefined }
  }

  const handleConfirm = async (stage) => {
    setBusyStage(stage)
    try {
      const res = await workflowAPI.confirmStage(consignment.id, buildPayload(stage))
      onUpdated?.(res.data.consignment)
      const auto = (res.data.autoStages || []).map((s) => STAGE_LABELS[s] || s).join(', ')
      addToast(
        auto
          ? `${STAGE_LABELS[stage] || stage} confirmed · auto: ${auto}`
          : `${STAGE_LABELS[stage] || stage} confirmed`,
        'success'
      )
    } catch (e) {
      addToast(e.response?.data?.error || 'Confirmation failed', 'error')
    } finally {
      setBusyStage(null)
    }
  }

  // Active stage determination
  const activeStage = nextStage || (isArchived ? 'archived' : null)
  const canConfirmActive = activeStage ? userCanConfirmStageClient(user, activeStage, consignment) : false
  const isActiveAuto = activeStage ? AUTO_STAGES.has(activeStage) : false

  // Completed stages list for history audit
  const completedStages = STAGE_ORDER.filter((s) => Boolean(confirmations[s]?.confirmedAt))

  return (
    <>
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs mb-8 overflow-hidden transition-all">
        {/* Header Bar */}
        <div className="px-5 py-4 bg-gradient-to-r from-slate-50 via-white to-slate-50/50 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary-50 text-primary-600">
              <PackageCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900 tracking-tight">Shipment Lifecycle & Handoff</h2>
                <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${WORKFLOW_BUCKET_CLASS[bucket] || WORKFLOW_BUCKET_CLASS.active}`}>
                  {WORKFLOW_BUCKET_LABELS[bucket] || bucket}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {isArchived
                  ? 'All verification stages completed and archived.'
                  : `Current stage: ${STAGE_LABELS[activeStage] || activeStage || 'In Progress'}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {consignment?.isEscalated && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
                <AlertTriangle className="w-3.5 h-3.5" /> Escalated
              </span>
            )}
            {consignment?.isTatOverdue && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-200">
                <Clock className="w-3.5 h-3.5" /> TAT Overdue
              </span>
            )}
            {openDisputes.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-600 text-white shadow-xs">
                <AlertTriangle className="w-3.5 h-3.5" /> {openDisputes.length} Dispute{openDisputes.length > 1 ? 's' : ''} Open
              </span>
            )}
            <button
              type="button"
              onClick={() => setPanelOpen((o) => !o)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors ml-1"
              title={panelOpen ? 'Collapse Workflow' : 'Expand Workflow'}
            >
              {panelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {panelOpen && (
          <div className="p-5 lg:p-6 space-y-6">
            {/* Visual Stepper / Progress Timeline */}
            {/* Visual Stepper / Progress Timeline */}
            <div className="relative">
              <div className="hidden sm:block absolute top-[30px] left-[10%] right-[10%] h-1 bg-slate-100 rounded-full -z-0 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 transition-all duration-500 ease-out shadow-xs"
                  style={{
                    width: `${completedMilestoneCount <= 1 ? 0 : Math.min(100, Math.max(0, ((completedMilestoneCount - 1) / (MILESTONES.length - 1)) * 100))}%`
                  }}
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 relative z-10">
                {MILESTONES.map((m, idx) => {
                  const isDone = Boolean(confirmations[m.key]?.confirmedAt) || (m.key === 'archived' && isArchived)
                  const isCurrent = (activeStage === m.key || (m.key === 'invoice_created' && activeStage === 'ready_for_invoice') || (m.key === 'dispatched' && activeStage === 'ready_for_dispatch')) && !isArchived
                  const isInspected = inspectedMilestone === m.key
                  const Icon = m.icon
                  const conf = confirmations[m.key]

                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setInspectedMilestone((prev) => (prev === m.key ? null : m.key))}
                      className={`flex flex-col items-center text-center p-3 rounded-xl border transition-all cursor-pointer ${
                        isDone
                          ? 'bg-emerald-50/40 border-emerald-200 hover:bg-emerald-50/80 hover:shadow-xs'
                          : isCurrent
                            ? 'bg-primary-50/50 border-primary-300 ring-2 ring-primary-100 shadow-sm'
                            : 'bg-white border-slate-100 opacity-60 hover:opacity-90'
                      } ${isInspected ? 'ring-2 ring-emerald-500 border-emerald-400' : ''}`}
                    >
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center mb-2 transition-all ${
                          isDone
                            ? 'bg-emerald-600 text-white shadow-xs'
                            : isCurrent
                              ? 'bg-primary-600 text-white shadow-md animate-pulse'
                              : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}
                      >
                        {isDone ? <Check className="w-4 h-4 stroke-[3]" /> : <Icon className="w-4 h-4" />}
                      </div>
                      <span className={`text-xs font-bold ${isDone ? 'text-emerald-900' : isCurrent ? 'text-primary-900' : 'text-slate-600'}`}>
                        {idx + 1}. {m.title}
                      </span>
                      <span className="text-[10px] text-slate-400 mt-0.5 hidden sm:block truncate max-w-full">
                        {isDone
                          ? (conf?.confirmedAt ? new Date(conf.confirmedAt).toLocaleDateString() : 'Completed')
                          : isCurrent
                            ? 'Active Stage'
                            : 'Pending'}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Inspected Milestone Detail Card */}
              {inspectedMilestone && (() => {
                const m = MILESTONES.find((item) => item.key === inspectedMilestone)
                const conf = confirmations[inspectedMilestone]
                const isDone = Boolean(conf?.confirmedAt) || (inspectedMilestone === 'archived' && isArchived)
                return (
                  <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in shadow-2xs">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${isDone ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                        {m?.icon ? <m.icon className="w-4 h-4" /> : <Info className="w-4 h-4" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-slate-900">{m?.title} Stage Details</h4>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isDone ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                            {isDone ? 'Verified' : 'Pending'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{m?.desc}</p>
                        {conf?.confirmedAt && (
                          <p className="text-[11px] text-slate-600 mt-1">
                            Confirmed by <strong className="text-slate-800">{conf.confirmedByName || conf.confirmedByEmail || 'Staff'}</strong> on {new Date(conf.confirmedAt).toLocaleString()}
                          </p>
                        )}
                        {conf?.note && (
                          <p className="text-[11px] text-slate-600 mt-0.5 italic">
                            &ldquo;{conf.note}&rdquo;
                          </p>
                        )}
                        {inspectedMilestone === 'invoice_created' && (consignment.forwardInvoiceNo || consignment.invoice?.number) && (
                          <p className="text-[11px] font-mono text-slate-700 mt-0.5">
                            Invoice: <strong>{consignment.forwardInvoiceNo || consignment.invoice?.number}</strong>
                          </p>
                        )}
                        {inspectedMilestone === 'dispatched' && consignment.docketNo && (
                          <p className="text-[11px] text-slate-700 mt-0.5">
                            Docket: <strong className="font-mono">{consignment.docketNo}</strong> via {consignment.docketCompany || 'Courier'}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setInspectedMilestone(null)}
                      className="text-xs text-slate-500 hover:text-slate-800 self-end sm:self-center px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 transition-colors shadow-2xs"
                    >
                      Close
                    </button>
                  </div>
                )
              })()}
            </div>

            {/* Inward Disputes Alert Card (if any exist) */}
            {inwardDisputes.length > 0 && (
              <div className="rounded-2xl border border-red-200 bg-red-50/30 overflow-hidden shadow-xs">
                <div className="px-5 py-3.5 bg-red-100/60 border-b border-red-200 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                    <h3 className="text-xs font-bold text-red-950 uppercase tracking-wide">
                      Inward Discrepancy Tracking ({openDisputes.length} Open)
                    </h3>
                  </div>
                  <span className="text-[11px] text-red-700 font-medium">
                    Archive blocked until all disputes are resolved with marketplace case ID.
                  </span>
                </div>
                <div className="p-4 space-y-3">
                  {inwardDisputes.map((d) => (
                    <DisputeRow
                      key={d.id}
                      dispute={d}
                      canAct={canActOnDispute}
                      ticketDraft={ticketDrafts[d.id]}
                      onTicketDraftChange={(value) => setTicketDrafts((prev) => ({ ...prev, [d.id]: value }))}
                      onSaveTicket={() => handleSaveTicket(d.id)}
                      savingTicket={savingTicketId === d.id}
                      onOpenResolve={() => openResolveModal(d.id)}
                      onCopyTicket={handleCopyTicket}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Active Action Section */}
            {!isArchived && activeStage && (
              <div className="rounded-2xl border border-primary-200 bg-gradient-to-b from-primary-50/30 to-white p-5 lg:p-6 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-primary-100/60">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary-600 animate-ping" />
                    <h3 className="text-sm font-bold text-slate-900">
                      Action Required: {STAGE_LABELS[activeStage]}
                    </h3>
                    {isActiveAuto && (
                      <span className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                        System Ready
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    Pending Department: <strong className="text-slate-800">{consignment?.assignedDepartmentLabel || 'Assigned Team'}</strong>
                  </div>
                </div>

                {/* Form Body for Current Stage */}
                {canConfirmActive ? (
                  <div className="space-y-4">
                    {/* Stage 1: packing_completed */}
                    {activeStage === 'packing_completed' && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="bg-white p-3 rounded-xl border border-slate-200">
                            <span className="text-[10px] uppercase font-bold text-slate-400 block mb-0.5">Planned Units</span>
                            <span className="text-base font-bold text-slate-900">{plannedQty}</span>
                          </div>
                          <div className="bg-white p-3 rounded-xl border border-slate-200">
                            <span className="text-[10px] uppercase font-bold text-slate-400 block mb-0.5">Actual Packed</span>
                            <span className="text-base font-bold text-emerald-600">{packedQty}</span>
                          </div>
                          <div className="bg-white p-3 rounded-xl border border-slate-200">
                            <span className="text-[10px] uppercase font-bold text-slate-400 block mb-0.5">Shortage</span>
                            <span className={`text-base font-bold ${shortQty > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                              {shortQty > 0 ? shortQty : '0'}
                            </span>
                          </div>
                        </div>

                        <div className="grid sm:grid-cols-2 gap-4 bg-white p-4 rounded-xl border border-slate-100">
                          <div>
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                              Confirmed Packed Quantity *
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={forms.packing_completed.actualPackedQty}
                              onChange={(e) => updateForm('packing_completed', { actualPackedQty: e.target.value })}
                              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none transition-all"
                            />
                          </div>

                          <div className="flex items-center pt-5">
                            <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={Boolean(forms.packing_completed.allowShortPack)}
                                onChange={(e) => updateForm('packing_completed', { allowShortPack: e.target.checked })}
                                className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500 border-slate-300"
                              />
                              <span className="font-medium">Confirm short packing (dispatch available units)</span>
                            </label>
                          </div>

                          {forms.packing_completed.allowShortPack && (
                            <div className="sm:col-span-2">
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                                Reason for Short Quantity *
                              </label>
                              <textarea
                                value={forms.packing_completed.shortReason}
                                onChange={(e) => updateForm('packing_completed', { shortReason: e.target.value })}
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none transition-all min-h-[60px]"
                                placeholder="State reason for missing/short items (e.g. out of stock, damaged units in QA)..."
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Stage 2: ready_for_invoice (auto) */}
                    {activeStage === 'ready_for_invoice' && (
                      <div className="p-4 rounded-xl bg-white border border-slate-200 text-xs text-slate-600">
                        Packing is finalized. Click below to verify and advance to invoice generation.
                      </div>
                    )}

                    {/* Stage 3: invoice_created */}
                    {activeStage === 'invoice_created' && (
                      <div className="grid sm:grid-cols-3 gap-3 bg-white p-4 rounded-xl border border-slate-100">
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Forward Invoice No *
                          </label>
                          <input
                            type="text"
                            value={forms.invoice_created.invoiceNumber}
                            onChange={(e) => updateForm('invoice_created', { invoiceNumber: e.target.value })}
                            placeholder="e.g. INV-2026-9041"
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Invoice Date *
                          </label>
                          <input
                            type="date"
                            value={forms.invoice_created.invoiceDate}
                            onChange={(e) => updateForm('invoice_created', { invoiceDate: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Invoice Amount (₹) *
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={forms.invoice_created.invoiceAmount}
                            onChange={(e) => updateForm('invoice_created', { invoiceAmount: e.target.value })}
                            placeholder="0.00"
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                            required
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Attach Invoice Document (Optional)
                          </label>
                          <select
                            value={forms.invoice_created.invoiceDocumentId}
                            onChange={(e) => updateForm('invoice_created', { invoiceDocumentId: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          >
                            <option value="">No document attached (can attach later in Documents tab)</option>
                            {(invoiceDocs.length ? invoiceDocs : (consignment?.documents || [])).map((d) => (
                              <option key={d.id} value={d.id}>{d.originalName || d.id}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Stage 4: ready_for_dispatch (auto) */}
                    {activeStage === 'ready_for_dispatch' && (
                      <div className="p-4 rounded-xl bg-white border border-slate-200 text-xs text-slate-600">
                        Invoice confirmed. Shipment is cleared for dispatch handover. Click below to proceed to courier logging.
                      </div>
                    )}

                    {/* Stage 5: dispatched */}
                    {activeStage === 'dispatched' && (
                      <div className="grid sm:grid-cols-3 gap-3 bg-white p-4 rounded-xl border border-slate-100">
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Docket / AWB No *
                          </label>
                          <input
                            type="text"
                            value={forms.dispatched.docketNo}
                            onChange={(e) => updateForm('dispatched', { docketNo: e.target.value })}
                            placeholder="e.g. 192837465"
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Courier Partner *
                          </label>
                          <select
                            value={forms.dispatched.docketCompany}
                            onChange={(e) => updateForm('dispatched', { docketCompany: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          >
                            <option value="">Select courier partner…</option>
                            {couriers.map((c) => (
                              <option key={c.id || c.name} value={c.name || c.companyName || c.id}>
                                {c.name || c.companyName}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Dispatch Date
                          </label>
                          <input
                            type="date"
                            value={forms.dispatched.dispatchDate}
                            onChange={(e) => updateForm('dispatched', { dispatchDate: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Box Count
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={forms.dispatched.boxCount}
                            onChange={(e) => updateForm('dispatched', { boxCount: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Dispatched Units
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={forms.dispatched.dispatchedQty}
                            onChange={(e) => updateForm('dispatched', { dispatchedQty: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                            Docket Document
                          </label>
                          <select
                            value={forms.dispatched.docketDocumentId}
                            onChange={(e) => updateForm('dispatched', { docketDocumentId: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                          >
                            <option value="">None attached</option>
                            {(docketDocs.length ? docketDocs : (consignment?.documents || [])).map((d) => (
                              <option key={d.id} value={d.id}>{d.originalName || d.id}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Stage 6: inward_completed */}
                    {activeStage === 'inward_completed' && (() => {
                      const dispatched = Number(consignment?.dispatchDetails?.dispatchedQty || consignment?.totalPackedQty) || 0
                      const inwardQtyNum = forms.inward_completed.inwardQty !== '' ? Number(forms.inward_completed.inwardQty) : null
                      const variance = inwardQtyNum != null && dispatched > 0 ? inwardQtyNum - dispatched : 0
                      return (
                        <div className="space-y-4 bg-white p-4 rounded-xl border border-slate-100">
                          <div className="grid sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                                Inward Received Quantity (Dispatched: {dispatched})
                              </label>
                              <input
                                type="number"
                                min="0"
                                value={forms.inward_completed.inwardQty}
                                onChange={(e) => updateForm('inward_completed', { inwardQty: e.target.value })}
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                                Inward Date
                              </label>
                              <input
                                type="date"
                                value={forms.inward_completed.inwardDate}
                                onChange={(e) => updateForm('inward_completed', { inwardDate: e.target.value })}
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none"
                              />
                            </div>
                          </div>

                          {variance !== 0 && (
                            <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
                              <div className="font-bold flex items-center gap-1.5">
                                <AlertTriangle className="w-4 h-4 text-amber-600" />
                                <span>Quantity Discrepancy: {variance < 0 ? `Short by ${Math.abs(variance)} units` : `Excess by ${variance} units`}</span>
                              </div>
                              <p className="text-[11px] text-amber-800 leading-relaxed">
                                Confirming will automatically raise a tracked inward dispute. The consignment will not move to Archive until a marketplace case ticket is registered and resolved.
                              </p>
                            </div>
                          )}

                          <div>
                            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                              Variance / Dispute Reason {variance !== 0 ? '*' : '(Optional)'}
                            </label>
                            <textarea
                              value={forms.inward_completed.inwardVarianceReason}
                              onChange={(e) => updateForm('inward_completed', { inwardVarianceReason: e.target.value })}
                              placeholder="Reason for discrepancy (damaged in transit, warehouse physical count mismatch)..."
                              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:bg-white focus:ring-2 focus:ring-primary-500 outline-none min-h-[60px]"
                            />
                          </div>
                        </div>
                      )
                    })()}

                    {/* Primary Confirmation Button */}
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-[11px] text-slate-400">
                        {isActiveAuto ? 'No input required.' : 'Verify input values before confirming.'}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleConfirm(activeStage)}
                        disabled={busyStage === activeStage}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-md hover:shadow-lg transition-all disabled:opacity-50"
                      >
                        {busyStage === activeStage ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Confirming Stage…</span>
                          </>
                        ) : (
                          <>
                            <span>{isActiveAuto ? 'Advance to Next Stage' : `Confirm & Advance Stage`}</span>
                            <ArrowRight className="w-4 h-4" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Info className="w-4 h-4 text-slate-400 shrink-0" />
                      <span>
                        Awaiting confirmation from <strong>{consignment?.assignedDepartmentLabel || 'assigned department team'}</strong>.
                      </span>
                    </div>
                    {canAssign && (
                      <button
                        type="button"
                        onClick={() => setShowAssignDropdown(true)}
                        className="text-xs font-bold text-primary-600 hover:text-primary-700 underline"
                      >
                        Reassign Team
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* If Archived: Celebration Banner */}
            {isArchived && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 text-center flex flex-col items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-emerald-600 text-white flex items-center justify-center mb-2 shadow-xs">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-bold text-emerald-950">Shipment Fully Verified & Archived</h3>
                <p className="text-xs text-emerald-700 mt-1">All packaging, invoice, logistics, and inward stages have successfully completed.</p>
              </div>
            )}

            {/* Completed Stages History Accordion */}
            {completedStages.length > 0 && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/50 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setShowHistory((h) => !h)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left font-semibold text-slate-700 hover:bg-slate-100/60 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>View Completed Stage Verification Audit ({completedStages.length})</span>
                  </span>
                  {showHistory ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                </button>
                {showHistory && (
                  <div className="p-4 pt-2 divide-y divide-slate-200/60 space-y-3">
                    {completedStages.map((stage) => {
                      const conf = confirmations[stage]
                      return (
                        <div key={stage} className="pt-2.5 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-bold text-slate-800">{STAGE_LABELS[stage] || stage}</span>
                            <div className="text-slate-500 text-[11px] mt-0.5">
                              Confirmed by {conf.confirmedByName || 'Authorized User'} · {conf.confirmedAt ? new Date(conf.confirmedAt).toLocaleString() : ''}
                              {conf.details?.shortQty > 0 && <span className="text-amber-700 font-semibold"> · Short: {conf.details.shortQty}</span>}
                              {conf.details?.invoiceNumber && <span> · Inv: #{conf.details.invoiceNumber}</span>}
                              {conf.details?.docketNo && <span> · Docket: {conf.details.docketNo}</span>}
                              {conf.details?.receivedQty != null && <span> · Inward: {conf.details.receivedQty}</span>}
                            </div>
                          </div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-full">
                            Verified
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Bottom Team & TaskFlow Toolbar */}
            <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs">
                  <User className="w-3.5 h-3.5" />
                </div>
                <div>
                  <span className="text-slate-400 text-[11px] block">Assigned Operator</span>
                  <span className="font-bold text-slate-800">{consignment?.groundTeamName || 'Unassigned'}</span>
                  {consignment?.assignedDepartmentLabel && (
                    <span className="text-slate-400 text-[11px] ml-1.5">({consignment.assignedDepartmentLabel})</span>
                  )}
                </div>
                {canAssign && !isArchived && !showAssignDropdown && (
                  <button
                    type="button"
                    onClick={() => setShowAssignDropdown(true)}
                    className="ml-2 text-xs font-semibold text-primary-600 hover:text-primary-700 hover:underline"
                  >
                    Change
                  </button>
                )}
              </div>

              {/* Inline Assignee Selector when toggled */}
              {canAssign && !isArchived && showAssignDropdown && (
                <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-200">
                  <select
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                    className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-800 outline-none"
                  >
                    <option value="">Select team member…</option>
                    {assignees.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleAssign}
                    disabled={assigning || !selectedUserId}
                    className="px-3 py-1 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 disabled:opacity-50"
                  >
                    {assigning ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Assign'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAssignDropdown(false)}
                    className="px-2 py-1 text-slate-500 hover:text-slate-700 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* TaskFlow Status & Resync */}
              {isElevated && (
                <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200/80">
                  <span className="text-[11px] text-slate-500">
                    TaskFlow: <strong className="text-slate-800">{consignment?.taskflow?.trackingNumber || 'Linked'}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={handleTaskflowResync}
                    disabled={resyncingTaskflow}
                    className="p-1 rounded-md text-slate-500 hover:text-slate-800 hover:bg-white transition-colors disabled:opacity-50"
                    title="Resync to TaskFlow"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${resyncingTaskflow ? 'animate-spin text-primary-600' : ''}`} />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {resolveModal.open && (
        <ResolveDisputeModal
          resolutionType={resolveModal.resolutionType}
          remark={resolveModal.remark}
          onResolutionTypeChange={(value) => setResolveModal((prev) => ({ ...prev, resolutionType: value }))}
          onRemarkChange={(value) => setResolveModal((prev) => ({ ...prev, remark: value }))}
          onCancel={() => setResolveModal({ open: false, disputeId: null, resolutionType: '', remark: '' })}
          onConfirm={handleResolveDispute}
          busy={resolvingDispute}
        />
      )}
    </>
  )
}
