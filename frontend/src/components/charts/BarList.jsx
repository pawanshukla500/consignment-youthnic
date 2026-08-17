import { formatCompactNumber } from '../../utils/chartColors'

/**
 * Horizontal ranked bar list — magnitude comparison, low→high or high→low.
 * Thin bar is the magnitude mark; the value sits in the row header (a bar
 * this thin has no room for a legible inline label — see marks-and-anatomy:
 * "if it doesn't fit, move the label outside the bar end").
 *
 * items: [{ label, value, color, sublabel? }]
 */
export default function BarList({
  items = [],
  color = '#2a78d6',
  maxItems = 8,
  valueFormatter = (v) => formatCompactNumber(v),
  emptyLabel = 'No data yet',
  onItemClick,
}) {
  const visible = items.slice(0, maxItems)
  const max = Math.max(...visible.map((i) => Number(i.value) || 0), 1)

  if (!visible.length) {
    return <p className="text-sm text-slate-400 text-center py-8">{emptyLabel}</p>
  }

  return (
    <div className="space-y-2.5">
      {visible.map((item, i) => {
        const value = Number(item.value) || 0
        const pct = Math.max(2, (value / max) * 100)
        const barColor = item.color || color
        const Wrapper = onItemClick ? 'button' : 'div'
        return (
          <Wrapper
            key={item.key ?? item.label ?? i}
            type={onItemClick ? 'button' : undefined}
            onClick={onItemClick ? () => onItemClick(item) : undefined}
            className={`w-full group block ${onItemClick ? 'text-left cursor-pointer' : ''}`}
          >
            <div className="flex items-baseline justify-between text-xs mb-1 gap-2">
              <span className="font-medium text-slate-700 truncate">{item.label}</span>
              <span className="flex items-baseline gap-1.5 shrink-0">
                {item.sublabel && <span className="text-[10px] text-slate-400">{item.sublabel}</span>}
                <span className="font-bold text-slate-800 tabular-nums">{valueFormatter(value)}</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full transition-all group-hover:brightness-110"
                style={{ width: `${pct}%`, backgroundColor: barColor }}
              />
            </div>
          </Wrapper>
        )
      })}
    </div>
  )
}
