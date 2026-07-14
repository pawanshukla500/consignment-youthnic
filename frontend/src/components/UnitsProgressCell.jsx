import { getUnitsProgressPercent, getProgressBarColor } from '../utils/criticalityUi'
import { getShipmentPriority } from '../utils/priority'

export default function UnitsProgressCell({ consignment, showCounts = true, barWidth = 'w-16' }) {
  const priority = getShipmentPriority(consignment)
  const pct = getUnitsProgressPercent(consignment)
  const barColor = getProgressBarColor(priority)
  const barClass = barWidth === 'w-full' ? 'flex-1 min-w-0' : barWidth

  return (
    <div className={`flex items-center gap-2 ${barWidth === 'w-full' ? 'w-full' : 'min-w-[88px]'}`}>
      <div className={`${barClass} bg-slate-200 rounded-full h-1.5 flex-shrink`}>
        <div
          className={`${barColor} h-1.5 rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex flex-col leading-tight">
        <span className={`text-xs font-bold tabular-nums ${
          priority.level === 'critical' ? 'text-red-700' :
          priority.level === 'high' ? 'text-orange-700' :
          priority.level === 'medium' ? 'text-amber-700' :
          'text-slate-800'
        }`}>
          {pct}%
        </span>
        {showCounts && (
          <span className="text-[10px] text-slate-400 tabular-nums">
            {consignment.totalPackedQty || 0}/{consignment.totalRequiredQty || 0}
          </span>
        )}
      </div>
    </div>
  )
}
