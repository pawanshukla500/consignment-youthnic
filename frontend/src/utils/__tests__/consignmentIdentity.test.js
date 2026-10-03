import { describe, it, expect } from 'vitest'
import { displayConsignmentNo } from '../consignmentIdentity'

describe('displayConsignmentNo', () => {
  it('shows the stored consignment number even when another shipment could use it', () => {
    expect(displayConsignmentNo({
      id: 'SEP-S26',
      internalShipmentNo: 'SEP-S26',
      consignmentNo: 'MYNJ-VBXOEO310826-11',
    })).toBe('MYNJ-VBXOEO310826-11')
  })

  it('keeps a legacy record readable when the document id was the consignment number', () => {
    expect(displayConsignmentNo({
      id: 'MYNJ-VBXOEO310826-11',
      internalShipmentNo: 'SEP-PH1-S26',
    })).toBe('MYNJ-VBXOEO310826-11')
  })

  it('leaves the number blank until one is assigned', () => {
    expect(displayConsignmentNo({
      id: 'SEP-S26',
      internalShipmentNo: 'SEP-S26',
      pendingExternalId: true,
    })).toBe('')
  })
})
