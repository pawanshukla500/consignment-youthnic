import JsBarcode from 'jsbarcode'
import { escapeHtml, openEscapedPrintWindow } from './printHtml'
import { createPdfDocument, measureText } from './pdfDocument'

/**
 * 4x6in shipment box label.
 *
 * One geometry model (points, 72 per inch) drives two renderers — the HTML
 * print window and the downloadable PDF — so what an operator sees on screen
 * is what comes out of the label printer. Both declare the 4x6 page size in
 * the document itself (CSS `@page` / PDF MediaBox), which is what lets a
 * printer pick the label stock on its default settings instead of scaling the
 * label onto A4.
 */

const INCH = 72
export const LABEL_PAGE = { width: 4 * INCH, height: 6 * INCH }

const PAD = 7
const FRAME = {
  x: PAD,
  y: PAD,
  width: LABEL_PAGE.width - PAD * 2,
  height: LABEL_PAGE.height - PAD * 2,
}

const BRAND_H = 15
const HERO_H = 46
const META_ROW_H = 14
const STAT_H = 17
const SECTION_H = 14
const THEAD_H = 13
const MIN_ROW_H = 11.4
const TOTAL_H = 15
const FOOT_H = 12

const HERO_SPLIT = 96
const META_LABEL_W = 78

// #, Barcode SKU, Internal SKU, Qty — must add up to FRAME.width.
const COLS = [20, 84, 128, 42]

const INK = '#0f172a'
const MUTED = '#475569'
const RULE = '#94a3b8'
const BAND = '#e2e8f0'
const ZEBRA = '#f1f5f9'
const PAPER = '#ffffff'

const BRAND = 'YOUTHNIC PACKING STATION'

function colX(index) {
  let x = FRAME.x
  for (let i = 0; i < index; i += 1) x += COLS[i]
  return x
}

function cleanText(value) {
  return String(value ?? '').trim()
}

function formatDateTime(date) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * Normalize one box into everything both renderers need, including the
 * page split. Rows per page are derived from the space the header actually
 * takes, so a label never spills past its 6in.
 */
export function buildLabelModel({
  consignmentId,
  internalShipmentNo,
  shipmentNo,
  box,
  boxIndex,
  boxCount,
  printedAt,
} = {}) {
  const items = box?.items || []
  const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
  const shipmentId = cleanText(internalShipmentNo || consignmentId)
  const cid = cleanText(consignmentId)
  const shipNo = cleanText(shipmentNo)
  const boxNo = cleanText(box?.boxNo)

  // Secondary identifiers only — the hero already carries the shipment id, so
  // don't repeat the same value three times when they all match.
  const metaRows = []
  if (cid && cid.toLowerCase() !== shipmentId.toLowerCase()) {
    metaRows.push({ label: 'Consignment ID', value: cid })
  }
  if (shipNo && shipNo.toLowerCase() !== shipmentId.toLowerCase() && shipNo.toLowerCase() !== cid.toLowerCase()) {
    metaRows.push({ label: 'Shipment No', value: shipNo })
  }
  if (!metaRows.length) metaRows.push({ label: 'Consignment ID', value: cid || shipmentId || '—' })

  const weight = box?.weight != null && box.weight !== '' && Number.isFinite(Number(box.weight))
    ? `${Number(box.weight).toFixed(2)} ${box.weightUnit || 'KG'}`
    : '—'

  const sequence = boxIndex > 0 && boxCount > 0
    ? `${boxIndex} of ${boxCount}`
    : (boxCount > 0 ? `${boxCount} total` : '')

  const statCells = [
    ...(sequence ? [{ label: 'Boxes', value: sequence }] : []),
    { label: 'SKU Lines', value: String(items.length) },
    { label: 'Packed Qty', value: String(totalQty) },
    { label: 'Weight', value: weight },
  ]

  const headerH = BRAND_H + HERO_H + metaRows.length * META_ROW_H + STAT_H + SECTION_H + THEAD_H
  const bodyH = FRAME.height - headerH - TOTAL_H - FOOT_H
  const rowsPerPage = Math.max(1, Math.floor(bodyH / MIN_ROW_H))
  const rowH = bodyH / rowsPerPage

  const rows = items.map((item, i) => ({
    n: i + 1,
    barcodeSku: cleanText(item.barcode || item.marketplaceBarcode || item.marketplaceSku) || '—',
    internalSku: cleanText(item.internalSku || item.name) || '—',
    qty: Number(item.qty) || 0,
  }))

  const pages = []
  for (let i = 0; i < rows.length; i += rowsPerPage) pages.push(rows.slice(i, i + rowsPerPage))
  if (!pages.length) pages.push([])

  const pageTotals = pages.map((page) => page.reduce((sum, row) => sum + row.qty, 0))

  return {
    shipmentId: shipmentId || '—',
    boxNo,
    boxHero: boxNo ? `#${boxNo}` : '—',
    sequence,
    metaRows,
    statCells,
    totalQty,
    itemCount: items.length,
    rowsPerPage,
    rowH,
    bodyH,
    pages,
    pageTotals,
    printedAt: formatDateTime(printedAt instanceof Date ? printedAt : new Date()),
  }
}

/* ------------------------------------------------------------------ HTML */

function pt(value) {
  return `${Math.round(value * 100) / 100}pt`
}

/**
 * Build 4x6 shipment box label HTML — bordered, fixed-height grid that mirrors
 * the PDF renderer cell for cell.
 */
export function buildShipmentBoxLabelHtml(options) {
  const model = buildLabelModel(options)
  const multi = model.pages.length > 1

  return model.pages.map((pageRows, idx) => {
    const isLast = idx === model.pages.length - 1
    const rowsHtml = pageRows.map((row, i) => `
              <tr class="${i % 2 ? 'zebra' : ''}" style="height:${pt(model.rowH)}">
                <td class="num-cell">${row.n}</td>
                <td class="sku-cell barcode-cell">${escapeHtml(row.barcodeSku)}</td>
                <td class="sku-cell internal-cell">${escapeHtml(row.internalSku)}</td>
                <td class="qty-cell">${row.qty}</td>
              </tr>`).join('')

    const filler = model.rowsPerPage - pageRows.length
    const fillerHtml = filler > 0 && pageRows.length
      ? `<tr class="filler"><td colspan="4" style="height:${pt(filler * model.rowH)}"></td></tr>`
      : ''

    const emptyHtml = pageRows.length
      ? ''
      : `<tr><td colspan="4" class="empty" style="height:${pt(model.bodyH)}">No items in this box</td></tr>`

    const metaHtml = model.metaRows.map((row) => `
              <tr>
                <td class="meta-label">${escapeHtml(row.label)}</td>
                <td class="meta-value">${escapeHtml(row.value)}</td>
              </tr>`).join('')

    const statWidth = `${(100 / model.statCells.length).toFixed(4)}%`
    const statHtml = model.statCells.map((cell) => `
                <td class="stat-cell" style="width:${statWidth}">
                  <span class="stat-label">${escapeHtml(cell.label)}</span>
                  <span class="stat-value">${escapeHtml(cell.value)}</span>
                </td>`).join('')

    return `
      <div class="label-page"${idx > 0 ? ' style="page-break-before:always"' : ''}>
        <div class="label-frame">
          <div class="brand-bar">
            <span>${escapeHtml(BRAND)}</span>
            <span>BOX LABEL</span>
          </div>

          <div class="hero">
            <div class="hero-box">
              <span class="hero-label">Box No</span>
              <span class="hero-box-value">${escapeHtml(model.boxHero)}</span>
            </div>
            <div class="hero-ship">
              <span class="hero-label">Internal Shipment</span>
              <span class="hero-ship-value">${escapeHtml(model.shipmentId)}</span>
            </div>
          </div>

          <table class="meta-table">
            <tbody>${metaHtml}</tbody>
          </table>

          <table class="stat-table">
            <tbody><tr>${statHtml}</tr></tbody>
          </table>

          <div class="section-title">
            <span>SKU Details</span>
            <span>${multi ? `Page ${idx + 1} of ${model.pages.length}` : `${model.itemCount} line${model.itemCount === 1 ? '' : 's'}`}</span>
          </div>

          <table class="sku-table">
            <colgroup>
              <col style="width:${pt(COLS[0])}" />
              <col style="width:${pt(COLS[1])}" />
              <col style="width:${pt(COLS[2])}" />
              <col style="width:${pt(COLS[3])}" />
            </colgroup>
            <thead>
              <tr>
                <th class="num-head">#</th>
                <th>Barcode SKU</th>
                <th>Internal SKU</th>
                <th class="qty-head">Qty</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}${emptyHtml}${fillerHtml}</tbody>
          </table>

          <table class="total-table">
            <tbody>
              <tr>
                <td class="total-label">${isLast ? 'Total Packed Qty' : `Subtotal (page ${idx + 1} of ${model.pages.length})`}</td>
                <td class="total-value">${isLast ? model.totalQty : model.pageTotals[idx]}</td>
              </tr>
            </tbody>
          </table>

          <div class="foot-bar">
            <span>Printed ${escapeHtml(model.printedAt)}</span>
            <span>${multi ? `${idx + 1}/${model.pages.length}` : '4 × 6 in'}</span>
          </div>
        </div>
      </div>
    `
  }).join('')
}

const LABEL_STYLES = `
          @page { size: 4in 6in; margin: 0; }
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #fff; }
          body {
            font-family: Arial, Helvetica, sans-serif; color: ${INK};
            -webkit-print-color-adjust: exact; print-color-adjust: exact;
          }
          .label-page {
            width: ${pt(LABEL_PAGE.width)}; height: ${pt(LABEL_PAGE.height)};
            padding: ${pt(PAD)}; overflow: hidden;
            page-break-inside: avoid; break-inside: avoid;
          }
          .label-frame {
            width: ${pt(FRAME.width)}; height: ${pt(FRAME.height)};
            border: 1px solid ${INK}; overflow: hidden;
          }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          td, th { overflow: hidden; }

          .brand-bar {
            height: ${pt(BRAND_H)}; display: flex; align-items: center;
            justify-content: space-between; padding: 0 ${pt(5)};
            background: ${INK}; color: #fff;
            font-size: 6pt; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
          }

          .hero { height: ${pt(HERO_H)}; display: flex; border-bottom: 1px solid ${INK}; }
          .hero-box {
            width: ${pt(HERO_SPLIT)}; border-right: 1px solid ${INK};
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            background: ${ZEBRA};
          }
          .hero-ship {
            flex: 1; display: flex; flex-direction: column; justify-content: center;
            padding: 0 ${pt(6)}; min-width: 0;
          }
          .hero-label {
            font-size: 5.5pt; font-weight: 700; letter-spacing: 0.8px;
            text-transform: uppercase; color: ${MUTED};
          }
          .hero-box-value { font-size: 22pt; font-weight: 800; line-height: 1.05; }
          .hero-ship-value {
            font-size: 13pt; font-weight: 800; line-height: 1.1;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }

          .meta-table td {
            height: ${pt(META_ROW_H)}; border-bottom: 1px solid ${RULE};
            padding: 0 ${pt(5)}; white-space: nowrap; text-overflow: ellipsis;
          }
          .meta-label {
            width: ${pt(META_LABEL_W)}; background: ${ZEBRA};
            border-right: 1px solid ${RULE};
            font-size: 5.5pt; font-weight: 700; letter-spacing: 0.5px;
            text-transform: uppercase; color: ${MUTED};
          }
          .meta-value { font-size: 8.5pt; font-weight: 700; }

          .stat-table td {
            height: ${pt(STAT_H)}; border-bottom: 1px solid ${INK};
            border-right: 1px solid ${RULE}; padding: 0 ${pt(5)};
          }
          .stat-table td:last-child { border-right: none; }
          .stat-label {
            display: block; font-size: 5.5pt; font-weight: 700; letter-spacing: 0.5px;
            text-transform: uppercase; color: ${MUTED}; line-height: 1.1;
          }
          .stat-value {
            display: block; font-size: 9pt; font-weight: 800; line-height: 1.1;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }

          .section-title {
            height: ${pt(SECTION_H)}; display: flex; align-items: center;
            justify-content: space-between; padding: 0 ${pt(5)};
            background: ${INK}; color: #fff;
            font-size: 6pt; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
          }

          .sku-table th {
            height: ${pt(THEAD_H)}; background: ${BAND}; color: ${INK};
            border-bottom: 1px solid ${INK}; border-right: 1px solid ${RULE};
            padding: 0 ${pt(4)}; text-align: left;
            font-size: 5.5pt; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
          }
          .sku-table th:last-child { border-right: none; }
          .sku-table td {
            border-bottom: 1px solid ${RULE}; border-right: 1px solid ${RULE};
            padding: 0 ${pt(4)}; white-space: nowrap; text-overflow: ellipsis;
          }
          .sku-table td:last-child { border-right: none; }
          .sku-table tr.zebra td { background: ${ZEBRA}; }
          .sku-table tr.filler td { border-right: none; border-bottom: none; background: ${PAPER}; }

          .num-head, .num-cell { text-align: center; }
          .num-cell { font-size: 6pt; font-weight: 700; color: ${MUTED}; }
          .qty-head, .qty-cell { text-align: right; }
          .qty-cell { font-size: 8pt; font-weight: 800; font-variant-numeric: tabular-nums; }
          .sku-cell { font-size: 7pt; font-weight: 600; }
          .barcode-cell { font-family: Consolas, "Courier New", monospace; font-size: 6.5pt; }
          .internal-cell { font-weight: 700; }
          .empty { text-align: center; color: ${MUTED}; font-size: 8pt; font-weight: 600; }

          .total-table td {
            height: ${pt(TOTAL_H)}; background: ${BAND};
            border-top: 1px solid ${INK}; border-bottom: 1px solid ${INK};
            padding: 0 ${pt(5)};
            font-size: 8.5pt; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;
          }
          .total-value { width: ${pt(COLS[3])}; text-align: right; font-size: 11pt; }

          .foot-bar {
            height: ${pt(FOOT_H)}; display: flex; align-items: center;
            justify-content: space-between; padding: 0 ${pt(5)};
            font-size: 5.5pt; font-weight: 600; color: ${MUTED};
          }

          @media print {
            .no-print { display: none !important; }
            .label-page { page-break-after: always; }
            .label-page:last-child { page-break-after: auto; }
          }
`

export function openShipmentLabelPrintWindow(innerHtml, title = 'Shipment Label') {
  const safeTitle = escapeHtml(title)
  const w = openEscapedPrintWindow(`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <style>${LABEL_STYLES}</style>
      </head>
      <body>
        ${innerHtml}
        <div class="no-print" style="text-align:center;padding:14px;font-family:Arial,Helvetica,sans-serif">
          <button onclick="window.print()" style="padding:8px 20px;font-size:12px;cursor:pointer">Print 4 &times; 6 Label</button>
          <div style="margin-top:8px;font-size:11px;color:#475569;line-height:1.5">
            This page declares its own 4 &times; 6 in (101.6 &times; 152.4 mm) size.<br>
            Leave the printer on its default settings &mdash; margins <strong>None</strong>, scale <strong>100%</strong>.
          </div>
        </div>
      </body>
    </html>`, { width: 620, height: 820 })
  return Boolean(w)
}

/* ------------------------------------------------------------------- PDF */

function drawCellLabel(doc, text, x, y) {
  doc.text(String(text).toUpperCase(), x, y, { font: 'bold', size: 5.5, color: MUTED })
}

function drawLabelPages(doc, model) {
  model.pages.forEach((pageRows, idx) => {
    const isLast = idx === model.pages.length - 1
    const multi = model.pages.length > 1
    doc.addPage()

    let y = FRAME.y

    // Brand bar
    doc.rect(FRAME.x, y, FRAME.width, BRAND_H, { fill: INK })
    doc.text(BRAND, FRAME.x + 5, y + 10.2, { font: 'bold', size: 6, color: PAPER, maxWidth: 180 })
    doc.text('BOX LABEL', FRAME.x + FRAME.width - 5, y + 10.2, { font: 'bold', size: 6, color: PAPER, align: 'right' })
    y += BRAND_H

    // Hero: box position + internal shipment
    doc.rect(FRAME.x, y, HERO_SPLIT, HERO_H, { fill: ZEBRA })
    drawCellLabel(doc, 'Box No', FRAME.x + HERO_SPLIT / 2 - measureText('BOX NO', 'bold', 5.5) / 2, y + 11)
    const heroSize = model.boxHero.length > 5 ? 16 : 22
    doc.text(model.boxHero, FRAME.x + HERO_SPLIT / 2, y + 36, {
      font: 'bold', size: heroSize, color: INK, align: 'center', maxWidth: HERO_SPLIT - 8,
    })

    const shipX = FRAME.x + HERO_SPLIT + 6
    const shipW = FRAME.width - HERO_SPLIT - 12
    drawCellLabel(doc, 'Internal Shipment', shipX, y + 14)
    let shipSize = 13
    while (shipSize > 8 && measureText(model.shipmentId, 'bold', shipSize) > shipW) shipSize -= 0.5
    doc.text(model.shipmentId, shipX, y + 33, { font: 'bold', size: shipSize, color: INK, maxWidth: shipW })

    doc.line(FRAME.x + HERO_SPLIT, y, FRAME.x + HERO_SPLIT, y + HERO_H, { color: INK, lineWidth: 0.8 })
    y += HERO_H
    doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: INK, lineWidth: 0.8 })

    // Secondary identifiers
    for (const row of model.metaRows) {
      doc.rect(FRAME.x, y, META_LABEL_W, META_ROW_H, { fill: ZEBRA })
      drawCellLabel(doc, row.label, FRAME.x + 5, y + 9.3)
      doc.text(row.value, FRAME.x + META_LABEL_W + 5, y + 9.8, {
        font: 'bold', size: 8.5, color: INK, maxWidth: FRAME.width - META_LABEL_W - 10,
      })
      doc.line(FRAME.x + META_LABEL_W, y, FRAME.x + META_LABEL_W, y + META_ROW_H, { color: RULE, lineWidth: 0.5 })
      y += META_ROW_H
      doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: RULE, lineWidth: 0.5 })
    }

    // Stat strip
    const statW = FRAME.width / model.statCells.length
    model.statCells.forEach((cell, i) => {
      const cx = FRAME.x + statW * i
      drawCellLabel(doc, cell.label, cx + 5, y + 6.8)
      doc.text(cell.value, cx + 5, y + 15.2, { font: 'bold', size: 9, color: INK, maxWidth: statW - 10 })
      if (i > 0) doc.line(cx, y, cx, y + STAT_H, { color: RULE, lineWidth: 0.5 })
    })
    y += STAT_H
    doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: INK, lineWidth: 0.8 })

    // Section bar
    doc.rect(FRAME.x, y, FRAME.width, SECTION_H, { fill: INK })
    doc.text('SKU DETAILS', FRAME.x + 5, y + 9.6, { font: 'bold', size: 6, color: PAPER })
    const sectionRight = multi
      ? `PAGE ${idx + 1} OF ${model.pages.length}`
      : `${model.itemCount} LINE${model.itemCount === 1 ? '' : 'S'}`
    doc.text(sectionRight, FRAME.x + FRAME.width - 5, y + 9.6, { font: 'bold', size: 6, color: PAPER, align: 'right' })
    y += SECTION_H

    // Table head
    doc.rect(FRAME.x, y, FRAME.width, THEAD_H, { fill: BAND })
    const heads = ['#', 'Barcode SKU', 'Internal SKU', 'Qty']
    heads.forEach((head, i) => {
      const x = colX(i)
      if (i === 0) doc.text(head, x + COLS[0] / 2, y + 8.8, { font: 'bold', size: 5.5, color: INK, align: 'center' })
      else if (i === 3) doc.text(head.toUpperCase(), x + COLS[3] - 4, y + 8.8, { font: 'bold', size: 5.5, color: INK, align: 'right' })
      else doc.text(head.toUpperCase(), x + 4, y + 8.8, { font: 'bold', size: 5.5, color: INK, maxWidth: COLS[i] - 8 })
      if (i > 0) doc.line(x, y, x, y + THEAD_H, { color: RULE, lineWidth: 0.5 })
    })
    y += THEAD_H
    doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: INK, lineWidth: 0.8 })

    // Rows
    const bodyTop = y
    if (!pageRows.length) {
      doc.text('No items in this box', FRAME.x + FRAME.width / 2, y + model.bodyH / 2, {
        font: 'bold', size: 8, color: MUTED, align: 'center',
      })
    }
    const rowH = model.rowH
    pageRows.forEach((row, i) => {
      const rowY = bodyTop + i * rowH
      if (i % 2) doc.rect(FRAME.x, rowY, FRAME.width, rowH, { fill: ZEBRA })
      const baseline = rowY + rowH / 2 + 2.5
      doc.text(String(row.n), colX(0) + COLS[0] / 2, baseline, { font: 'bold', size: 6, color: MUTED, align: 'center' })
      doc.text(row.barcodeSku, colX(1) + 4, baseline, { font: 'mono', size: 6.5, color: INK, maxWidth: COLS[1] - 8 })
      doc.text(row.internalSku, colX(2) + 4, baseline, { font: 'bold', size: 7, color: INK, maxWidth: COLS[2] - 8 })
      doc.text(String(row.qty), colX(3) + COLS[3] - 4, baseline, { font: 'bold', size: 8, color: INK, align: 'right' })
      if (i < pageRows.length - 1) {
        doc.line(FRAME.x, rowY + rowH, FRAME.x + FRAME.width, rowY + rowH, { color: RULE, lineWidth: 0.4 })
      }
    })
    if (pageRows.length) {
      for (let i = 1; i < COLS.length; i += 1) {
        doc.line(colX(i), bodyTop, colX(i), bodyTop + model.bodyH, { color: RULE, lineWidth: 0.5 })
      }
    }
    y = bodyTop + model.bodyH

    // Total strip
    doc.rect(FRAME.x, y, FRAME.width, TOTAL_H, { fill: BAND })
    doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: INK, lineWidth: 0.8 })
    doc.text(
      isLast ? 'TOTAL PACKED QTY' : `SUBTOTAL (PAGE ${idx + 1} OF ${model.pages.length})`,
      FRAME.x + 5, y + 10.4,
      { font: 'bold', size: 8.5, color: INK, maxWidth: FRAME.width - COLS[3] - 10 }
    )
    doc.text(String(isLast ? model.totalQty : model.pageTotals[idx]), FRAME.x + FRAME.width - 5, y + 10.8, {
      font: 'bold', size: 11, color: INK, align: 'right',
    })
    y += TOTAL_H
    doc.line(FRAME.x, y, FRAME.x + FRAME.width, y, { color: INK, lineWidth: 0.8 })

    // Footer
    doc.text(`Printed ${model.printedAt}`, FRAME.x + 5, y + 8, { font: 'regular', size: 5.5, color: MUTED, maxWidth: FRAME.width - 60 })
    doc.text(multi ? `${idx + 1}/${model.pages.length}` : '4 × 6 in', FRAME.x + FRAME.width - 5, y + 8, {
      font: 'regular', size: 5.5, color: MUTED, align: 'right',
    })

    // Outer frame last, so it sits on top of every fill.
    doc.rect(FRAME.x, FRAME.y, FRAME.width, FRAME.height, { stroke: INK, lineWidth: 1 })
  })
}

/** Build a 4x6 PDF covering every supplied label model. */
export function buildShipmentLabelPdf(models) {
  const doc = createPdfDocument(LABEL_PAGE)
  const list = Array.isArray(models) ? models : [models]
  for (const model of list) drawLabelPages(doc, model)
  return doc
}

function safeFileName(value, fallback) {
  const cleaned = String(value ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* --------------------------------------------------------------- Callers */

function sortedBoxes(consignment) {
  return [...(consignment?.boxes || [])].sort((a, b) =>
    String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true })
  )
}

function modelFor(consignment, box, boxIndex, boxCount) {
  return buildLabelModel({
    consignmentId: consignment?.id,
    internalShipmentNo: consignment?.internalShipmentNo,
    shipmentNo: consignment?.shipmentNo,
    box,
    boxIndex,
    boxCount,
  })
}

function labelHtmlFor(consignment, box, boxIndex, boxCount) {
  return buildShipmentBoxLabelHtml({
    consignmentId: consignment?.id,
    internalShipmentNo: consignment?.internalShipmentNo,
    shipmentNo: consignment?.shipmentNo,
    box,
    boxIndex,
    boxCount,
  })
}

/** 1-based position of `box` within the shipment; 0 when it cannot be placed. */
function positionOf(boxes, box) {
  return boxes.findIndex((b) => String(b.boxNo) === String(box?.boxNo)) + 1
}

export function printShipmentBoxLabel(consignment, box) {
  const boxes = sortedBoxes(consignment)
  const html = labelHtmlFor(consignment, box, positionOf(boxes, box), boxes.length)
  return openShipmentLabelPrintWindow(html, `Box #${box?.boxNo} Label`)
}

export function printAllShipmentBoxLabels(consignment) {
  const boxes = sortedBoxes(consignment)
  const html = boxes.map((box, i) => labelHtmlFor(consignment, box, i + 1, boxes.length)).join('')
  return openShipmentLabelPrintWindow(html, `Labels - ${consignment?.internalShipmentNo || consignment?.id}`)
}

export function downloadShipmentBoxLabelPdf(consignment, box) {
  const boxes = sortedBoxes(consignment)
  const doc = buildShipmentLabelPdf([modelFor(consignment, box, positionOf(boxes, box), boxes.length)])
  const shipment = safeFileName(consignment?.internalShipmentNo || consignment?.id, 'shipment')
  triggerDownload(doc.toBlob(), `${shipment}_Box-${safeFileName(box?.boxNo, 'label')}_4x6.pdf`)
  return doc.pageCount
}

export function downloadAllShipmentBoxLabelsPdf(consignment) {
  const boxes = sortedBoxes(consignment)
  if (!boxes.length) return 0
  const models = boxes.map((box, i) => modelFor(consignment, box, i + 1, boxes.length))
  const doc = buildShipmentLabelPdf(models)
  const shipment = safeFileName(consignment?.internalShipmentNo || consignment?.id, 'shipment')
  triggerDownload(doc.toBlob(), `${shipment}_box-labels_4x6.pdf`)
  return doc.pageCount
}

// Legacy helper kept for compatibility
export function buildBarcodeDataUrl(value) {
  if (!value) return ''
  const canvas = document.createElement('canvas')
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      width: 2,
      height: 44,
      displayValue: true,
      fontSize: 10,
      margin: 2,
    })
    return canvas.toDataURL ? canvas.toDataURL('image/png') : ''
  } catch {
    return ''
  }
}
