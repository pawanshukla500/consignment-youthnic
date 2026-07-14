import JsBarcode from 'jsbarcode'

const ROWS_PER_PAGE = 28

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build 4×6 shipment box label HTML (text only — no graphical barcode).
 * Shows consignment ID, shipment number, box number, barcode SKU, internal SKU, qty.
 */
export function buildShipmentBoxLabelHtml({ consignmentId, internalShipmentNo, shipmentNo, box }) {
  const items = box?.items || []
  const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
  const shipmentId = internalShipmentNo || consignmentId || ''
  const shipNo = shipmentNo || ''
  const boxNo = String(box?.boxNo || '')
  const cid = consignmentId || ''

  const pages = []
  for (let i = 0; i < items.length; i += ROWS_PER_PAGE) {
    pages.push(items.slice(i, i + ROWS_PER_PAGE))
  }
  if (!pages.length) pages.push([])

  return pages.map((pageItems, idx) => {
    const isLast = idx === pages.length - 1
    const rows = pageItems.map((item) => {
      const barcodeSku = item.barcode || item.marketplaceBarcode || item.marketplaceSku || '—'
      const internalSku = item.internalSku || item.name || '—'
      return `
      <tr>
        <td class="sku-cell barcode-cell">${escapeHtml(barcodeSku)}</td>
        <td class="sku-cell internal-cell">${escapeHtml(internalSku)}</td>
        <td class="qty-cell">${Number(item.qty) || 0}</td>
      </tr>`
    }).join('')

    const totalRow = isLast
      ? `<tr class="total-row"><td colspan="2">Packed Qty</td><td class="qty-cell">${totalQty}</td></tr>`
      : ''

    const pageNote = pages.length > 1
      ? `<div class="page-note">Page ${idx + 1} of ${pages.length}</div>`
      : ''

    return `
      <div class="label-page" style="${idx > 0 ? 'page-break-before:always;' : ''}">
        <div class="header">
          <div class="meta-line"><span class="meta-label">Consignment ID</span><span class="meta-value">${escapeHtml(cid)}</span></div>
          <div class="meta-line"><span class="meta-label">Shipment No</span><span class="meta-value">${escapeHtml(shipNo || shipmentId)}</span></div>
          <div class="meta-line"><span class="meta-label">Internal Shipment</span><span class="meta-value strong">${escapeHtml(shipmentId)}</span></div>
          <div class="box-line">Box #${escapeHtml(boxNo)} · Packed: <strong>${totalQty}</strong></div>
          ${pageNote}
        </div>
        <table class="sku-table">
          <thead>
            <tr>
              <th>Barcode SKU</th>
              <th>Internal SKU</th>
              <th class="qty-head">Qty</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="3" class="empty">No items</td></tr>'}
            ${totalRow}
          </tbody>
        </table>
      </div>
    `
  }).join('')
}

export function openShipmentLabelPrintWindow(innerHtml, title = 'Shipment Label') {
  const w = window.open('', '_blank', 'width=600,height=800')
  if (!w) return false
  w.document.write(`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
          @page { size: 4in 6in; margin: 0; }
          body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
          .label-page {
            width: 4in; height: 6in; padding: 0.12in 0.14in;
            box-sizing: border-box; display: flex; flex-direction: column;
            page-break-inside: avoid;
          }
          .header { margin-bottom: 6px; border-bottom: 1.5px solid #0f172a; padding-bottom: 6px; }
          .meta-line { display: flex; justify-content: space-between; gap: 6px; font-size: 7.5pt; line-height: 1.35; margin-bottom: 1px; }
          .meta-label { color: #64748b; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
          .meta-value { font-weight: 600; text-align: right; word-break: break-all; }
          .meta-value.strong { font-size: 11pt; font-weight: 800; }
          .box-line { margin-top: 4px; font-size: 9pt; font-weight: 700; }
          .page-note { font-size: 7pt; color: #64748b; margin-top: 2px; }
          .sku-table { width: 100%; border-collapse: collapse; flex: 1; table-layout: fixed; }
          .sku-table th {
            text-align: left; font-size: 6.5pt; text-transform: uppercase; color: #475569;
            border-bottom: 1px solid #000; padding: 3px 2px 4px; font-weight: 700;
          }
          .qty-head, .qty-cell { text-align: right; width: 36px; }
          .sku-cell {
            font-size: 7pt; font-weight: 600; padding: 4px 2px;
            border-bottom: 1px solid #e2e8f0; vertical-align: top;
            word-break: break-word; overflow-wrap: anywhere; line-height: 1.25;
          }
          .barcode-cell { color: #334155; width: 46%; }
          .internal-cell { color: #0f172a; width: 42%; }
          .qty-cell { font-size: 8pt; font-weight: 800; padding: 4px 2px; border-bottom: 1px solid #e2e8f0; }
          .total-row td { border-top: 1.5px solid #000; padding-top: 5px; font-size: 8pt; font-weight: 800; }
          .empty { text-align: center; color: #94a3b8; padding: 12px 0; font-size: 8pt; }
          @media print { .no-print { display: none !important; } }
        </style>
      </head>
      <body>
        ${innerHtml}
        <div class="no-print" style="text-align:center;padding:12px">
          <button onclick="window.print()" style="padding:8px 20px;font-size:12px;cursor:pointer">Print 4×6 Label</button>
        </div>
      </body>
    </html>`)
  w.document.close()
  return true
}

export function printShipmentBoxLabel(consignment, box) {
  const html = buildShipmentBoxLabelHtml({
    consignmentId: consignment?.id,
    internalShipmentNo: consignment?.internalShipmentNo,
    shipmentNo: consignment?.shipmentNo,
    box,
  })
  return openShipmentLabelPrintWindow(html, `Box #${box?.boxNo} Label`)
}

export function printAllShipmentBoxLabels(consignment) {
  const boxes = [...(consignment?.boxes || [])].sort((a, b) =>
    String(a.boxNo).localeCompare(String(b.boxNo), undefined, { numeric: true })
  )
  const html = boxes.map((box) => buildShipmentBoxLabelHtml({
    consignmentId: consignment?.id,
    internalShipmentNo: consignment?.internalShipmentNo,
    shipmentNo: consignment?.shipmentNo,
    box,
  })).join('')
  return openShipmentLabelPrintWindow(html, `Labels - ${consignment?.internalShipmentNo || consignment?.id}`)
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
