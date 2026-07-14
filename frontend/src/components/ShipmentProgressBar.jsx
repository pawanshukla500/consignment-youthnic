import { getUnitsProgressPercent, getProgressBarColor } from '../utils/criticalityUi'
import { getShipmentPriority } from '../utils/priority'

/**
 * Shipment-wise packing progress — used on Consignments list.
 */
export default function ShipmentProgressBar({ consignment, variant = 'table' }) {
  const priority = getShipmentPriority(consignment)
  const pct = getUnitsProgressPercent(consignment)
  const packed = consignment?.totalPackedQty || 0
  const required = consignment?.totalRequiredQty || 0
  const pending = Math.max(0, required - packed)
  const barColor = getProgressBarColor(priority)
  const status = consignment?.status || 'pending'
  const boxCount = consignment?.boxIds?.length ?? consignment?.boxes?.length ?? 0

  const statusLabel = status === 'completed' ? 'Complete' : status === 'in_progress' ? 'Packing' : 'Not started'
  const statusClass =
    status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
    status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
    'bg-slate-100 text-slate-600'

  if (variant === 'inline') {
    return (
      <div className="min-w-[88px] max-w-[120px]">
        <div className="flex items-center gap-1.5">
          <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
          <span className={`text-[10px] font-semibold tabular-nums w-7 text-right ${pct >= 100 ? 'text-emerald-600' : priority.level === 'critical' ? 'text-red-700' : 'text-slate-600'}`}>
            {pct}%
          </span>
        </div>
      </div>
    )
  }

  if (variant === 'compact') {
    return (
      <div className="min-w-[120px]">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className={`text-sm font-bold tabular-nums ${pct >= 100 ? 'text-emerald-600' : priority.level === 'critical' ? 'text-red-700' : 'text-slate-800'}`}>
            {pct}%
          </span>
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${statusClass}`}>{statusLabel}</span>
        </div>
        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[10px] text-slate-400 mt-1 tabular-nums">{packed} / {required} units</p>
      </div>
    )
  }

  return (
    <div className="min-w-[148px] max-w-[200px]">
      <div className="flex items-end justify-between gap-2 mb-1.5">
        <div>
          <span className={`text-lg font-bold tabular-nums leading-none ${pct >= 100 ? 'text-emerald-600' : priority.level === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>
            {pct}%
          </span>
          <p className="text-[10px] text-slate-400 mt-0.5">units packed</p>
        </div>
        <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
      <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden shadow-inner">
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[10px] tabular-nums">
        <span className="text-emerald-600 font-medium">{packed} packed</span>
        <span className="text-slate-400">{pending} left</span>
      </div>
      {boxCount > 0 && (
        <p className="text-[9px] text-slate-400 mt-0.5">{boxCount} box{boxCount !== 1 ? 'es' : ''} saved</p>
      )}
    </div>
  )
}
