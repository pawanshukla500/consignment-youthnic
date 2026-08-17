import { useState } from 'react'
import { formatCompactNumber } from '../../utils/chartColors'

/**
 * Part-to-whole as a single horizontal stacked bar, not a pie/donut —
 * bars beat angle judgment for magnitude comparison. Segments touch with a
 * 2px surface gap; only the bar's outer ends are rounded. A legend always
 * rides underneath since this is inherently multi-series (categorical color
 * job) — never make the reader color-match a slice by eye.
 *
 * segments: [{ key, label, value, color }]
 */
export default function SegmentedBar({
  segments = [],
  valueFormatter = (v) => formatCompactNumber(v),
  emptyLabel = 'No data yet',
  height = 16,
}) {
  const [hoverKey, setHoverKey] = useState(null)
  const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0)
  const visible = segments.filter((s) => (Number(s.value) || 0) > 0)

  if (!total || !visible.length) {
    return <p className="text-sm text-slate-400 text-center py-6">{emptyLabel}</p>
  }

  return (
    <div>
      <div className="flex w-full rounded-full overflow-hidden" style={{ height, gap: '2px', backgroundColor: '#fff' }}>
        {visible.map((s) => {
          const pct = ((Number(s.value) || 0) / total) * 100
          const isHovered = hoverKey === s.key
          return (
            <div
              key={s.key}
              className="transition-all cursor-default"
              style={{
                width: `${pct}%`,
                backgroundColor: s.color,
                opacity: hoverKey && !isHovered ? 0.55 : 1,
                minWidth: pct > 0 ? '3px' : 0,
              }}
              onMouseEnter={() => setHoverKey(s.key)}
              onMouseLeave={() => setHoverKey(null)}
              title={`${s.label}: ${valueFormatter(s.value)} (${pct.toFixed(0)}%)`}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
        {visible.map((s) => {
          const pct = ((Number(s.value) || 0) / total) * 100
          return (
            <button
              key={s.key}
              type="button"
              onMouseEnter={() => setHoverKey(s.key)}
              onMouseLeave={() => setHoverKey(null)}
              className={`flex items-center gap-1.5 text-xs transition-opacity ${hoverKey && hoverKey !== s.key ? 'opacity-50' : ''}`}
            >
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-slate-600">{s.label}</span>
              <span className="font-bold text-slate-900 tabular-nums">{valueFormatter(s.value)}</span>
              <span className="text-slate-400 tabular-nums">({pct.toFixed(0)}%)</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
