/**
 * Comprehensive Productivity & Operations Excel report (.xlsx)
 * Sheets: Summary, Shipments, Planning, SKU Pending, Packing Activity, Audit Log
 */
import ExcelJS from 'exceljs'
import { format } from 'date-fns'
import { getShipmentPriority, getPackingPercent } from './priority'

const HEADER_FILL = 'FF312E81'
const HEADER_FONT = 'FFFFFFFF'

const CRIT_FILLS = {
  critical: { fill: 'FFFEE2E2', font: 'FF991B1B' },
  high: { fill: 'FFFFEDD5', font: 'FFC2410C' },
  medium: { fill: 'FFFEF3C7', font: 'FFB45309' },
  normal: { fill: 'FFECFDF5', font: 'FF047857' },
  warning: { fill: 'FFFFEDD5', font: 'FFC2410C' },
}

function critStyle(level) {
  return CRIT_FILLS[level] || CRIT_FILLS.normal
}

function fmtDate(d) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    if (Number.isNaN(dt.getTime())) return String(d)
    return format(dt, 'dd MMM yyyy')
  } catch {
    return String(d)
  }
}

function fmtDateTime(d) {
  if (!d) return ''
  try {
    return format(new Date(d), 'dd MMM yyyy HH:mm')
  } catch {
    return String(d)
  }
}

function autoWidth(sheet, min = 10, max = 48) {
  sheet.columns.forEach((col) => {
    let w = min
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0
      w = Math.max(w, Math.min(len + 2, max))
    })
    col.width = w
  })
}

function styleHeaderRow(sheet, rowNum, colCount) {
  const row = sheet.getRow(rowNum)
  row.height = 22
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c)
    cell.font = { bold: true, color: { argb: HEADER_FONT }, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    }
  }
  row.commit?.()
}

function addTitle(sheet, title, subtitle) {
  sheet.mergeCells('A1:F1')
  const t = sheet.getCell('A1')
  t.value = title
  t.font = { bold: true, size: 16, color: { argb: HEADER_FILL } }
  if (subtitle) {
    sheet.mergeCells('A2:F2')
    sheet.getCell('A2').value = subtitle
    sheet.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } }
  }
}

function applyCriticalityRow(row, level) {
  const s = critStyle(level)
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fill } }
    if (cell.col === 1 || String(cell.value).match(/Critical|High|Medium|On Track|Delayed/i)) {
      cell.font = { ...(cell.font || {}), bold: true, color: { argb: s.font } }
    }
  })
}

function shipmentRow(c) {
  const p = getShipmentPriority(c)
  const pct = getPackingPercent(c)
  return {
    priority: p,
    values: [
      p.displayLabel || p.label,
      p.level,
      c.id,
      c.internalShipmentNo || '',
      c.shipmentNo || '',
      c.name || '',
      c.status || '',
      c.shipmentStatus || '',
      c.marketplaceId || '',
      c.warehouse || '',
      fmtDate(c.appointmentDate),
      fmtDate(c.requiredDispatchDate || c.scheduledDispatchDate),
      fmtDate(c.actualDispatchDate),
      fmtDate(c.expectedDate),
      fmtDate(c.dateOfInward),
      p.daysUntilDispatch ?? '',
      pct,
      c.totalRequiredQty || 0,
      c.totalPackedQty || 0,
      Math.max(0, (c.totalRequiredQty || 0) - (c.totalPackedQty || 0)),
      c.boxIds?.length || c.boxes?.length || 0,
      c.docketCompany || '',
      c.docketNo || '',
      c.forwardInvoiceNo || '',
      c.marketplaceTicketId || '',
      c.unitsShipped ?? '',
      c.unitsReceived ?? '',
      c.unitsInwarded ?? '',
      c.qaFailExcessQty ?? '',
      fmtDateTime(c.createdAt),
      fmtDateTime(c.updatedAt),
      p.sublabel || '',
    ],
  }
}

const SHIPMENT_HEADERS = [
  'Criticality', 'Priority Level', 'Consignment ID', 'Internal Shipment No', 'Shipment No', 'Name',
  'Pack Status', 'Ship Status', 'Marketplace ID', 'Warehouse',
  'Appointment', 'Req. Dispatch', 'Actual Dispatch', 'Expected Date', 'Date of Inward',
  'Days Until Dispatch', 'Progress %', 'Required Qty', 'Packed Qty', 'Pending Qty', 'Boxes',
  'Docket Company', 'Docket No', 'Forward Invoice', 'Marketplace Ticket',
  'Units Shipped', 'Units Received', 'Units Inwarded', 'QA Fail/Excess',
  'Created At', 'Updated At', 'Insight',
]

/**
 * @param {object} data
 * @param {object} data.dateRange - { start, end }
 * @param {object} data.stats - productivity API response
 * @param {Array} data.consignments
 * @param {object} data.planning
 * @param {Array} data.auditLogs
 */
export async function exportProductivityExcel({
  dateRange,
  stats,
  consignments = [],
  planning,
  auditLogs = [],
}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Youthnic Packing Station'
  wb.created = new Date()

  const reportDate = format(new Date(), 'yyyy-MM-dd_HHmm')
  const rangeLabel = `${dateRange?.start || '—'} to ${dateRange?.end || '—'}`

  // ── Sheet 1: Summary ─────────────────────────────────────────────────────
  const summary = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] })
  addTitle(summary, 'Productivity & Operations Report', `Report period: ${rangeLabel} · Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`)

  const byCrit = { critical: 0, high: 0, medium: 0, normal: 0 }
  consignments.forEach((c) => {
    const lvl = getShipmentPriority(c).level
    if (byCrit[lvl] !== undefined) byCrit[lvl]++
    else byCrit.normal++
  })

  const rows = [
    ['', ''],
    ['OPERATIONS SUMMARY', ''],
    ['Total Consignments', consignments.length],
    ['Pending', consignments.filter((c) => c.status === 'pending').length],
    ['In Progress', consignments.filter((c) => c.status === 'in_progress').length],
    ['Completed', consignments.filter((c) => c.status === 'completed').length],
    ['', ''],
    ['CRITICALITY BREAKDOWN', ''],
    ['Critical / Delayed', byCrit.critical],
    ['High / At Risk', byCrit.high],
    ['Medium / Attention', byCrit.medium],
    ['On Track', byCrit.normal],
    ['', ''],
    ['UNITS SUMMARY', ''],
    ['Total Required Units', consignments.reduce((s, c) => s + (c.totalRequiredQty || 0), 0)],
    ['Total Packed Units', consignments.reduce((s, c) => s + (c.totalPackedQty || 0), 0)],
    ['Total Pending Units', consignments.reduce((s, c) => s + Math.max(0, (c.totalRequiredQty || 0) - (c.totalPackedQty || 0)), 0)],
    ['', ''],
    ['PRODUCTIVITY (SELECTED PERIOD)', ''],
    ['Boxes Packed', stats?.summary?.totalBoxes ?? 0],
    ['Items Packed', stats?.summary?.totalItems ?? 0],
    ['Avg Items / Box', stats?.summary?.avgItemsPerBox ?? '—'],
    ['Avg Time / Box (sec)', stats?.summary?.avgTimePerBoxSeconds ?? '—'],
    ['Boxes Today', stats?.today?.boxes ?? 0],
    ['Items Today', stats?.today?.items ?? 0],
  ]

  if (planning?.summary) {
    rows.push(['', ''], ['PRODUCTION PLANNING', ''])
    rows.push(['Open Consignments', planning.summary.openConsignments])
    rows.push(['Critical Shipments', planning.summary.criticalShipments])
    rows.push(['High Priority', planning.summary.highPriorityShipments])
    rows.push(['Delayed Shipments', planning.summary.delayedShipments])
    rows.push(['Pending Units (Open)', planning.summary.totalPendingQty])
    rows.push(['Unique Pending SKUs', planning.summary.uniquePendingSkus])
  }

  rows.push(['', ''], ['ACTIONABLE INSIGHTS', ''])
  if (byCrit.critical > 0) rows.push(['⚠ Action', `${byCrit.critical} shipment(s) need immediate attention`])
  if (planning?.summary?.delayedShipments > 0) rows.push(['⚠ Action', `${planning.summary.delayedShipments} shipment(s) past dispatch deadline`])
  if (byCrit.high > 0) rows.push(['◆ Watch', `${byCrit.high} shipment(s) at risk within 4 days`])
  rows.push(['✓ Tip', 'Review "Shipments Detail" sheet sorted by criticality for dispatch planning'])

  let r = 4
  rows.forEach(([a, b]) => {
    summary.getCell(`A${r}`).value = a
    summary.getCell(`B${r}`).value = b
    if (String(a).includes('SUMMARY') || String(a).includes('BREAKDOWN') || String(a).includes('INSIGHTS') || String(a).includes('PRODUCTIVITY') || String(a).includes('PLANNING')) {
      summary.getCell(`A${r}`).font = { bold: true, color: { argb: HEADER_FILL } }
    }
    r++
  })
  summary.getColumn(1).width = 28
  summary.getColumn(2).width = 24

  // ── Sheet 2: Shipments Detail ────────────────────────────────────────────
  const detail = wb.addWorksheet('Shipments Detail', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: { row: 1, column: SHIPMENT_HEADERS.length } },
  })
  detail.addRow(SHIPMENT_HEADERS)
  styleHeaderRow(detail, 1, SHIPMENT_HEADERS.length)

  const sorted = [...consignments].sort((a, b) => {
    const pa = getShipmentPriority(a)
    const pb = getShipmentPriority(b)
    return (pa.sort ?? 0) - (pb.sort ?? 0)
  })

  sorted.forEach((c) => {
    const { priority, values } = shipmentRow(c)
    const row = detail.addRow(values)
    applyCriticalityRow(row, priority.level)
  })
  autoWidth(detail)

  // ── Sheet 3: Production Planning ─────────────────────────────────────────
  const planHeaders = [
    'Criticality', 'Level', 'Consignment ID', 'Internal Shipment No', 'Marketplace', 'Warehouse',
    'Pack Status', 'Ship Status', 'Appointment', 'Req. Dispatch', 'Days Until Dispatch',
    'Required', 'Packed', 'Pending', 'Progress %', 'Pending SKUs', 'Insight',
  ]
  const planSheet = wb.addWorksheet('Production Planning', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: { row: 1, column: planHeaders.length } },
  })
  planSheet.addRow(planHeaders)
  styleHeaderRow(planSheet, 1, planHeaders.length)

  ;(planning?.byConsignment || []).forEach((c) => {
    const p = getShipmentPriority(c)
    const pct = c.required > 0 ? Math.round((c.packed / c.required) * 100) : 0
    const row = planSheet.addRow([
      p.displayLabel, p.level, c.id, c.internalShipmentNo, c.marketplaceId, c.warehouse,
      c.status, c.shipmentStatus, fmtDate(c.appointmentDate),
      fmtDate(c.requiredDispatchDate || c.scheduledDispatchDate),
      c.daysUntilDispatch ?? p.daysUntilDispatch ?? '',
      c.required, c.packed, c.pending, pct, c.pendingSkuCount, p.sublabel,
    ])
    applyCriticalityRow(row, p.level)
  })
  autoWidth(planSheet)

  // ── Sheet 4: SKU Pending ─────────────────────────────────────────────────
  const skuHeaders = [
    'Internal SKU', 'Marketplace SKU', 'Barcode', 'Total Required', 'Total Packed', 'Total Pending',
    'Pending Consignments', 'Consignment Details (Shipment: Pending)',
  ]
  const skuSheet = wb.addWorksheet('SKU Pending', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: { row: 1, column: skuHeaders.length } },
  })
  skuSheet.addRow(skuHeaders)
  styleHeaderRow(skuSheet, 1, skuHeaders.length)
  ;(planning?.bySku || []).forEach((s) => {
    skuSheet.addRow([
      s.internalSku, s.marketplaceSku, s.barcode,
      s.totalRequired, s.totalPacked, s.totalPending,
      s.consignments?.length || 0,
      (s.consignments || []).map((c) => `${c.internalShipmentNo}:${c.pending}`).join(' | '),
    ])
  })
  autoWidth(skuSheet)

  // ── Sheet 5: Packing Activity ────────────────────────────────────────────
  const actHeaders = ['Timestamp', 'Event', 'Consignment ID', 'Box No', 'Items', 'Duration (sec)', 'User']
  const actSheet = wb.addWorksheet('Packing Activity', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: { row: 1, column: actHeaders.length } },
  })
  actSheet.addRow(actHeaders)
  styleHeaderRow(actSheet, 1, actHeaders.length)
  ;(stats?.recentActivity || []).forEach((a) => {
    actSheet.addRow([
      fmtDateTime(a.timestamp), a.eventType, a.consignmentId, a.boxNo || '',
      a.itemsCount || 0, a.duration || 0, a.userName || a.userId || '',
    ])
  })
  autoWidth(actSheet)

  // ── Sheet 6: Audit Log ───────────────────────────────────────────────────
  const auditHeaders = ['Timestamp', 'Action', 'Entity Type', 'Entity ID', 'User ID', 'Details']
  const auditSheet = wb.addWorksheet('Audit Log', {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: { from: 'A1', to: { row: 1, column: auditHeaders.length } },
  })
  auditSheet.addRow(auditHeaders)
  styleHeaderRow(auditSheet, 1, auditHeaders.length)
  auditLogs.forEach((l) => {
    auditSheet.addRow([
      fmtDateTime(l.timestamp), l.action, l.entityType, l.entityId, l.userId,
      l.details ? JSON.stringify(l.details) : '',
    ])
  })
  autoWidth(auditSheet)

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Youthnic_Productivity_Report_${reportDate}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

export function getCriticalityBreakdown(consignments = []) {
  const groups = { critical: [], high: [], medium: [], normal: [] }
  consignments.forEach((c) => {
    const lvl = getShipmentPriority(c).level
    const key = groups[lvl] ? lvl : 'normal'
    groups[key].push(c)
  })
  return {
    critical: groups.critical.length,
    high: groups.high.length,
    medium: groups.medium.length,
    normal: groups.normal.length,
    groups,
  }
}
