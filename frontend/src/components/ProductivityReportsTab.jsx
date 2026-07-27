import React, { useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  FileSpreadsheet, Download, AlertTriangle, TrendingUp,
  Layers, Activity, ClipboardList, BarChart3, Loader2
} from 'lucide-react'
import { format } from 'date-fns'
import { getShipmentPriority, getPackingPercent } from '../utils/priority'

const CRIT_SECTIONS = [
  { key: 'critical', label: 'Critical / Delayed', header: 'bg-red-50 border-red-200 text-red-800', dot: 'bg-red-500' },
  { key: 'high', label: 'High / At Risk', header: 'bg-orange-50 border-orange-200 text-orange-800', dot: 'bg-orange-500' },
  { key: 'medium', label: 'Medium / Attention', header: 'bg-amber-50 border-amber-200 text-amber-800', dot: 'bg-amber-500' },
  { key: 'normal', label: 'On Track', header: 'bg-emerald-50 border-emerald-200 text-emerald-800', dot: 'bg-emerald-500' },
]

const SHEETS = [
  { icon: BarChart3, name: 'Summary', desc: 'KPIs, criticality counts, productivity metrics, actionable insights' },
  { icon: ClipboardList, name: 'Shipments Detail', desc: 'Every consignment field with color-coded priority' },
  { icon: TrendingUp, name: 'Production Planning', desc: 'Open shipments with dispatch dates and pending units' },
  { icon: Layers, name: 'SKU Pending', desc: 'SKU-level pending breakdown across consignments' },
  { icon: Activity, name: 'Packing Activity', desc: 'Box saves and events in the selected date range' },
  { icon: FileSpreadsheet, name: 'Audit Log', desc: 'System audit trail with timestamps and ownership' },
]

function getCriticalityBreakdown(consignments = []) {
  const groups = { critical: [], high: [], medium: [], normal: [] }
  for (const consignment of consignments) {
    const priority = getShipmentPriority(consignment)
    const level = groups[priority.level] ? priority.level : 'normal'
    groups[level].push(consignment)
  }
  return {
    critical: groups.critical.length,
    high: groups.high.length,
    medium: groups.medium.length,
    normal: groups.normal.length,
    groups,
  }
}

export default function ProductivityReportsTab({
  loading,
  dateRange,
  activePreset,
  stats,
  consignments,
  planning,
  auditLogs,
}) {
  const [exporting, setExporting] = useState(false)

  const breakdown = useMemo(() => getCriticalityBreakdown(consignments), [consignments])

  const insights = useMemo(() => {
    const items = []
    if (breakdown.critical > 0) {
      items.push({ type: 'critical', text: `${breakdown.critical} shipment(s) require immediate action` })
    }
    if (planning?.summary?.delayedShipments > 0) {
      items.push({ type: 'critical', text: `${planning.summary.delayedShipments} shipment(s) are past dispatch deadline` })
    }
    if (breakdown.high > 0) {
      items.push({ type: 'high', text: `${breakdown.high} shipment(s) at risk within 4 days` })
    }
    if (planning?.summary?.totalPendingQty > 0) {
      items.push({ type: 'medium', text: `${planning.summary.totalPendingQty.toLocaleString()} units still pending across open consignments` })
    }
    if (items.length === 0) {
      items.push({ type: 'normal', text: 'All shipments are on track — no urgent actions required' })
    }
    return items
  }, [breakdown, planning])

  const handleExport = async () => {
    try {
      setExporting(true)
      const { exportProductivityExcel } = await import('../utils/productivityExcelExport')
      await exportProductivityExcel({
        dateRange,
        stats,
        consignments,
        planning,
        auditLogs,
      })
    } catch (e) {
      console.error('Excel export failed', e)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Hero export card */}
      <div className="bg-gradient-to-br from-primary-600 via-primary-500 to-primary-300 rounded-2xl p-6 sm:p-8 text-white shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 mb-2">
              <FileSpreadsheet className="w-5 h-5 opacity-90" />
              <span className="text-xs font-semibold uppercase tracking-wider opacity-80">Excel Report</span>
            </div>
            <h2 className="text-2xl font-bold mb-2">Comprehensive Operations Report</h2>
            <p className="text-sm text-white/80 leading-relaxed">
              Multi-sheet workbook with summary statistics, full shipment detail, production planning,
              SKU breakdown, packing activity, and audit logs — formatted with priority color-coding,
              filters, and auto-sized columns.
            </p>
            <p className="text-xs text-white/60 mt-3">
              Period: <strong className="text-white/90">{activePreset}</strong>
              {' · '}{dateRange.start} → {dateRange.end}
              {' · '}{consignments.length} consignments
            </p>
          </div>
          <button
            onClick={handleExport}
            disabled={loading || exporting || consignments.length === 0}
            className="flex items-center justify-center gap-2.5 px-6 py-3.5 bg-white text-primary-700 rounded-xl font-bold text-sm hover:bg-primary-50 disabled:opacity-50 shadow-md transition-all hover:shadow-lg shrink-0"
          >
            {exporting ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Generating…</>
            ) : (
              <><Download className="w-5 h-5" /> Download Excel (.xlsx)</>
            )}
          </button>
        </div>
      </div>

      {/* Criticality breakdown */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {CRIT_SECTIONS.map(({ key, label, header, dot }) => (
          <div key={key} className={`rounded-xl border p-4 ${header}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</p>
            </div>
            <p className="text-3xl font-bold">{loading ? '…' : breakdown[key]}</p>
          </div>
        ))}
      </div>

      {/* Insights + sheet list */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> Actionable Insights
          </h3>
          <ul className="space-y-2">
            {insights.map((item, i) => (
              <li key={i} className={`flex items-start gap-2 text-sm px-3 py-2 rounded-lg ${
                item.type === 'critical' ? 'bg-red-50 text-red-800' :
                item.type === 'high' ? 'bg-orange-50 text-orange-800' :
                item.type === 'medium' ? 'bg-amber-50 text-amber-800' :
                'bg-emerald-50 text-emerald-800'
              }`}>
                <span className="mt-0.5">•</span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-4">Workbook Sheets (6)</h3>
          <div className="space-y-2">
            {SHEETS.map(({ icon: Icon, name, desc }) => (
              <div key={name} className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-slate-50">
                <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-primary-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-800">{name}</p>
                  <p className="text-xs text-slate-500">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Preview by criticality */}
      {CRIT_SECTIONS.map(({ key, label, header, dot }) => {
        const items = breakdown.groups[key] || []
        if (items.length === 0) return null
        const preview = [...items]
          .sort((a, b) => getShipmentPriority(a).sort - getShipmentPriority(b).sort)
          .slice(0, 8)
        return (
          <div key={key} className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
            <div className={`px-4 py-3 border-b flex items-center justify-between ${header}`}>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                <h3 className="text-sm font-bold">{label}</h3>
              </div>
              <span className="text-xs font-semibold opacity-70">{items.length} total</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-2 text-slate-500 font-semibold uppercase">Shipment</th>
                    <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase">Status</th>
                    <th className="text-left px-3 py-2 text-slate-500 font-semibold uppercase">Dispatch</th>
                    <th className="text-right px-3 py-2 text-slate-500 font-semibold uppercase">Progress</th>
                    <th className="text-right px-3 py-2 text-slate-500 font-semibold uppercase">Pending</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {preview.map(c => {
                    const p = getShipmentPriority(c)
                    const pct = getPackingPercent(c)
                    const pending = Math.max(0, (c.totalRequiredQty || 0) - (c.totalPackedQty || 0))
                    return (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-medium text-slate-800">{c.internalShipmentNo || c.id}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${p.badgeClass}`}>
                            {p.displayLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                          {c.requiredDispatchDate || c.scheduledDispatchDate
                            ? format(new Date(c.requiredDispatchDate || c.scheduledDispatchDate), 'dd MMM yyyy')
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-700">{pct}%</td>
                        <td className="px-3 py-2 text-right font-bold text-amber-600">{pending}</td>
                        <td className="px-3 py-2 text-right">
                          <Link to={`/consignments/${c.id}`} className="text-primary-600 hover:underline">View</Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {items.length > 8 && (
              <p className="text-xs text-slate-400 px-4 py-2 border-t border-slate-50">
                + {items.length - 8} more in Excel export
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
