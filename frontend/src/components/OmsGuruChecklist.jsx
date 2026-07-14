import { CheckCircle2, Circle } from 'lucide-react'

/**
 * OMSGuru quantity-removal verification checklist for a consignment.
 */
export default function OmsGuruChecklist({
  consignment,
  onToggle,
  disabled = false,
  compact = false,
}) {
  const done = !!consignment?.omsGuruQtyRemoved
  const at = consignment?.omsGuruQtyRemovedAt
  const by = consignment?.omsGuruQtyRemovedBy

  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle?.(!done)}
        title={done ? 'Qty removed from OMSGuru' : 'Mark qty removed from OMSGuru'}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold border transition-colors ${
          done
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
        }`}
      >
        {done ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
        OMS
      </button>
    )
  }

  return (
    <div className={`rounded-lg border p-3 ${done ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/40'}`}>
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={done}
          disabled={disabled}
          onChange={(e) => onToggle?.(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 accent-primary-600"
        />
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-slate-900">
            Quantity removed from OMSGuru
          </span>
          <span className="block text-[10px] text-slate-500 mt-0.5 leading-relaxed">
            Confirm inventory has been deducted in OMSGuru after packing or dispatch.
          </span>
          {done && at && (
            <span className="block text-[10px] text-emerald-700 mt-1">
              Verified {new Date(at).toLocaleString()}
              {by ? ` · ${by}` : ''}
            </span>
          )}
        </span>
      </label>
    </div>
  )
}
