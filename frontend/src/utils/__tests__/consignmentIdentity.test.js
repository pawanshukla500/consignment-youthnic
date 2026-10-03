import { describe, expect, it } from 'vitest'
import { displayConsignmentNo, displayInternalShipmentNo } from '../consignmentIdentity'

describe('consignment identity display', () => {
  it('prefers consignmentNo over document id so shared marketplace numbers can display', () => {
    expect(displayConsignmentNo({
      id: 'SEP-PH1-S26',
      consignmentNo: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S26',
    })).toBe('MYNJ-VBXOEO310826-11')
  })

  it('falls back to document id for older rows without consignmentNo', () => {
    expect(displayConsignmentNo({ id: 'MYNJ-VBXOEO310826-11', internalShipmentNo: 'SEP-PH1-S26' }))
      .toBe('MYNJ-VBXOEO310826-11')
  })

  it('keeps internal shipment as the unique packing key', () => {
    expect(displayInternalShipmentNo({
      id: 'SEP-PH1-S26',
      consignmentNo: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S26',
    })).toBe('SEP-PH1-S26')
    expect(displayInternalShipmentNo({ id: 'x' })).toBe('')
  })
})
