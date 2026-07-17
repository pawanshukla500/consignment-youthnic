import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../printHtml'
import { buildShipmentBoxLabelHtml } from '../shipmentLabel'

describe('printHtml XSS escaping', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "<img src=x onerror=alert(1)>",
  ]

  it('escapeHtml neutralizes script and event-handler payloads', () => {
    for (const payload of payloads) {
      const escaped = escapeHtml(payload)
      // Raw HTML tags must not remain; attribute-looking text may appear only after escaping.
      expect(escaped).not.toContain('<script')
      expect(escaped).not.toContain('<img')
      expect(escaped).toContain('&lt;')
      expect(escaped.includes(payload)).toBe(false)
    }
  })

  it('shipment label HTML contains only escaped business values', () => {
    const html = buildShipmentBoxLabelHtml({
      consignmentId: '"><script>alert(1)</script>',
      internalShipmentNo: '<img src=x onerror=alert(1)>',
      shipmentNo: 'SH-1',
      box: {
        boxNo: '"><img src=x onerror=alert(1)>',
        items: [
          {
            barcode: '<script>alert(1)</script>',
            marketplaceSku: '"><script>alert(1)</script>',
            internalSku: '<img src=x onerror=alert(1)>',
            qty: 2,
          },
        ],
      },
    })
    expect(html).not.toMatch(/<script>/i)
    expect(html).not.toMatch(/<img\s/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&quot;&gt;')
  })
})
