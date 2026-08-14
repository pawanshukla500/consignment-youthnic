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
import { CheckCircle2, Loader2, UserPlus, AlertTriangle, Clock, Ticket, ShieldCheck } from 'lucide-react'

const AUTO_STAGES = new Set(['ready_for_invoice', 'ready_for_dispatch'])

/** One dispute row inside the Inward Dispute card — qty breakdown, ticket entry, resolve action. */
function DisputeRow({ dispute, canAct, ticketDraft, onTicketDraftChange, onSaveTicket, savingTicket, onOpenResolve }) {
  const d = dispute
  const isOpen = d.status === 'open'
  const varianceLabel = d.varianceType === 'excess' ? 'Excess' : 'Short'
  return (
    <div className={`rounded-lg border p-3 text-xs ${isOpen ? 'border-red-200 bg-white' : 'border-emerald-200 bg-emerald-50/50'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${isOpen ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {isOpen ? 'Open' : 'Resolved'}
          </span>
          <span className="font-semibold text-slate-800">
            {varianceLabel} {d.disputedQty} unit{d.disputedQty === 1 ? '' : 's'}
          </span>
          <span className="text-slate-500">
            (shipped {d.shippedQty} · inward {d.inwardQty})
          </span>
        </div>
        <span className="text-slate-400">
          Raised {d.raisedAt ? new Date(d.raisedAt).toLocaleDateString() : '—'}
          {d.raisedByName ? ` · ${d.raisedByName}` : ''}
        </span>
      </div>
      {d.reason && <div className="text-slate-600 mb-1"><strong className="text-slate-700">Reason:</strong> {d.reason}</div>}
      {d.disputeDetails && <div className="text-slate-600 mb-2"><strong className="text-slate-700">Details:</strong> {d.disputeDetails}</div>}

      {isOpen ? (
        <div className="flex flex-wrap items-end gap-2 mt-2 pt-2 border-t border-red-100">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">
              Marketplace Ticket / Case ID {d.ticketId ? '(update)' : '*'}
            </label>
            <input
              type="text"
              value={ticketDraft ?? d.ticketId ?? ''}
              onChange={(e) => onTicketDraftChange(e.target.value)}
              placeholder="e.g. AMZN-CASE-12345"
              className="inp text-xs w-full"
              disabled={!canAct}
            />
          </div>
          {canAct && (
            <button
              type="button"
              onClick={onSaveTicket}
              disabled={savingTicket}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold disabled:opacity-50"
            >
              {savingTicket ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ticket className="w-3 h-3" />}
              {d.ticketId ? 'Update' : 'Save ticket'}
            </button>
          )}
          {canAct && (
            <button
              type="button"
              onClick={onOpenResolve}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-700"
            >
              <ShieldCheck className="w-3 h-3" />
              Resolve dispute
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 pt-2 border-t border-emerald-100 space-y-0.5">
          {d.ticketId && <div className="text-slate-600"><strong className="text-slate-700">Ticket:</strong> {d.ticketId}</div>}
          <div className="text-emerald-800">
            <strong>Resolution:</strong> {DISPUTE_RESOLUTION_TYPES[d.resolution?.type] || d.resolution?.type || '—'}
          </div>
          <div className="text-slate-600"><strong className="text-slate-700">Remark:</strong> {d.resolution?.remark || '—'}</div>
          <div className="text-slate-400">
            {d.resolution?.resolvedByName || 'Team'} · {d.resolution?.resolvedAt ? new Date(d.resolution.resolvedAt).toLocaleString() : ''}
          </div>
        </div>
      )}
    </div>
  )
}

/** Resolution type + mandatory remark — required to close any inward dispute. */
function ResolveDisputeModal({ resolutionType, remark, onResolutionTypeChange, onRemarkChange, onCancel, onConfirm, busy }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
        <h3 className="text-sm font-bold text-slate-900 mb-1">Resolve inward dispute</h3>
        <p className="text-xs text-slate-500 mb-4">
          A resolution type and remark are required. This consignment moves to Archive automatically once every dispute on it is resolved.
        </p>
        <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Resolution type *</label>
        <select
          value={resolutionType}
          onChange={(e) => onResolutionTypeChange(e.target.value)}
          className="inp text-xs w-full mb-3"
        >
          <option value="">Select resolution…</option>
          {Object.entries(DISPUTE_RESOLUTION_TYPES).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">
          Remark {resolutionType === 'other' ? '(required — explain "Other")' : '*'}
        </label>
        <textarea
          value={remark}
          onChange={(e) => onRemarkChange(e.target.value)}
          className="inp text-xs w-full min-h-[80px] mb-4"
          placeholder="Explain how this was resolved…"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !resolutionType || !remark.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            Resolve
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

  const isElevated = user?.role === 'admin' || user?.role === 'organization_head'
  const canAssign = isElevated || user?.permissions?.consignments === true
  const isArchived = consignment?.isArchived || consignment?.operationalStatus === 'archived'
  const canActOnDispute = userCanConfirmStageClient(user, 'inward_completed', consignment)
  const inwardDisputes = consignment?.inwardDisputes || []
  const openDisputes = inwardDisputes.filter((d) => d.status === 'open')

  useEffect(() => {
    setSelectedUserId(consignment?.groundTeamUserId || '')
    setForms(emptyForms(consignment))
  }, [
    consignment?.id,
    consignment?.groundTeamUserId,
    consignment?.totalPackedQty,
    consignment?.forwardInvoiceNo,
    consignment?.invoiceDocumentId,
    consignment?.docketNo,
  ])

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
      addToast('Team member assigned', 'success')
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

  const renderStageForm = (stage) => {
    if (stage === 'packing_completed') {
      const f = forms.packing_completed
      return (
        <div className="w-full mt-2 grid sm:grid-cols-2 gap-2">
          <div className="text-[11px] text-slate-600 sm:col-span-2">
            Planned: <strong>{plannedQty}</strong> · Packed: <strong>{packedQty}</strong>
            {shortQty > 0 ? <> · Short: <strong className="text-amber-700">{shortQty}</strong></> : null}
          </div>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Actual packed qty
            <input
              type="number"
              min="0"
              value={f.actualPackedQty}
              onChange={(e) => updateForm('packing_completed', { actualPackedQty: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-700 mt-5">
            <input
              type="checkbox"
              checked={Boolean(f.allowShortPack)}
              onChange={(e) => updateForm('packing_completed', { allowShortPack: e.target.checked })}
            />
            Confirm short packing (dispatch available qty)
          </label>
          {f.allowShortPack && (
            <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
              Reason for short quantity
              <textarea
                value={f.shortReason}
                onChange={(e) => updateForm('packing_completed', { shortReason: e.target.value })}
                className="inp text-xs w-full mt-1 min-h-[56px]"
                placeholder="Required when packed qty is below planned"
              />
            </label>
          )}
        </div>
      )
    }

    if (stage === 'invoice_created') {
      const f = forms.invoice_created
      return (
        <div className="w-full mt-2 grid sm:grid-cols-2 gap-2">
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice number *
            <input
              type="text"
              value={f.invoiceNumber}
              onChange={(e) => updateForm('invoice_created', { invoiceNumber: e.target.value })}
              className="inp text-xs w-full mt-1"
              required
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice date *
            <input
              type="date"
              value={f.invoiceDate}
              onChange={(e) => updateForm('invoice_created', { invoiceDate: e.target.value })}
              className="inp text-xs w-full mt-1"
              required
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice amount *
            <input
              type="number"
              min="0"
              step="0.01"
              value={f.invoiceAmount}
              onChange={(e) => updateForm('invoice_created', { invoiceAmount: e.target.value })}
              className="inp text-xs w-full mt-1"
              required
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice document (optional)
            <select
              value={f.invoiceDocumentId}
              onChange={(e) => updateForm('invoice_created', { invoiceDocumentId: e.target.value })}
              className="inp text-xs w-full mt-1"
            >
              <option value="">No document</option>
              {(invoiceDocs.length ? invoiceDocs : (consignment?.documents || [])).map((d) => (
                <option key={d.id} value={d.id}>{d.originalName || d.id}</option>
              ))}
            </select>
          </label>
          <p className="text-[10px] text-slate-500 sm:col-span-2">
            Number, date, and amount are required. Document upload is optional and can be attached later from Documents.
          </p>
        </div>
      )
    }

    if (stage === 'dispatched') {
      const f = forms.dispatched
      return (
        <div className="w-full mt-2 grid sm:grid-cols-2 gap-2">
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Docket ID
            <input
              type="text"
              value={f.docketNo}
              onChange={(e) => updateForm('dispatched', { docketNo: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Courier / transport
            <select
              value={f.docketCompany}
              onChange={(e) => updateForm('dispatched', { docketCompany: e.target.value })}
              className="inp text-xs w-full mt-1"
            >
              <option value="">Select courier…</option>
              {couriers.map((c) => (
                <option key={c.id || c.name} value={c.name || c.companyName || c.id}>
                  {c.name || c.companyName}
                </option>
              ))}
            </select>
          </label>
          {!couriers.length && (
            <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
              Courier name
              <input
                type="text"
                value={f.docketCompany}
                onChange={(e) => updateForm('dispatched', { docketCompany: e.target.value })}
                className="inp text-xs w-full mt-1"
              />
            </label>
          )}
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Dispatch date
            <input
              type="date"
              value={f.dispatchDate}
              onChange={(e) => updateForm('dispatched', { dispatchDate: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Number of boxes
            <input
              type="number"
              min="0"
              value={f.boxCount}
              onChange={(e) => updateForm('dispatched', { boxCount: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Dispatched quantity
            <input
              type="number"
              min="0"
              value={f.dispatchedQty}
              onChange={(e) => updateForm('dispatched', { dispatchedQty: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Docket document (optional)
            <select
              value={f.docketDocumentId}
              onChange={(e) => updateForm('dispatched', { docketDocumentId: e.target.value })}
              className="inp text-xs w-full mt-1"
            >
              <option value="">None</option>
              {(docketDocs.length ? docketDocs : (consignment?.documents || [])).map((d) => (
                <option key={d.id} value={d.id}>{d.originalName || d.id}</option>
              ))}
            </select>
          </label>
        </div>
      )
    }

    if (stage === 'inward_completed') {
      const f = forms.inward_completed
      const dispatched = Number(consignment?.dispatchDetails?.dispatchedQty || consignment?.totalPackedQty) || 0
      const inwardQtyNum = f.inwardQty !== '' ? Number(f.inwardQty) : null
      const variance = inwardQtyNum != null && dispatched > 0 ? inwardQtyNum - dispatched : 0
      return (
        <div className="w-full mt-2 grid sm:grid-cols-2 gap-2">
          <div className="text-[11px] text-slate-600 sm:col-span-2">
            Dispatched qty: <strong>{dispatched}</strong>
          </div>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Inward received qty
            <input
              type="number"
              min="0"
              value={f.inwardQty}
              onChange={(e) => updateForm('inward_completed', { inwardQty: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Inward date
            <input
              type="date"
              value={f.inwardDate}
              onChange={(e) => updateForm('inward_completed', { inwardDate: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          {variance !== 0 && (
            <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              <strong>{variance < 0 ? `Short by ${Math.abs(variance)}` : `Excess by ${variance}`}.</strong>{' '}
              Confirming with this qty will open a tracked inward dispute instead of archiving — the consignment stays
              open until a marketplace ticket is raised and the dispute is resolved with a resolution type + remark.
            </div>
          )}
          <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
            Variance / dispute reason {variance !== 0 ? '(required — qty differs)' : '(if qty differs)'}
            <textarea
              value={f.inwardVarianceReason}
              onChange={(e) => updateForm('inward_completed', { inwardVarianceReason: e.target.value })}
              className="inp text-xs w-full mt-1 min-h-[56px]"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
            Dispute / issue details (optional extra context)
            <textarea
              value={f.disputeDetails}
              onChange={(e) => updateForm('inward_completed', { disputeDetails: e.target.value })}
              className="inp text-xs w-full mt-1 min-h-[48px]"
            />
          </label>
        </div>
      )
    }

    return null
  }

  return (
    <>
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 lg:p-5 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Operational workflow</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Stages advance by department. Packing completed auto-assigns Invoice Creation; invoice completed unlocks dispatch; inward verification archives the consignment — unless inward qty doesn't match, which opens a dispute and holds the consignment out of Archive until it's resolved.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${WORKFLOW_BUCKET_CLASS[bucket] || WORKFLOW_BUCKET_CLASS.active}`}>
            {WORKFLOW_BUCKET_LABELS[bucket] || bucket}
          </span>
          {consignment?.assignedDepartmentLabel && (
            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
              {consignment.assignedDepartmentLabel}
            </span>
          )}
          {consignment?.isEscalated && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">
              <AlertTriangle className="w-3 h-3" /> Escalated
            </span>
          )}
          {consignment?.isTatOverdue && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-900">
              <Clock className="w-3 h-3" /> TAT overdue
            </span>
          )}
          {openDisputes.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800">
              <AlertTriangle className="w-3 h-3" /> {openDisputes.length > 1 ? `${openDisputes.length} disputes open` : 'Dispute open'}
            </span>
          )}
          {isArchived && (
            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-700">
              Archived
            </span>
          )}
        </div>
      </div>

      {inwardDisputes.length > 0 && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-red-100 bg-red-50 flex flex-wrap items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
            <h3 className="text-sm font-bold text-red-900">Inward Dispute{inwardDisputes.length > 1 ? 's' : ''}</h3>
            {openDisputes.length > 0 ? (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-red-600 text-white px-2 py-0.5 rounded-full">
                {openDisputes.length} open
              </span>
            ) : (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-emerald-600 text-white px-2 py-0.5 rounded-full">
                All resolved
              </span>
            )}
          </div>
          {openDisputes.length > 0 && (
            <p className="px-4 pt-3 text-[11px] text-red-800">
              This consignment cannot move to Archive / Records until every dispute below is resolved with a resolution type and remark.
              {!canActOnDispute ? ' Only the Inward Tracking Team / management can raise a ticket or resolve it.' : ''}
            </p>
          )}
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
              />
            ))}
          </div>
        </div>
      )}

      {isElevated && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2">
          <div className="text-[11px] text-slate-600 min-w-0">
            <span className="font-semibold text-slate-800">TaskFlow Pro</span>
            {consignment?.taskflow?.trackingNumber
              ? <> · {consignment.taskflow.trackingNumber}</>
              : consignment?.taskflow?.workflowId
                ? <> · linked</>
                : <> · not linked yet</>}
            {consignment?.taskflow?.lastError
              ? <span className="text-amber-700"> · last sync error</span>
              : null}
          </div>
          <button
            type="button"
            onClick={handleTaskflowResync}
            disabled={resyncingTaskflow}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {resyncingTaskflow ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Resync to TaskFlow
          </button>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3 mb-4 text-xs">
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Assigned to</div>
          <div className="font-semibold text-slate-900 mt-1">{consignment?.groundTeamName || 'Unassigned'}</div>
          {consignment?.groundTeamEmail && (
            <div className="text-slate-500 mt-0.5">{consignment.groundTeamEmail}</div>
          )}
          {consignment?.assignedDepartmentLabel && (
            <div className="text-slate-500 mt-0.5">Dept: {consignment.assignedDepartmentLabel}</div>
          )}
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Pending action</div>
          <div className="font-semibold text-amber-800 mt-1">{consignment?.pendingAction || 'None'}</div>
          {consignment?.packingCompletion?.shortQty > 0 && (
            <div className="text-slate-500 mt-0.5">
              Short pack: {consignment.packingCompletion.shortQty} ({consignment.packingCompletion.shortReason || '—'})
            </div>
          )}
        </div>
      </div>

      {canAssign && !isArchived && (
        <div className="flex flex-wrap items-end gap-2 mb-4 pb-4 border-b border-slate-100">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Manual override assignee</label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="inp text-xs w-full"
            >
              <option value="">Select person…</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email}){(u.departmentLabels?.length
                    ? ` · ${u.departmentLabels.join(', ')}`
                    : (u.departmentLabel ? ` · ${u.departmentLabel}` : ''))}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleAssign}
            disabled={assigning || !selectedUserId}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            {assigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            Assign
          </button>
        </div>
      )}

      <ol className="space-y-2">
        {STAGE_ORDER.map((stage) => {
          const conf = confirmations[stage]
          const done = Boolean(conf?.confirmedAt)
          const isNext = nextStage === stage && !isArchived
          const canConfirm = userCanConfirmStageClient(user, stage, consignment)
          const isAuto = AUTO_STAGES.has(stage)
          return (
            <li
              key={stage}
              className={`rounded-lg border px-3 py-2 text-xs ${
                done ? 'border-emerald-200 bg-emerald-50/50' : isNext ? 'border-primary-200 bg-primary-50/40' : 'border-slate-100 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {done ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  ) : (
                    <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${isNext ? 'border-primary-500' : 'border-slate-300'}`} />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800">
                      {STAGE_LABELS[stage]}
                      {isAuto && !done && (
                        <span className="ml-1.5 text-[10px] font-medium text-slate-400">(auto)</span>
                      )}
                    </div>
                    {done && (
                      <div className="text-slate-500 truncate">
                        {conf.confirmedByName || 'Confirmed'} · {conf.confirmedAt ? new Date(conf.confirmedAt).toLocaleString() : ''}
                        {conf.details?.shortQty > 0 ? ` · short ${conf.details.shortQty}` : ''}
                        {conf.details?.invoiceNumber ? ` · inv ${conf.details.invoiceNumber}` : ''}
                        {conf.details?.docketNo ? ` · docket ${conf.details.docketNo}` : ''}
                        {conf.details?.receivedQty != null ? ` · inward ${conf.details.receivedQty}` : ''}
                      </div>
                    )}
                  </div>
                </div>
                {!done && isNext && canConfirm && (
                  <button
                    type="button"
                    onClick={() => handleConfirm(stage)}
                    disabled={busyStage === stage}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold disabled:opacity-50"
                  >
                    {busyStage === stage ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {isAuto ? 'Advance' : 'Confirm'}
                  </button>
                )}
                {!done && isNext && !canConfirm && (
                  <span className="text-[10px] text-slate-500">Awaiting department confirmation</span>
                )}
              </div>
              {!done && isNext && canConfirm && !isAuto && renderStageForm(stage)}
            </li>
          )
        })}
      </ol>
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
