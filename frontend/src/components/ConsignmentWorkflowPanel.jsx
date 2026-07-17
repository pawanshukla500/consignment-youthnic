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
} from '../utils/workflowPriority'
import { CheckCircle2, Loader2, UserPlus, AlertTriangle, Clock } from 'lucide-react'

const AUTO_STAGES = new Set(['ready_for_invoice', 'ready_for_dispatch'])

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

  const isElevated = user?.role === 'admin' || user?.role === 'organization_head'
  const canAssign = isElevated || user?.permissions?.consignments === true
  const isArchived = consignment?.isArchived || consignment?.operationalStatus === 'archived'

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
            Invoice number
            <input
              type="text"
              value={f.invoiceNumber}
              onChange={(e) => updateForm('invoice_created', { invoiceNumber: e.target.value })}
              className="inp text-xs w-full mt-1"
              required
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice date
            <input
              type="date"
              value={f.invoiceDate}
              onChange={(e) => updateForm('invoice_created', { invoiceDate: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice amount
            <input
              type="number"
              min="0"
              step="0.01"
              value={f.invoiceAmount}
              onChange={(e) => updateForm('invoice_created', { invoiceAmount: e.target.value })}
              className="inp text-xs w-full mt-1"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500">
            Invoice document
            <select
              value={f.invoiceDocumentId}
              onChange={(e) => updateForm('invoice_created', { invoiceDocumentId: e.target.value })}
              className="inp text-xs w-full mt-1"
            >
              <option value="">Select uploaded invoice…</option>
              {(invoiceDocs.length ? invoiceDocs : (consignment?.documents || [])).map((d) => (
                <option key={d.id} value={d.id}>{d.originalName || d.id}</option>
              ))}
            </select>
          </label>
          <p className="text-[10px] text-slate-500 sm:col-span-2">
            Upload the invoice in the Documents tab (Invoice upload) before confirming.
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
          <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
            Variance / dispute reason (if qty differs)
            <textarea
              value={f.inwardVarianceReason}
              onChange={(e) => updateForm('inward_completed', { inwardVarianceReason: e.target.value })}
              className="inp text-xs w-full mt-1 min-h-[56px]"
            />
          </label>
          <label className="block text-[10px] font-semibold uppercase text-slate-500 sm:col-span-2">
            Dispute / issue details
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
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 lg:p-5 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Operational workflow</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Stages advance by department. Packing completed auto-assigns Invoice Creation; invoice completed unlocks dispatch; inward verification archives the consignment.
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
          {isArchived && (
            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-700">
              Archived
            </span>
          )}
        </div>
      </div>

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
                  {u.name} ({u.email}){u.departmentLabel ? ` · ${u.departmentLabel}` : ''}
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
  )
}
