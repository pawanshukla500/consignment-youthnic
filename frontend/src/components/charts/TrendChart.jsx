import { useMemo, useRef, useState } from 'react'
import { CHART_INK, formatCompactNumber, niceCeiling } from '../../utils/chartColors'

/**
 * Single-series line + area trend chart. One series never needs a legend box
 * (the card title already names it) — this ships a crosshair + tooltip
 * instead, snapping to the nearest point on pointer move.
 *
 * data: [{ label, value }]
 */
export default function TrendChart({
  data = [],
  color = '#2a78d6',
  height = 180,
  valueLabel = 'Value',
  valueFormatter = (v) => formatCompactNumber(v),
  emptyLabel = 'No data for this period',
}) {
  const containerRef = useRef(null)
  const [hoverIndex, setHoverIndex] = useState(null)
  const width = 600 // viewBox units — scales responsively via the SVG's width:100%
  const padTop = 12
  const padBottom = 24
  const padLeft = 8
  const padRight = 8
  const plotHeight = height - padTop - padBottom
  const plotWidth = width - padLeft - padRight

  const values = data.map((d) => Number(d.value) || 0)
  const max = niceCeiling(Math.max(...values, 1))
  const hasData = data.length > 0 && values.some((v) => v > 0)

  const points = useMemo(() => {
    if (data.length === 0) return []
    const step = data.length > 1 ? plotWidth / (data.length - 1) : 0
    return data.map((d, i) => {
      const x = padLeft + (data.length > 1 ? i * step : plotWidth / 2)
      const v = Number(d.value) || 0
      const y = padTop + plotHeight - (v / max) * plotHeight
      return { x, y, value: v, label: d.label }
    })
  }, [data, plotWidth, plotHeight, max])

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const areaPath = points.length
    ? `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} L${points[0].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} Z`
    : ''

  const gridSteps = 3
  const gridLines = Array.from({ length: gridSteps + 1 }, (_, i) => {
    const frac = i / gridSteps
    return { y: padTop + plotHeight * (1 - frac), value: max * frac }
  })

  const handleMove = (e) => {
    if (!points.length) return
    const svg = containerRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    let nearest = 0
    let nearestDist = Infinity
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX)
      if (dist < nearestDist) { nearestDist = dist; nearest = i }
    })
    setHoverIndex(nearest)
  }

  if (!hasData) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-400" style={{ height }}>
        {emptyLabel}
      </div>
    )
  }

  const hovered = hoverIndex != null ? points[hoverIndex] : null
  // Keep the tooltip box inside the chart on both edges.
  const tooltipLeftPct = hovered ? Math.min(88, Math.max(0, (hovered.x / width) * 100)) : 0

  return (
    <div className="relative select-none">
      <svg
        role="img"
        aria-label={`${valueLabel} trend`}
        ref={containerRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
        className="overflow-visible cursor-crosshair"
      >
        {gridLines.map((g) => (
          <g key={g.y}>
            <line x1={padLeft} x2={width - padRight} y1={g.y} y2={g.y} stroke={CHART_INK.grid} strokeWidth="1" />
            <text x={0} y={g.y - 3} fontSize="10" fill={CHART_INK.muted}>{valueFormatter(g.value)}</text>
          </g>
        ))}

        <path d={areaPath} fill={color} fillOpacity="0.1" stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {hovered && (
          <>
            <line x1={hovered.x} x2={hovered.x} y1={padTop} y2={padTop + plotHeight} stroke={CHART_INK.baseline} strokeWidth="1" />
            <circle cx={hovered.x} cy={hovered.y} r="5" fill={color} stroke="#fff" strokeWidth="2" />
          </>
        )}

        {/* X-axis labels — thin every-Nth to avoid crowding past ~10 points */}
        {points.map((p, i) => {
          const stride = Math.ceil(points.length / 10)
          if (i % stride !== 0 && i !== points.length - 1) return null
          return (
            <text key={i} x={p.x} y={height - 6} fontSize="10" fill={CHART_INK.muted} textAnchor="middle">
              {p.label}
            </text>
          )
        })}
      </svg>

      {/* Off-screen fallback — every value stays reachable without pointer
          hover, for screen readers and keyboard-only users. */}
      <ul className="sr-only" aria-label={`${valueLabel} trend data`}>
        {points.map((point) => (
          <li key={point.label}>{point.label}: {valueFormatter(point.value)} {valueLabel}</li>
        ))}
      </ul>

      {hovered && (
        <div
          className="absolute top-1 pointer-events-none bg-slate-900 text-white rounded-lg px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap z-10"
          style={{ left: `${tooltipLeftPct}%`, transform: tooltipLeftPct > 70 ? 'translateX(-100%)' : 'none' }}
        >
          <div className="font-bold tabular-nums">{valueFormatter(hovered.value)} <span className="font-normal text-slate-300">{valueLabel}</span></div>
          <div className="text-slate-400">{hovered.label}</div>
        </div>
      )}
    </div>
  )
}
