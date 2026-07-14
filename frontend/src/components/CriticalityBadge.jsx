import { AlertTriangle } from 'lucide-react'
import { getDisplayLabel } from '../utils/criticalityUi'

export default function CriticalityBadge({ priority, size = 'sm', showSublabel = false }) {
  if (!priority || priority.level === 'normal') return null

  const label = getDisplayLabel(priority)
  const isCritical = priority.level === 'critical'
  const pulseDot = isCritical ? 'animate-blink-dot' : ''

  const sizeClass = size === 'lg'
    ? 'px-2.5 py-1 text-xs'
    : 'px-2 py-0.5 text-[10px]'

  return (
    <div>
      <span className={`inline-flex items-center gap-1 rounded-full font-bold border ${sizeClass} ${priority.badgeClass}`}>
        {isCritical && <AlertTriangle className={`w-3 h-3 ${pulseDot}`} />}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priority.dotClass} ${pulseDot}`} />
        {label}
      </span>
      {showSublabel && priority.sublabel && (
        <p className="text-[9px] text-slate-400 mt-px leading-tight">{priority.sublabel}</p>
      )}
    </div>
  )
}
