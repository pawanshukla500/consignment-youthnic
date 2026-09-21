import { describe, expect, it } from 'vitest'
import {
  LABEL_PAGE,
  buildLabelModel,
  buildShipmentBoxLabelHtml,
  buildShipmentLabelPdf,
} from '../shipmentLabel'
import { createPdfDocument, fitText, measureText, toWinAnsi } from '../pdfDocument'

const makeItems = (count) =>
  Array.from({ length: count }, (_, i) => ({
    barcode: `890123456${String(i).padStart(4, '0')}`,
    internalSku: `KLN-${1000 + i}-M`,
    qty: i + 1,
  }))

const baseBox = (count, extra = {}) => ({ boxNo: '3', weight: 8.4, weightUnit: 'KG', items: makeItems(count), ...extra })

const labelArgs = (box, extra = {}) => ({
  consignmentId: 'CN-9931',
  internalShipmentNo: 'VBX-SHIP-0012',
  shipmentNo: 'SH-1',
  box,
  boxIndex: 3,
  boxCount: 12,
  printedAt: new Date('2026-09-21T10:04:00Z'),
  ...extra,
})

describe('buildLabelModel', () => {
  it('summarizes the box and keeps a single page when rows fit', () => {
    const model = buildLabelModel(labelArgs(baseBox(5)))
    expect(model.shipmentId).toBe('VBX-SHIP-0012')
    expect(model.boxHero).toBe('#3')
    expect(model.itemCount).toBe(5)
    expect(model.totalQty).toBe(15)
    expect(model.pages).toHaveLength(1)
    expect(model.statCells.map((c) => c.value)).toEqual(['3 of 12', '5', '15', '8.40 KG'])
  })

  it('derives the box sequence from list position, not from the box number', () => {
    // Boxes can be renumbered, so boxNo is a name — never an index into the shipment.
    const model = buildLabelModel(labelArgs(baseBox(1, { boxNo: '47' }), { boxIndex: 2, boxCount: 3 }))
    expect(model.boxHero).toBe('#47')
    expect(model.sequence).toBe('2 of 3')
    const unplaced = buildLabelModel(labelArgs(baseBox(1), { boxIndex: 0, boxCount: 3 }))
    expect(unplaced.sequence).toBe('3 total')
    const alone = buildLabelModel({ internalShipmentNo: 'S1', box: baseBox(1) })
    expect(alone.sequence).toBe('')
    expect(alone.statCells.map((c) => c.label)).toEqual(['SKU Lines', 'Packed Qty', 'Weight'])
  })

  it('never lets a page of rows overflow the 4x6 label', () => {
    const model = buildLabelModel(labelArgs(baseBox(200)))
    const ROW_H = model.bodyH / model.rowsPerPage
    expect(model.rowsPerPage).toBeGreaterThan(0)
    expect(model.rowsPerPage * ROW_H).toBeLessThanOrEqual(model.bodyH + 1e-9)
    expect(model.bodyH).toBeLessThan(LABEL_PAGE.height)
    for (const page of model.pages) expect(page.length).toBeLessThanOrEqual(model.rowsPerPage)
    expect(model.pages.flat()).toHaveLength(200)
    expect(model.pages.flat().map((r) => r.n)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1)
    )
  })

  it('drops identifier rows that merely repeat the shipment id', () => {
    const model = buildLabelModel({
      consignmentId: 'SAME-1',
      internalShipmentNo: 'same-1',
      shipmentNo: 'SAME-1',
      box: baseBox(2),
    })
    expect(model.metaRows).toHaveLength(1)
    expect(model.metaRows[0].value).toBe('SAME-1')
  })

  it('handles an empty box and a missing weight', () => {
    const model = buildLabelModel(labelArgs({ boxNo: '1', items: [] }))
    expect(model.pages).toEqual([[]])
    expect(model.totalQty).toBe(0)
    expect(model.statCells.at(-1).value).toBe('—')
  })
})

describe('buildShipmentBoxLabelHtml', () => {
  it('emits one fixed-size label page per model page', () => {
    const html = buildShipmentBoxLabelHtml(labelArgs(baseBox(60)))
    const model = buildLabelModel(labelArgs(baseBox(60)))
    expect(html.match(/class="label-page"/g)).toHaveLength(model.pages.length)
    expect(html).toContain('Total Packed Qty')
    expect(html).toContain(`Subtotal (page 1 of ${model.pages.length})`)
    expect(html).toContain(`Page 1 of ${model.pages.length}`)
    // Per-page subtotals must add up to the box total.
    expect(model.pageTotals.reduce((a, b) => a + b, 0)).toBe(model.totalQty)
  })

  it('escapes every business value it renders', () => {
    const html = buildShipmentBoxLabelHtml({
      consignmentId: '"><script>alert(1)</script>',
      internalShipmentNo: '<img src=x onerror=alert(1)>',
      box: { boxNo: '"><b>', items: [{ barcode: '<script>x</script>', internalSku: '<i>y</i>', qty: 1 }] },
    })
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img\s/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;&gt;')
  })
})

describe('pdf label output', () => {
  const parsePdf = (raw) => {
    expect(raw.startsWith('%PDF-1.4')).toBe(true)
    expect(raw.endsWith('%%EOF\n')).toBe(true)
    const startxref = Number(raw.slice(raw.lastIndexOf('startxref') + 9, raw.lastIndexOf('%%EOF')).trim())
    expect(raw.slice(startxref, startxref + 4)).toBe('xref')
    const offsets = [...raw.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    offsets.forEach((offset, i) => {
      // Every xref entry must land exactly on its object header.
      expect(raw.slice(offset, offset + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`)
    })
    return { objectCount: offsets.length }
  }

  it('writes a valid single-box PDF at exactly 4x6 inches', () => {
    const model = buildLabelModel(labelArgs(baseBox(5)))
    const doc = buildShipmentLabelPdf([model])
    expect(doc.pageCount).toBe(1)
    const raw = doc.toRawString()
    parsePdf(raw)
    expect(raw).toContain('/MediaBox [0 0 288 432]')
    expect(raw.match(/\/Type \/Page[^s]/g)).toHaveLength(1)
    expect(raw).toContain('/Count 1')
  })

  it('cross-references stay correct across many pages and boxes', () => {
    const models = [
      buildLabelModel(labelArgs(baseBox(60), { boxCount: 3 })),
      buildLabelModel(labelArgs(baseBox(1, { boxNo: '2' }), { boxCount: 3 })),
      buildLabelModel(labelArgs({ boxNo: '3', items: [] }, { boxCount: 3 })),
    ]
    const doc = buildShipmentLabelPdf(models)
    const expectedPages = models.reduce((sum, m) => sum + m.pages.length, 0)
    expect(doc.pageCount).toBe(expectedPages)
    const raw = doc.toRawString()
    const { objectCount } = parsePdf(raw)
    // catalog + pages tree + 4 fonts + 2 objects per page
    expect(objectCount).toBe(2 + 4 + expectedPages * 2)
    expect(raw).toContain(`/Count ${expectedPages}`)
  })

  it('declares an accurate /Length for every content stream', () => {
    const doc = buildShipmentLabelPdf([buildLabelModel(labelArgs(baseBox(30)))])
    const raw = doc.toRawString()
    const streams = [...raw.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)]
    expect(streams.length).toBeGreaterThan(0)
    for (const [, declared, body] of streams) expect(body.length).toBe(Number(declared))
  })

  it('renders every label glyph without falling back to "?"', () => {
    const doc = buildShipmentLabelPdf([
      buildLabelModel(labelArgs(baseBox(60))),
      buildLabelModel(labelArgs({ boxNo: '9', items: [] })),
    ])
    for (const [, body] of doc.toRawString().matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)) {
      expect(body).not.toContain('?')
    }
  })

  it('is byte-safe — every character fits in one byte', () => {
    const doc = buildShipmentLabelPdf([buildLabelModel(labelArgs(baseBox(3)))])
    const raw = doc.toRawString()
    expect(doc.toUint8Array()).toHaveLength(raw.length)
    for (let i = 0; i < raw.length; i += 1) expect(raw.charCodeAt(i)).toBeLessThanOrEqual(0xff)
  })

  it('neutralizes PDF string delimiters coming from SKU data', () => {
    const doc = buildShipmentLabelPdf([
      buildLabelModel({
        consignmentId: 'CN-1',
        internalShipmentNo: 'SHIP-1',
        box: { boxNo: '1', items: [{ barcode: 'A(B)C\\D', internalSku: ')evil(', qty: 1 }] },
      }),
    ])
    const raw = doc.toRawString()
    expect(raw).toContain('A\\(B\\)C\\\\D')
    expect(raw).toContain('\\)evil\\(')
    // Balanced literal-string parens: no stray delimiter escaped out of the stream.
    for (const [, body] of raw.matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)) {
      expect(body).not.toMatch(/(^|[^\\])[()]/)
    }
  })
})

describe('pdfDocument text helpers', () => {
  it('measures base-14 advance widths', () => {
    // Helvetica digits are 556/1000 em.
    expect(measureText('12345', 'regular', 10)).toBeCloseTo(27.8, 5)
    // Courier is monospaced at 600/1000 em.
    expect(measureText('ABCD', 'mono', 10)).toBeCloseTo(24, 5)
  })

  it('truncates with an ellipsis only when the text overflows', () => {
    expect(fitText('SHORT', 'regular', 8, 200)).toBe('SHORT')
    const clipped = fitText('AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'regular', 8, 30)
    expect(clipped.endsWith('…')).toBe(true)
    expect(measureText(clipped, 'regular', 8)).toBeLessThanOrEqual(30)
  })

  it('folds unsupported code points down to WinAnsi bytes', () => {
    expect(toWinAnsi('café')).toBe('café')
    expect(toWinAnsi('a—b')).toBe('a\u0097b')
    expect(toWinAnsi('中')).toBe('?')
    for (const char of toWinAnsi('…’😀')) {
      expect(char.codePointAt(0)).toBeLessThanOrEqual(0xff)
    }
  })

  it('keeps an empty document printable', () => {
    const doc = createPdfDocument({ width: 288, height: 432 })
    expect(doc.toRawString()).toContain('/Count 1')
  })
})
