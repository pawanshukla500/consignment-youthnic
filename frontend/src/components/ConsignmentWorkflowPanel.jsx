import { useEffect, useState } from 'react'
import { workflowAPI } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import {
  STAGE_LABELS,
  WORKFLOW_BUCKET_LABELS,
  WORKFLOW_BUCKET_CLASS,
  getWorkflowBucket,
} from '../utils/workflowPriority'
import { CheckCircle2, Loader2, UserPlus, AlertTriangle, Clock } from 'lucide-react'

const STAGE_ORDER = [
  'packing_completed',
  'ready_for_invoice',
  'invoice_created',
  'ready_for_dispatch',
  'dispatched',
]

export default function ConsignmentWorkflowPanel({ consignment, onUpdated }) {
  const { addToast } = useToast()
  const { user } = useAuth()
  const [assignees, setAssignees] = useState([])
  const [selectedUserId, setSelectedUserId] = useState(consignment?.groundTeamUserId || '')
  const [busyStage, setBusyStage] = useState(null)
  const [assigning, setAssigning] = useState(false)

  const isElevated = user?.role === 'admin' || user?.role === 'organization_head'
  const isAssignee = consignment?.groundTeamUserId && consignment.groundTeamUserId === user?.id
  const canConfirm = isElevated || isAssignee
  const canAssign = isElevated || user?.permissions?.consignments === true

  useEffect(() => {
    setSelectedUserId(consignment?.groundTeamUserId || '')
  }, [consignment?.groundTeamUserId])

  useEffect(() => {
    if (!canAssign) return
    workflowAPI.getAssignees()
      .then((res) => setAssignees(res.data?.users || []))
      .catch(() => {})
  }, [canAssign])

  const confirmations = consignment?.stageConfirmations || {}
  const nextStage = STAGE_ORDER.find((s) => !confirmations[s]?.confirmedAt)
  const bucket = getWorkflowBucket(consignment)

  const handleAssign = async () => {
    if (!selectedUserId) {
      addToast('Select a ground team member', 'warning')
      return
    }
    setAssigning(true)
    try {
      const res = await workflowAPI.assignGroundTeam(consignment.id, { userId: selectedUserId })
      onUpdated?.(res.data.consignment)
      addToast('Ground team assigned', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Assign failed', 'error')
    } finally {
      setAssigning(false)
    }
  }

  const handleConfirm = async (stage) => {
    setBusyStage(stage)
    try {
      const res = await workflowAPI.confirmStage(consignment.id, { stage })
      onUpdated?.(res.data.consignment)
      addToast(`${STAGE_LABELS[stage] || stage} confirmed`, 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Confirmation failed', 'error')
    } finally {
      setBusyStage(null)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 lg:p-5 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Ground team workflow</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Stages must be confirmed in order before invoice / dispatch advance.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${WORKFLOW_BUCKET_CLASS[bucket]}`}>
            {WORKFLOW_BUCKET_LABELS[bucket] || bucket}
          </span>
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
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mb-4 text-xs">
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Assigned to</div>
          <div className="font-semibold text-slate-900 mt-1">{consignment?.groundTeamName || 'Unassigned'}</div>
          {consignment?.groundTeamEmail && (
            <div className="text-slate-500 mt-0.5">{consignment.groundTeamEmail}</div>
          )}
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Pending action</div>
          <div className="font-semibold text-amber-800 mt-1">{consignment?.pendingAction || 'None'}</div>
          {consignment?.nextRequiredStage && (
            <div className="text-slate-500 mt-0.5">Next: {STAGE_LABELS[consignment.nextRequiredStage] || consignment.nextRequiredStage}</div>
          )}
        </div>
      </div>

      {canAssign && (
        <div className="flex flex-wrap items-end gap-2 mb-4 pb-4 border-b border-slate-100">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Ground team member</label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="inp text-xs w-full"
            >
              <option value="">Select person…</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
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
          const isNext = nextStage === stage
          return (
            <li
              key={stage}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                done ? 'border-emerald-200 bg-emerald-50/50' : isNext ? 'border-primary-200 bg-primary-50/40' : 'border-slate-100 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {done ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                ) : (
                  <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${isNext ? 'border-primary-500' : 'border-slate-300'}`} />
                )}
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800">{STAGE_LABELS[stage]}</div>
                  {done && (
                    <div className="text-slate-500 truncate">
                      {conf.confirmedByName || 'Confirmed'} · {conf.confirmedAt ? new Date(conf.confirmedAt).toLocaleString() : ''}
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
                  Confirm
                </button>
              )}
              {!done && isNext && !canConfirm && (
                <span className="text-[10px] text-slate-500">Awaiting assignee confirmation</span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
