import React, { useId, useMemo, useRef, useState } from 'react'
import {
  TrendingUp,
  BarChart3,
  LineChart,
  Boxes,
  Package,
  Flame,
  Calendar,
} from 'lucide-react'
import { formatCompactNumber, niceCeiling } from '../../utils/chartColors'
import { getMonotoneCubicPath, getAreaClosedPath, calculateChartKpis } from '../../utils/spline'

/**
 * Modern Interactive Trend Chart inspired by 21st.dev components
 * (Active Users Area Chart [id: 29218] & Weekly KPI Chart [id: 2503]).
 *
 * Supports:
 * - Monotone Cubic Spline (Fritsch-Carlson) smooth curves with zero overshoot
 * - Dual visualization modes: Smooth Area Curve & Daily Columns / Bar Chart
 * - Multi-metric switching (Boxes Packed vs Units/Items Packed)
 * - Integrated KPI highlights row (Total Volume, Peak Day, Daily Average, Active Packing Days)
 * - Rich glassmorphic tooltip with crosshair guideline & glowing active point
 * - Clean responsive Y/X axes with generous padding (no squished/overlapping labels)
 */
export default function TrendChart({
  data = [],
  title,
  subtitle,
  activePreset,
  color = '#E11D48',
  secondaryColor = '#10B981',
  height = 220,
  valueLabel = 'boxes',
  valueFormatter = (v) => formatCompactNumber(v),
  emptyLabel = 'No packing activity recorded for this period',
  showControls = true,
  showKpis = true,
  className = '',
}) {
  const containerRef = useRef(null)
  const chartUid = useId().replace(/:/g, '')

  const [viewMode, setViewMode] = useState('area') // 'area' | 'bar'
  const [activeMetric, setActiveMetric] = useState('boxes') // 'boxes' | 'items'
  const [hoverIndex, setHoverIndex] = useState(null)

  // Detect whether data contains items / units metrics
  const hasItemsMetric = useMemo(() => {
    return data.some((d) => d.items !== undefined && d.items !== null && Number(d.items) > 0)
  }, [data])

  const effectiveMetric = hasItemsMetric ? activeMetric : 'value'
  const isItemsMode = effectiveMetric === 'items'
  const activeColor = isItemsMode ? secondaryColor : color
  const activeUnitLabel = isItemsMode ? 'units' : valueLabel

  // Calculate high-fidelity KPIs
  const kpis = useMemo(() => {
    return calculateChartKpis(data, effectiveMetric)
  }, [data, effectiveMetric])

  // Chart dimensions & margins
  const width = 680
  const padTop = 20
  const padBottom = 32
  const padLeft = 46
  const padRight = 20
  const plotHeight = Math.max(80, height - padTop - padBottom)
  const plotWidth = width - padLeft - padRight

  const values = useMemo(() => {
    return data.map((d) => Number(d[effectiveMetric] ?? d.value ?? 0))
  }, [data, effectiveMetric])

  const maxRaw = values.length ? Math.max(...values, 0) : 0
  const max = useMemo(() => niceCeiling(Math.max(maxRaw, 1)), [maxRaw])
  const hasData = kpis.hasData

  // Plot coordinates
  const points = useMemo(() => {
    if (!data || data.length === 0) return []
    const step = data.length > 1 ? plotWidth / (data.length - 1) : 0

    return data.map((d, i) => {
      const x = padLeft + (data.length > 1 ? i * step : plotWidth / 2)
      const v = Number(d[effectiveMetric] ?? d.value ?? 0)
      const y = padTop + plotHeight - (max > 0 ? (v / max) * plotHeight : 0)
      return {
        x,
        y,
        value: v,
        label: d.label || d.date || `Day ${i + 1}`,
        date: d.date,
        raw: d,
        isPeak: maxRaw > 0 && v === maxRaw,
      }
    })
  }, [data, plotWidth, plotHeight, max, maxRaw, effectiveMetric, padLeft, padTop])

  // Monotone cubic spline paths
  const linePath = useMemo(() => getMonotoneCubicPath(points), [points])
  const areaPath = useMemo(() => getAreaClosedPath(points, padTop + plotHeight), [points, padTop, plotHeight])

  // Horizontal grid lines
  const gridSteps = 3
  const gridLines = useMemo(() => {
    return Array.from({ length: gridSteps + 1 }, (_, i) => {
      const frac = (gridSteps - i) / gridSteps
      return {
        y: padTop + plotHeight * (1 - frac),
        value: max * frac,
      }
    })
  }, [max, padTop, plotHeight])

  // Handle pointer tracking
  const handlePointerMove = (e) => {
    if (!points.length) return
    const svg = containerRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width

    let nearest = 0
    let nearestDist = Infinity
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = i
      }
    })
    setHoverIndex(nearest)
  }

  const hovered = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null
  const tooltipLeftPct = hovered ? Math.min(84, Math.max(4, (hovered.x / width) * 100)) : 0

  // Bar layout
  const barWidth = useMemo(() => {
    if (points.length <= 1) return 36
    const availableSlot = plotWidth / points.length
    return Math.max(10, Math.min(36, availableSlot * 0.6))
  }, [points.length, plotWidth])

  // Gradients and filter IDs
  const gradId = `trendGrad_${chartUid}`
  const barGradId = `barGrad_${chartUid}`
  const peakBarGradId = `peakBarGrad_${chartUid}`
  const glowFilterId = `glow_${chartUid}`

  return (
    <div className={`relative ${className}`}>
      {/* ── Optional Integrated Card Header ───────────────────────────── */}
      {title && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary-600" />
              <h2 className="text-base font-semibold text-slate-900">
                {title} {activePreset ? `— ${activePreset}` : ''}
              </h2>
            </div>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>

          {/* Controls: Mode & Metric Toggles */}
          {showControls && (
            <div className="flex flex-wrap items-center gap-2">
              {/* Metric Toggle */}
              {hasItemsMetric && (
                <div role="tablist" aria-label="Metric Selection" className="flex bg-slate-100 rounded-lg p-0.5">
                  <button
                    type="button"
                    role="tab"
                    id="tab-metric-boxes"
                    aria-selected={activeMetric === 'boxes'}
                    tabIndex={activeMetric === 'boxes' ? 0 : -1}
                    onClick={() => setActiveMetric('boxes')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                      activeMetric === 'boxes'
                        ? 'bg-white text-rose-700 shadow-2xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Boxes className="w-3.5 h-3.5" /> Boxes
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-metric-units"
                    aria-selected={activeMetric === 'items'}
                    tabIndex={activeMetric === 'items' ? 0 : -1}
                    onClick={() => setActiveMetric('items')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                      activeMetric === 'items'
                        ? 'bg-white text-emerald-700 shadow-2xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    <Package className="w-3.5 h-3.5" /> Units
                  </button>
                </div>
              )}

              {/* View Mode Toggle */}
              <div role="tablist" aria-label="Chart Style" className="flex bg-slate-100 rounded-lg p-0.5">
                <button
                  type="button"
                  role="tab"
                  id="tab-view-area"
                  aria-selected={viewMode === 'area'}
                  tabIndex={viewMode === 'area' ? 0 : -1}
                  onClick={() => setViewMode('area')}
                  title="Smooth Area Curve"
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                    viewMode === 'area'
                      ? 'bg-white text-slate-800 shadow-2xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <LineChart className="w-3.5 h-3.5" /> Area
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-view-bar"
                  aria-selected={viewMode === 'bar'}
                  tabIndex={viewMode === 'bar' ? 0 : -1}
                  onClick={() => setViewMode('bar')}
                  title="Daily Column Bars"
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1 cursor-pointer ${
                    viewMode === 'bar'
                      ? 'bg-white text-slate-800 shadow-2xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" /> Columns
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── KPI Micro-cards Row (21st.dev pattern) ────────────────────── */}
      {showKpis && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-slate-50/80 rounded-lg p-3 border border-slate-100">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider block">
              {`Total ${activeUnitLabel}`}
            </span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-bold text-slate-900 tabular-nums">
                {kpis.total.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400 font-medium">{activeUnitLabel}</span>
            </div>
          </div>

          <div className="bg-slate-50/80 rounded-lg p-3 border border-slate-100">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider block flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 text-amber-500 inline" /> Peak Day
            </span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-bold text-slate-900 tabular-nums">
                {kpis.peak > 0 ? kpis.peak.toLocaleString() : '0'}
              </span>
              {kpis.peakItem && (
                <span className="text-xs text-slate-500 truncate max-w-[110px]" title={kpis.peakItem.label}>
                  ({kpis.peakItem.label})
                </span>
              )}
            </div>
          </div>

          <div className="bg-slate-50/80 rounded-lg p-3 border border-slate-100">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider block">
              Daily Average
            </span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-bold text-slate-900 tabular-nums">
                {kpis.dailyAvg.toFixed(1)}
              </span>
              <span className="text-xs text-slate-400">/{activeUnitLabel === 'boxes' ? 'box-day' : 'day'}</span>
            </div>
          </div>

          <div className="bg-slate-50/80 rounded-lg p-3 border border-slate-100">
            <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider block">
              Active Packing Days
            </span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-bold text-slate-900 tabular-nums">
                {kpis.activeDays}
              </span>
              <span className="text-xs text-slate-400">
                of {kpis.totalDays} {kpis.totalDays === 1 ? 'day' : 'days'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Empty State ────────────────────────────────────────────────── */}
      {!hasData ? (
        <div
          className="flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-8"
          style={{ minHeight: height }}
        >
          <Calendar className="w-8 h-8 text-slate-300 mb-2" />
          <p className="text-sm font-medium text-slate-600">{emptyLabel}</p>
          <p className="text-xs text-slate-400 mt-1">
            Try adjusting your date range or preset filter above
          </p>
        </div>
      ) : (
        /* ── Interactive SVG Visualization ───────────────────────────── */
        <div className="relative select-none">
          <svg
            role="img"
            aria-label={`${activeUnitLabel} packing trend`}
            ref={containerRef}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            width="100%"
            height={height}
            onMouseMove={handlePointerMove}
            onMouseLeave={() => setHoverIndex(null)}
            className="overflow-visible cursor-crosshair"
          >
            <defs>
              {/* Monotone Area Gradient */}
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={activeColor} stopOpacity="0.28" />
                <stop offset="50%" stopColor={activeColor} stopOpacity="0.08" />
                <stop offset="100%" stopColor={activeColor} stopOpacity="0.00" />
              </linearGradient>

              {/* Standard Bar Gradient */}
              <linearGradient id={barGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={activeColor} stopOpacity="0.95" />
                <stop offset="100%" stopColor={activeColor} stopOpacity="0.65" />
              </linearGradient>

              {/* Peak Bar Gradient */}
              <linearGradient id={peakBarGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isItemsMode ? '#059669' : '#BE123C'} />
                <stop offset="100%" stopColor={activeColor} stopOpacity="0.8" />
              </linearGradient>

              {/* Smooth Glow Filter */}
              <filter id={glowFilterId} x="-10%" y="-10%" width="120%" height="130%">
                <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor={activeColor} floodOpacity="0.32" />
              </filter>
            </defs>

            {/* Horizontal Dashed Gridlines & Clean Left-Aligned Numbers */}
            {gridLines.map((g, idx) => (
              <g key={`grid-${idx}`}>
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={g.y}
                  y2={g.y}
                  stroke="#E2E8F0"
                  strokeWidth="1"
                  strokeDasharray={idx === gridSteps ? 'none' : '3 3'}
                />
                <text
                  x={padLeft - 10}
                  y={g.y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fontWeight="500"
                  fill="#94A3B8"
                  className="font-mono"
                >
                  {valueFormatter(g.value)}
                </text>
              </g>
            ))}

            {/* ══ AREA MODE ══════════════════════════════════════════════ */}
            {viewMode === 'area' && (
              <>
                <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
                <path
                  d={linePath}
                  fill="none"
                  stroke={activeColor}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  filter={`url(#${glowFilterId})`}
                />

                {/* Point nodes for non-zero points */}
                {points.map((p, i) => {
                  if (p.value === 0 && points.length > 7) return null
                  const isHovered = hoverIndex === i
                  return (
                    <g key={`dot-${i}`}>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={isHovered ? 6 : p.isPeak ? 4.5 : 3}
                        fill="#FFFFFF"
                        stroke={p.isPeak ? (isItemsMode ? '#059669' : '#BE123C') : activeColor}
                        strokeWidth={isHovered ? 2.5 : 2}
                        className="transition-all duration-150"
                      />
                    </g>
                  )
                })}
              </>
            )}

            {/* ══ COLUMN / BAR MODE (21st.dev pattern) ══════════════════ */}
            {viewMode === 'bar' && (
              <g>
                {points.map((p, i) => {
                  const barHeight = max > 0 ? (p.value / max) * plotHeight : 0
                  const barX = p.x - barWidth / 2
                  const barY = padTop + plotHeight - barHeight
                  const isHovered = hoverIndex === i

                  return (
                    <g key={`bar-${i}`} className="transition-all duration-150">
                      {/* Subtle hover background highlight */}
                      {isHovered && (
                        <rect
                          x={barX - 4}
                          y={padTop}
                          width={barWidth + 8}
                          height={plotHeight}
                          rx="6"
                          fill={activeColor}
                          fillOpacity="0.08"
                        />
                      )}

                      {/* Bar body */}
                      {barHeight > 0 ? (
                        <rect
                          x={barX}
                          y={barY}
                          width={barWidth}
                          height={barHeight}
                          rx="4"
                          ry="4"
                          fill={p.isPeak ? `url(#${peakBarGradId})` : `url(#${barGradId})`}
                          filter={isHovered ? `url(#${glowFilterId})` : undefined}
                          className="transition-all duration-150"
                        />
                      ) : (
                        /* Flat zero dot */
                        <circle
                          cx={p.x}
                          cy={padTop + plotHeight - 2}
                          r="2.5"
                          fill="#CBD5E1"
                        />
                      )}

                      {/* Peak indicator on top of bar */}
                      {p.isPeak && p.value > 0 && (
                        <circle
                          cx={p.x}
                          cy={barY - 6}
                          r="3"
                          fill="#F59E0B"
                        />
                      )}
                    </g>
                  )
                })}
              </g>
            )}

            {/* ══ Crosshair Guideline & Active Pulse ═════════════════════ */}
            {hovered && (
              <g pointerEvents="none">
                <line
                  x1={hovered.x}
                  x2={hovered.x}
                  y1={padTop}
                  y2={padTop + plotHeight}
                  stroke="#94A3B8"
                  strokeWidth="1.2"
                  strokeDasharray="4 4"
                />
                <circle
                  cx={hovered.x}
                  cy={hovered.y}
                  r="9"
                  fill={activeColor}
                  fillOpacity="0.22"
                  className="animate-pulse"
                />
                <circle
                  cx={hovered.x}
                  cy={hovered.y}
                  r="5"
                  fill={activeColor}
                  stroke="#FFFFFF"
                  strokeWidth="2"
                />
              </g>
            )}

            {/* X-axis labels */}
            {points.map((p, i) => {
              const stride = Math.ceil(points.length / 10)
              if (i % stride !== 0 && i !== points.length - 1) return null
              const isHovered = hoverIndex === i

              return (
                <text
                  key={`xlabel-${i}`}
                  x={p.x}
                  y={height - 8}
                  fontSize="11"
                  fontWeight={isHovered ? '700' : '500'}
                  fill={isHovered ? '#0F172A' : '#64748B'}
                  textAnchor="middle"
                >
                  {p.label}
                </text>
              )
            })}
          </svg>

          {/* Screen reader data list */}
          <ul className="sr-only" aria-label={`${activeUnitLabel} trend data table`}>
            {points.map((p) => (
              <li key={p.label}>
                {p.label}: {p.value} {activeUnitLabel}
              </li>
            ))}
          </ul>

          {/* ══ Floating Glassmorphic Tooltip ═══════════════════════════ */}
          {hovered && (
            <div
              className="absolute top-2 pointer-events-none z-20 backdrop-blur-md bg-slate-900/95 text-white border border-slate-700/60 shadow-2xl rounded-xl p-3 text-xs whitespace-nowrap transition-transform duration-75 ease-out"
              style={{
                left: `${tooltipLeftPct}%`,
                transform: tooltipLeftPct > 70 ? 'translateX(-100%)' : 'none',
              }}
            >
              <div className="flex items-center justify-between gap-3 border-b border-slate-700/60 pb-1.5 mb-1.5">
                <span className="font-semibold text-slate-200">{hovered.label}</span>
                {hovered.isPeak && hovered.value > 0 ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                    Peak Day 🔥
                  </span>
                ) : hovered.value > 0 ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300">
                    Active
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[10px] text-slate-400 bg-slate-800">
                    No packing
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: activeColor }} />
                <span className="text-slate-400 capitalize">{activeUnitLabel}:</span>
                <span className="font-bold text-white tabular-nums">
                  {hovered.value.toLocaleString()}
                </span>
                {kpis.total > 0 && (
                  <span className="text-slate-400 text-[11px]">
                    ({Math.round((hovered.value / kpis.total) * 100)}%)
                  </span>
                )}
              </div>

              {/* Show secondary metric if present */}
              {hasItemsMetric && (
                <div className="flex items-center gap-2 text-slate-300 text-[11px] pt-0.5 border-t border-slate-800/80">
                  <span className="text-slate-400">
                    {isItemsMode ? 'Boxes packed:' : 'Units packed:'}
                  </span>
                  <span className="font-semibold tabular-nums text-slate-200">
                    {Number(
                      isItemsMode
                        ? hovered.raw.boxes ?? hovered.raw.value ?? 0
                        : hovered.raw.items ?? 0
                    ).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
