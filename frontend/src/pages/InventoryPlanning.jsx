import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, Factory, Loader2, Package,
  RefreshCw, Search, Send, Settings2, Warehouse, XCircle,
} from 'lucide-react'
import { inventoryPlanningAPI } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'

const STATUS_STYLES = {
  Sufficient: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'Low Inventory': 'bg-amber-50 text-amber-900 border-amber-200',
  'Urgent Production Required': 'bg-orange-50 text-orange-900 border-orange-200',
  'Critical Shortage': 'bg-red-50 text-red-900 border-red-200',
  'Inventory Data Missing': 'bg-slate-100 text-slate-800 border-slate-300',
  'Sheet Sync Failed': 'bg-rose-50 text-rose-900 border-rose-200',
  'OMSGuru Sync Failed': 'bg-rose-50 text-rose-900 border-rose-200',
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[status] || 'bg-slate-50 text-slate-700 border-slate-200'}`}>
      <span className="sr-only">Status:</span>
      {status || '—'}
    </span>
  )
}

function Metric({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-900',
    teal: 'text-teal-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    emerald: 'text-emerald-700',
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone] || tones.slate}`}>{value ?? '—'}</div>
    </div>
  )
}

function emailsToText(list) {
  return Array.isArray(list) ? list.join(', ') : ''
}

function textToEmails(text) {
  return String(text || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export default function InventoryPlanning() {
  const { addToast } = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'organization_head'

  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sending, setSending] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [report, setReport] = useState(null)
  const [syncStatus, setSyncStatus] = useState(null)
  const [tab, setTab] = useState('skus')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [settings, setSettings] = useState(null)
  const [settingsForm, setSettingsForm] = useState(null)

  const loadReport = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      const [reportRes, syncRes] = await Promise.all([
        inventoryPlanningAPI.getReport(refresh),
        inventoryPlanningAPI.getSyncStatus(),
      ])
      setReport(reportRes.data)
      setSyncStatus(syncRes.data)
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load inventory planning', 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  const loadSettings = useCallback(async () => {
    if (!isAdmin) return
    try {
      const res = await inventoryPlanningAPI.getSettings()
      setSettings(res.data.settings)
      setSettingsForm({
        ...res.data.settings,
        productionTeamEmails: emailsToText(res.data.settings.productionTeamEmails),
        inventoryTeamEmails: emailsToText(res.data.settings.inventoryTeamEmails),
        organisationHeadCcEmails: emailsToText(res.data.settings.organisationHeadCcEmails),
        additionalCcEmails: emailsToText(res.data.settings.additionalCcEmails),
      })
    } catch (e) {
      addToast(e.response?.data?.error || 'Failed to load inventory settings', 'error')
    }
  }, [addToast, isAdmin])

  useEffect(() => {
    loadReport(true)
    loadSettings()
  }, [loadReport, loadSettings])

  const summary = report?.summary || {}
  const skus = report?.skus || []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skus.filter((row) => {
      if (statusFilter && row.inventoryStatus !== statusFilter) return false
      if (!q) return true
      return (
        row.internalSku?.toLowerCase().includes(q) ||
        row.productName?.toLowerCase().includes(q) ||
        row.marketplace?.toLowerCase().includes(q) ||
        (row.consignmentIds || []).join(' ').toLowerCase().includes(q)
      )
    })
  }, [skus, query, statusFilter])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const syncRes = await inventoryPlanningAPI.syncNow()
      if (syncRes.data?.ok === false) {
        throw new Error(syncRes.data?.error || 'Sync failed')
      }
      addToast(
        syncRes.data?.completed
          ? `Synced ${syncRes.data?.result?.skusUpdated ?? ''} SKUs` +
            (syncRes.data?.ej1201 ? ` · EJ1201-16001 = ${syncRes.data.ej1201.qty}` : '') +
            (syncRes.data?.sheetMeta?.sheetName ? ` from "${syncRes.data.sheetMeta.sheetName}"` : '')
          : 'Inventory synced from Google Sheet',
        'success'
      )
      await loadReport(true)
    } catch (e) {
      const msg =
        e.response?.data?.error ||
        e.response?.data?.probe?.error ||
        e.message ||
        'Sync failed'
      addToast(msg, 'error')
      try {
        const syncRes = await inventoryPlanningAPI.getSyncStatus()
        setSyncStatus(syncRes.data)
      } catch (_) { /* ignore */ }
    } finally {
      setSyncing(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await inventoryPlanningAPI.downloadExcel()
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Inventory_Planning_${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      addToast('Excel report downloaded', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Download failed', 'error')
    } finally {
      setExporting(false)
    }
  }

  const handleSendEmail = async () => {
    setSending(true)
    try {
      const res = await inventoryPlanningAPI.sendNotify()
      if (res.data?.ok) addToast('Inventory planning email sent', 'success')
      else addToast(res.data?.reason || 'Email not sent', 'error')
    } catch (e) {
      addToast(e.response?.data?.error || 'Email failed', 'error')
    } finally {
      setSending(false)
    }
  }

  const handleSaveSettings = async () => {
    if (!settingsForm) return
    setSavingSettings(true)
    try {
      const payload = {
        ...settingsForm,
        productionTeamEmails: textToEmails(settingsForm.productionTeamEmails),
        inventoryTeamEmails: textToEmails(settingsForm.inventoryTeamEmails),
        organisationHeadCcEmails: textToEmails(settingsForm.organisationHeadCcEmails),
        additionalCcEmails: textToEmails(settingsForm.additionalCcEmails),
        syncHourUtc: Number(settingsForm.syncHourUtc),
        syncMinuteUtc: Number(settingsForm.syncMinuteUtc),
        syncHourLocal: Number(settingsForm.syncHourLocal ?? 10),
        syncMinuteLocal: Number(settingsForm.syncMinuteLocal ?? 30),
        syncTimezone: settingsForm.syncTimezone || 'Asia/Kolkata',
        sheetFetchBatchSize: Number(settingsForm.sheetFetchBatchSize || 2000),
        sheetFetchPauseMs: Number(settingsForm.sheetFetchPauseMs ?? 2000),
        emailDailyHourUtc: Number(settingsForm.emailDailyHourUtc),
        emailMinIntervalMinutes: Number(settingsForm.emailMinIntervalMinutes),
        reportRetentionDays: Number(settingsForm.reportRetentionDays),
        googleSheetId: settingsForm.googleSheetId,
        googleSheetName: settingsForm.googleSheetName,
        enabled: Boolean(settingsForm.enabled),
        syncEnabled: Boolean(settingsForm.syncEnabled),
        treatMissingInventoryAsZero: Boolean(settingsForm.treatMissingInventoryAsZero),
        emailOnResolvedShortage: Boolean(settingsForm.emailOnResolvedShortage),
        emailDailyReport: Boolean(settingsForm.emailDailyReport),
        emailAfterDailySync: settingsForm.emailAfterDailySync !== false,
        autoCcOrganisationHeadUsers: Boolean(settingsForm.autoCcOrganisationHeadUsers),
        preferSheetColumnC: settingsForm.preferSheetColumnC !== false,
      }
      const res = await inventoryPlanningAPI.updateSettings(payload)
      setSettings(res.data.settings)
      addToast('Inventory planning settings saved', 'success')
    } catch (e) {
      addToast(e.response?.data?.error || 'Save failed', 'error')
    } finally {
      setSavingSettings(false)
    }
  }

  if (loading && !report) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading inventory planning…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-teal-700 text-sm font-semibold uppercase tracking-wider">
            <Factory className="w-4 h-4" /> Inventory Planning
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Internal SKU demand vs sheet inventory</h1>
          <p className="mt-1 text-sm text-slate-600 max-w-2xl">
            Uses Internal SKUs from consignments that are created or planned but not fully packed.
            Compares Google Sheet Column C available qty with total planned remaining quantity, then alerts Production.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => loadReport(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing || syncStatus?.running}
              className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
            >
              {syncing || syncStatus?.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Warehouse className="w-4 h-4" />}
              Sync from Sheet
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download XLSX
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={handleSendEmail}
              disabled={sending}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send email
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Metric label="Active consignments" value={summary.activeConsignmentCount} />
        <Metric label="SKUs reviewed" value={summary.totalSkusReviewed} />
        <Metric label="Critical shortages" value={summary.criticalShortageSkuCount} tone="red" />
        <Metric label="Urgent SKUs" value={summary.urgentSkuCount} tone="amber" />
        <Metric label="Total shortage" value={summary.totalShortageQty} tone="red" />
        <Metric label="Suggested production" value={summary.totalSuggestedProductionQty} tone="teal" />
      </div>

      <div className="flex flex-wrap gap-2 border-b border-slate-200">
        {[
          { id: 'skus', label: 'SKU Planning' },
          { id: 'critical', label: 'Critical & Urgent' },
          { id: 'consignments', label: 'Consignment Details' },
          ...(isAdmin ? [{ id: 'settings', label: 'Admin Settings' }] : []),
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${
              tab === t.id
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(tab === 'skus' || tab === 'critical') && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search SKU, product, marketplace, consignment…"
                className="w-full rounded-lg border border-slate-200 pl-9 pr-3 py-2 text-sm"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {Object.keys(STATUS_STYLES).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Internal SKU</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Planned</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Crit / Urg / Norm</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Inventory (Col C)</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Avail − Planned</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Shortage</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Produce</th>
                  <th className="px-3 py-2.5 font-semibold">Consignments</th>
                  <th className="px-3 py-2.5 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {(tab === 'critical'
                  ? filtered.filter((r) =>
                      r.inventoryStatus === 'Critical Shortage' ||
                      r.inventoryStatus === 'Urgent Production Required' ||
                      r.criticalShortage > 0 ||
                      r.urgentShortage > 0
                    )
                  : filtered
                ).map((row) => (
                  <tr key={row.internalSku} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs font-semibold text-slate-900">{row.internalSku}</div>
                      <div className="text-xs text-slate-500">{row.productName || row.marketplace || '—'}</div>
                    </td>
                    <td className="px-3 py-2.5"><StatusBadge status={row.inventoryStatus} /></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{row.totalPlannedQty}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                      {row.criticalQty} / {row.urgentQty} / {row.normalQty}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {row.latestInventory == null ? '—' : row.latestInventory}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${
                      row.inventoryBalance == null
                        ? 'text-slate-400'
                        : row.inventoryBalance < 0
                          ? 'text-red-700'
                          : 'text-emerald-700'
                    }`}>
                      {row.inventoryBalance == null ? '—' : row.inventoryBalance}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-red-700">{row.totalShortage}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-teal-800">{row.suggestedProductionQty}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[180px]">
                      {(row.consignmentIds || []).join(', ') || '—'}
                      <div className="text-[11px] text-slate-400">{row.activeConsignmentCount} active</div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 max-w-[220px]">{row.recommendedAction}</td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-slate-500">
                      <Package className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                      No SKUs match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'consignments' && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Consignment</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Internal SKU</th>
                <th className="px-3 py-2.5 font-semibold text-right">Planned</th>
                <th className="px-3 py-2.5 font-semibold">Priority</th>
                <th className="px-3 py-2.5 font-semibold">Appointment</th>
                <th className="px-3 py-2.5 font-semibold">Deadline</th>
                <th className="px-3 py-2.5 font-semibold text-right">TAT</th>
                <th className="px-3 py-2.5 font-semibold text-right">Packed %</th>
                <th className="px-3 py-2.5 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {(report?.consignments || []).map((row, idx) => (
                <tr key={`${row.consignmentId}-${row.internalSku}-${idx}`} className="border-t border-slate-100">
                  <td className="px-3 py-2.5 font-mono text-xs">{row.consignmentId}</td>
                  <td className="px-3 py-2.5 text-xs">{row.status} / {row.shipmentStatus || '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{row.internalSku}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.plannedQty}</td>
                  <td className="px-3 py-2.5 capitalize text-xs">{row.priorityBucket || row.criticalityLevel}</td>
                  <td className="px-3 py-2.5 text-xs">{row.appointmentDate || '—'}</td>
                  <td className="px-3 py-2.5 text-xs">{row.shippingDeadline || '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.warehouseTatDays ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.packingProgress ?? '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-700">{row.recommendedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'settings' && isAdmin && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
          <div className="flex items-center gap-2 text-slate-900 font-semibold">
            <Settings2 className="w-4 h-4" /> Inventory Planning configuration
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-wrap gap-4 text-sm text-slate-600">
            <div>
              <span className="font-semibold text-slate-800">Sheet sync:</span>{' '}
              {summary.sheetSyncStatus || summary.omsGuruSyncStatus || syncStatus?.lastSyncStatus || 'never'}
            </div>
            <div>
              <span className="font-semibold text-slate-800">Last sync:</span>{' '}
              {summary.lastInventorySyncAt
                ? new Date(summary.lastInventorySyncAt).toLocaleString('en-GB')
                : '—'}
            </div>
            <div>
              <span className="font-semibold text-slate-800">Earliest ship/appt:</span>{' '}
              {summary.earliestShipmentOrAppointmentDate || '—'}
            </div>
            <div>
              <span className="font-semibold text-slate-800">Planned qty:</span> {summary.totalPlannedQty ?? 0}
              {' · '}
              <span className="font-semibold text-slate-800">Available:</span> {summary.totalAvailableInventory ?? 0}
            </div>
            {syncStatus?.connection && (
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                {syncStatus.connection.googleSheetsConfigured && syncStatus.connection.googleSheetsJsonValid !== false
                  ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Google Sheets connected</span>
                  : <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="w-3.5 h-3.5" /> Google Sheets not configured</span>}
                {syncStatus.connection.resendConfigured
                  ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Resend ready (auto email)</span>
                  : <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="w-3.5 h-3.5" /> Resend not configured</span>}
                <span className="text-slate-500">Inventory source: Google Sheet Column C (Inventory)</span>
              </div>
            )}
            {(syncStatus?.lastSyncError || syncStatus?.latestRun?.error_message || syncStatus?.connection?.hint) && (
              <div className="basis-full w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {syncStatus?.lastSyncError || syncStatus?.latestRun?.error_message || syncStatus?.connection?.hint}
                {syncStatus?.connection?.googleSheetsClientEmail && (
                  <div className="mt-1 text-xs text-amber-800">
                    Service account: {syncStatus.connection.googleSheetsClientEmail} — share the sheet with this email (Editor).
                  </div>
                )}
                {syncStatus?.latestRun?.details?.fetchMeta?.sheetName && (
                  <div className="mt-1 text-xs text-amber-800">
                    Last sheet tab: {syncStatus.latestRun.details.fetchMeta.sheetName}
                    {syncStatus.latestRun.details.fetchMeta.spreadsheetTitle
                      ? ` · Workbook: ${syncStatus.latestRun.details.fetchMeta.spreadsheetTitle}`
                      : ''}
                  </div>
                )}
              </div>
            )}
            {syncStatus?.connection?.googleSheetsConfigured && !syncStatus?.lastSyncError && syncStatus?.connection?.googleSheetsClientEmail && (
              <div className="basis-full w-full text-xs text-slate-500">
                Sheet reader: {syncStatus.connection.googleSheetsClientEmail}
              </div>
            )}
          </div>

          {!settingsForm ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading admin settings…
            </div>
          ) : (
            <>
          <p className="text-sm text-slate-600">
            Inventory comes from Google Sheet Column C (matched by Internal SKU / sku_code).
            The app auto-picks the workbook tab with real stock (AutoFetch, Total Inventory, etc.).
            Demand = remaining qty on consignments created or under packing, not fully packed.
            Shortage email goes to the Production team once daily at 10:30 IST after sync + analysis.
            Organisation Head is CC’d automatically. Use Send email for an on-demand report.
          </p>

          <div className="grid md:grid-cols-2 gap-4">
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Google Sheet ID</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.googleSheetId || ''}
                onChange={(e) => setSettingsForm({ ...settingsForm, googleSheetId: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Sheet name</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.googleSheetName || ''}
                onChange={(e) => setSettingsForm({ ...settingsForm, googleSheetName: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Daily sync hour (India / IST)</span>
              <input
                type="number"
                min={0}
                max={23}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.syncHourLocal ?? 10}
                onChange={(e) => setSettingsForm({ ...settingsForm, syncHourLocal: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Daily sync minute (IST)</span>
              <input
                type="number"
                min={0}
                max={59}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.syncMinuteLocal ?? 30}
                onChange={(e) => setSettingsForm({ ...settingsForm, syncMinuteLocal: e.target.value })}
              />
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Sheet fetch batch size</span>
              <input
                type="number"
                min={100}
                max={5000}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.sheetFetchBatchSize ?? 2000}
                onChange={(e) => setSettingsForm({ ...settingsForm, sheetFetchBatchSize: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">Default 2000 SKU rows per Google Sheet request</span>
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Pause between batches (ms)</span>
              <input
                type="number"
                min={0}
                max={30000}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.sheetFetchPauseMs ?? 2000}
                onChange={(e) => setSettingsForm({ ...settingsForm, sheetFetchPauseMs: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">Default 2000 ms (2 seconds) to avoid API limits</span>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="font-semibold text-slate-700">Production team (To)</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                placeholder="production@vbexports.co.in, dispatches@vbexports.co.in"
                value={settingsForm.productionTeamEmails}
                onChange={(e) => setSettingsForm({ ...settingsForm, productionTeamEmails: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">
                Defaults: production@vbexports.co.in, dispatches@vbexports.co.in
              </span>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="font-semibold text-slate-700">Organisation Head (Cc)</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                placeholder="Leave blank to auto-CC users with Organisation Head role"
                value={settingsForm.organisationHeadCcEmails}
                onChange={(e) => setSettingsForm({ ...settingsForm, organisationHeadCcEmails: e.target.value })}
              />
            </label>
            <label className="text-sm md:col-span-2">
              <span className="font-semibold text-slate-700">Additional Cc</span>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
                value={settingsForm.additionalCcEmails}
                onChange={(e) => setSettingsForm({ ...settingsForm, additionalCcEmails: e.target.value })}
              />
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            {[
              ['enabled', 'Feature enabled'],
              ['syncEnabled', 'Scheduled daily sheet sync at 10:30 IST'],
              ['autoCcOrganisationHeadUsers', 'Auto-CC Organisation Head users when Cc list is empty'],
              ['emailDailyReport', 'Daily email report (10:30 IST)'],
              ['emailAfterDailySync', 'Send report right after morning sync (recommended)'],
              ['treatMissingInventoryAsZero', 'Treat missing inventory as zero'],
              ['preferSheetColumnC', 'Prefer Google Sheet Column C for available qty'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(settingsForm[key])}
                  onChange={(e) => setSettingsForm({ ...settingsForm, [key]: e.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700 space-y-2">
            <div className="font-semibold">Priority bucket mapping (existing criticality → planning)</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {['critical', 'high', 'medium', 'normal'].map((level) => (
                <label key={level} className="flex items-center justify-between gap-2">
                  <span className="capitalize">{level}</span>
                  <select
                    className="rounded border border-slate-200 px-2 py-1"
                    value={settingsForm.bucketMap?.[level] || 'normal'}
                    onChange={(e) => setSettingsForm({
                      ...settingsForm,
                      bucketMap: { ...settingsForm.bucketMap, [level]: e.target.value },
                    })}
                  >
                    <option value="critical">Critical</option>
                    <option value="urgent">Urgent</option>
                    <option value="normal">Normal</option>
                  </select>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              Defaults: critical→Critical, high→Urgent, medium/normal→Normal (from existing TAT / dispatch criticality).
            </p>
          </div>

          <button
            type="button"
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
          >
            {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Save settings
          </button>

          {settings?.lastSyncError && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              Last sync error: {settings.lastSyncError}
            </div>
          )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
