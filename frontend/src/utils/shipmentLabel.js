import JsBarcode from 'jsbarcode'
import { escapeHtml, openEscapedPrintWindow } from './printHtml'

const ROWS_PER_PAGE = 32

/**
 * Build 4×6 shipment box label HTML — Excel-style bordered grid.
 * Columns: # | Barcode SKU | Internal SKU | Qty
 */
export function buildShipmentBoxLabelHtml({ consignmentId, internalShipmentNo, shipmentNo, box }) {
  const items = box?.items || []
  const totalQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
  const shipmentId = String(internalShipmentNo || consignmentId || '').trim()
  const shipNo = String(shipmentNo || '').trim()
  const boxNo = String(box?.boxNo || '')
  const cid = String(consignmentId || '').trim()
  const weight = box?.weight != null && box.weight !== '' ? `${box.weight} ${box.weightUnit || 'KG'}` : ''

  // Avoid repeating the same value three times when IDs match.
  const metaRows = []
  if (shipmentId) metaRows.push(['Internal Shipment', shipmentId, true])
  if (cid && cid.toLowerCase() !== shipmentId.toLowerCase()) {
    metaRows.push(['Consignment ID', cid, false])
  }
  if (shipNo && shipNo.toLowerCase() !== shipmentId.toLowerCase() && shipNo.toLowerCase() !== cid.toLowerCase()) {
    metaRows.push(['Shipment No', shipNo, false])
  }
  if (!metaRows.length && cid) metaRows.push(['Consignment ID', cid, true])

  const pages = []
  for (let i = 0; i < items.length; i += ROWS_PER_PAGE) {
    pages.push(items.slice(i, i + ROWS_PER_PAGE))
  }
  if (!pages.length) pages.push([])

  return pages.map((pageItems, idx) => {
    const isLast = idx === pages.length - 1
    const rowOffset = idx * ROWS_PER_PAGE
    const rows = pageItems.map((item, i) => {
      const barcodeSku = item.barcode || item.marketplaceBarcode || item.marketplaceSku || '—'
      const internalSku = item.internalSku || item.name || '—'
      return `
      <tr>
        <td class="num-cell">${rowOffset + i + 1}</td>
        <td class="sku-cell barcode-cell">${escapeHtml(barcodeSku)}</td>
        <td class="sku-cell internal-cell">${escapeHtml(internalSku)}</td>
        <td class="qty-cell">${Number(item.qty) || 0}</td>
      </tr>`
    }).join('')

    const totalRow = isLast
      ? `<tr class="total-row">
          <td class="num-cell"></td>
          <td colspan="2" class="total-label">Packed Qty</td>
          <td class="qty-cell">${totalQty}</td>
        </tr>`
      : ''

    const pageNote = pages.length > 1
      ? `<span class="page-note">Page ${idx + 1}/${pages.length}</span>`
      : ''

    const metaHtml = metaRows.map(([label, value, strong]) => `
      <tr>
        <td class="meta-label">${escapeHtml(label)}</td>
        <td class="meta-value${strong ? ' strong' : ''}" colspan="3">${escapeHtml(value)}</td>
      </tr>`).join('')

    return `
      <div class="label-page" style="${idx > 0 ? 'page-break-before:always;' : ''}">
        <div class="label-frame">
          <table class="meta-table">
            <tbody>
              ${metaHtml}
              <tr class="box-row">
                <td class="meta-label">Box</td>
                <td class="meta-value strong">#${escapeHtml(boxNo)}</td>
                <td class="meta-label center">Items</td>
                <td class="meta-value strong center">${items.length}${weight ? ` · ${escapeHtml(weight)}` : ''}</td>
              </tr>
            </tbody>
          </table>

          <div class="section-title">
            <span>SKU DETAILS</span>
            <span>Packed: <strong>${totalQty}</strong>${pageNote ? ` · ${pageNote}` : ''}</span>
          </div>

          <table class="sku-table">
            <colgroup>
              <col class="col-num" />
              <col class="col-barcode" />
              <col class="col-internal" />
              <col class="col-qty" />
            </colgroup>
            <thead>
              <tr>
                <th class="num-head">#</th>
                <th>Barcode SKU</th>
                <th>Internal SKU</th>
                <th class="qty-head">Qty</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="4" class="empty">No items in this box</td></tr>'}
              ${totalRow}
            </tbody>
          </table>
        </div>
      </div>
    `
  }).join('')
}

export function openShipmentLabelPrintWindow(innerHtml, title = 'Shipment Label') {
  const safeTitle = escapeHtml(title)
  const w = openEscapedPrintWindow(`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <style>
          @page { size: 4in 6in; margin: 0; }
          * { box-sizing: border-box; }
          body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .label-page {
            width: 4in; height: 6in; padding: 0.08in;
            box-sizing: border-box; page-break-inside: avoid;
          }
          .label-frame {
            width: 100%; height: 100%;
            border: 2px solid #0f172a;
            display: flex; flex-direction: column;
            overflow: hidden;
          }

          /* Header meta — Excel-like bordered cells */
          .meta-table {
            width: 100%; border-collapse: collapse; table-layout: fixed;
            border-bottom: 2px solid #0f172a;
          }
          .meta-table td {
            border: 1px solid #0f172a;
            padding: 3px 5px;
            vertical-align: middle;
            line-height: 1.2;
          }
          .meta-label {
            width: 28%;
            font-size: 6.5pt;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.2px;
            color: #334155;
            background: #f1f5f9;
          }
          .meta-value {
            font-size: 8pt;
            font-weight: 700;
            word-break: break-all;
          }
          .meta-value.strong { font-size: 10pt; font-weight: 800; }
          .meta-value.center, .meta-label.center { text-align: center; }
          .box-row .meta-value { font-size: 10pt; }

          .section-title {
            display: flex; justify-content: space-between; align-items: center;
            padding: 3px 5px;
            font-size: 7pt; font-weight: 800;
            text-transform: uppercase; letter-spacing: 0.3px;
            background: #0f172a; color: #fff;
            border-bottom: 1px solid #0f172a;
          }
          .section-title strong { font-size: 8pt; }
          .page-note { font-weight: 600; opacity: 0.9; }

          /* SKU grid — full Excel-style borders on every cell */
          .sku-table {
            width: 100%; border-collapse: collapse; table-layout: fixed;
            flex: 1;
          }
          .col-num { width: 8%; }
          .col-barcode { width: 42%; }
          .col-internal { width: 38%; }
          .col-qty { width: 12%; }

          .sku-table th, .sku-table td {
            border: 1px solid #0f172a;
            padding: 3px 4px;
            vertical-align: middle;
          }
          .sku-table th {
            text-align: left;
            font-size: 6.5pt;
            text-transform: uppercase;
            letter-spacing: 0.2px;
            color: #0f172a;
            background: #e2e8f0;
            font-weight: 800;
          }
          .num-head, .num-cell { text-align: center; width: 8%; font-variant-numeric: tabular-nums; }
          .qty-head, .qty-cell {
            text-align: right;
            font-variant-numeric: tabular-nums;
          }
          .num-cell {
            font-size: 6.5pt; font-weight: 700; color: #64748b; background: #f8fafc;
          }
          .sku-cell {
            font-size: 7pt; font-weight: 700;
            word-break: break-word; overflow-wrap: anywhere; line-height: 1.2;
          }
          .barcode-cell { color: #1e293b; font-family: Consolas, "Courier New", monospace; font-size: 6.5pt; }
          .internal-cell { color: #0f172a; }
          .qty-cell { font-size: 8pt; font-weight: 800; }

          .total-row td {
            background: #f1f5f9;
            border-top: 2px solid #0f172a;
            font-size: 8pt; font-weight: 800;
            padding: 4px;
          }
          .total-label { text-align: right; text-transform: uppercase; letter-spacing: 0.3px; }
          .empty {
            text-align: center; color: #94a3b8; padding: 10px 0; font-size: 8pt; font-weight: 600;
          }

          @media print { .no-print { display: none !important; } }
        </style>
      </head>
      <body>
        ${innerHtml}
        <div class="no-print" style="text-align:center;padding:12px">
          <button onclick="window.print()" style="padding:8px 20px;font-size:12px;cursor:pointer">Print 4×6 Label</button>
        </div>
      </body>
    </html>`, { width: 600, height: 800 })
  return Boolean(w)
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
