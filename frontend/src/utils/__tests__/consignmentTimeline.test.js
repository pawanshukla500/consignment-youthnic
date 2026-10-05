import { describe, expect, it } from 'vitest'
import {
  boxPackedUnits,
  buildConsignmentTimeline,
  sortedBoxQtyEntries,
  timelineBoxUnits,
} from '../consignmentTimeline'

describe('sortedBoxQtyEntries', () => {
  it('orders box numbers numerically and drops empty quantities', () => {
    expect(sortedBoxQtyEntries([['10', 29], ['2', 30], ['18', 29], ['1', 30], ['9', 0]])).toEqual([
      ['1', 30],
      ['2', 30],
      ['10', 29],
      ['18', 29],
    ])
  })
})

describe('boxPackedUnits', () => {
  it('uses the saved box total when items only store qty', () => {
    expect(boxPackedUnits({
      totalQty: 124,
      items: [{ skuId: 'a', qty: 124 }],
    })).toBe(124)
  })

  it('sums qty instead of counting each line as one unit', () => {
    expect(boxPackedUnits({
      items: [{ qty: 30 }, { qty: 29 }],
    })).toBe(59)
  })

  it('still reads a legacy quantity field', () => {
    expect(boxPackedUnits({
      items: [{ quantity: 14 }],
    })).toBe(14)
  })
})

describe('timelineBoxUnits', () => {
  it('keeps the last sealed count when a live session overlays a saved box', () => {
    expect(timelineBoxUnits({
      liveOverlay: true,
      sealedTotalQty: 18,
      totalQty: 40,
      items: [{ qty: 40 }],
    })).toBe(18)
  })
})

describe('buildConsignmentTimeline', () => {
  it('reports sealed units from qty and keeps newer events above older ones', () => {
    const events = buildConsignmentTimeline({
      createdAt: '2026-09-23T10:00:00.000Z',
      boxes: [{
        boxNo: 39,
        createdAt: '2026-09-23T18:07:00.000Z',
        weight: 14,
        totalQty: 124,
        items: [{ skuId: 'amba', qty: 124 }],
        adjustments: [{
          id: 'adj-1',
          status: 'completed',
          completedAt: '2026-09-23T18:20:00.000Z',
          actionType: 'edit',
          internalSku: 'D26-Amba-Red',
          previousQuantity: 120,
          updatedQuantity: 124,
          reasonLabel: 'Recount',
          removedByName: 'Chandan Yadav',
        }],
      }],
      videos: [
        {
          id: 'vid-39',
          boxNo: 39,
          uploadedAt: '2026-09-23T18:08:40.000Z',
          originalName: 'box-39.mp4',
          size: 44.7 * 1024 * 1024,
          uploadedByName: 'Chandan Yadav',
        },
        {
          id: 'vid-38',
          boxNo: 38,
          uploadedAt: '2026-09-23T18:08:10.000Z',
          originalName: 'box-38.mp4',
          size: 31.2 * 1024 * 1024,
          uploadedByName: 'Chandan Yadav',
        },
      ],
    })

    const boxEvent = events.find((event) => event.id === 'evt-box-39')
    expect(boxEvent.description).toBe('Box sealed with 124 units · Weight: 14 kg')
    expect(events.map((event) => event.id)).toEqual([
      'evt-audit-39-adj-1',
      'evt-vid-vid-39',
      'evt-vid-vid-38',
      'evt-box-39',
      'evt-created',
    ])
  })

  it('does not mark an open live box as sealed, and keeps the saved count on an overlaid box', () => {
    const events = buildConsignmentTimeline({
      boxes: [
        {
          boxNo: 4,
          createdAt: '2026-09-23T12:00:00.000Z',
          weight: 8,
          liveOverlay: true,
          sealedTotalQty: 18,
          totalQty: 40,
          items: [{ qty: 40 }],
        },
        {
          boxNo: 5,
          liveUnsaved: true,
          createdAt: '2026-09-23T12:05:00.000Z',
          totalQty: 7,
          items: [{ qty: 7 }],
        },
      ],
    })
    expect(events.find((event) => event.id === 'evt-box-4').description).toBe('Box sealed with 18 units · Weight: 8 kg')
    expect(events.find((event) => event.id === 'evt-box-5')).toBeUndefined()
  })

  it('does not invent a unit when a box line has no quantity', () => {
    const events = buildConsignmentTimeline({
      boxes: [{
        boxNo: 4,
        createdAt: '2026-09-23T12:00:00.000Z',
        items: [{ skuId: 'empty' }],
      }],
    })
    expect(events[0].description).toBe('Box sealed with 0 units')
  })

  it('uses workflow stage keys and shows added quantities as additions', () => {
    const events = buildConsignmentTimeline({
      stageConfirmations: {
        ready_for_dispatch: {
          confirmedAt: '2026-09-24T04:00:00.000Z',
          confirmedByName: 'Pawan Shukla',
          note: 'Vehicle booked',
        },
        inward_completed: {
          confirmedAt: '2026-09-25T04:00:00.000Z',
          confirmedByName: 'Warehouse',
          note: 'Received in full',
        },
      },
      boxes: [{
        boxNo: 2,
        createdAt: '2026-09-23T12:00:00.000Z',
        totalQty: 10,
        adjustments: [{
          id: 'add-1',
          status: 'completed',
          completedAt: '2026-09-23T12:10:00.000Z',
          actionType: 'add',
          quantity: 3,
          internalSku: 'SKU-1',
        }],
      }],
    })

    expect(events.find((event) => event.id === 'evt-stage-ready_for_dispatch')).toMatchObject({
      title: 'Ready to Dispatch Sign-off',
      badge: 'Stage: Ready',
      description: 'Note: "Vehicle booked"',
      user: 'Pawan Shukla',
    })
    expect(events.find((event) => event.id === 'evt-stage-inward_completed').title).toBe('Warehouse Inward Completed')
    expect(events.find((event) => event.id === 'evt-audit-2-add-1').description).toContain('+3')
  })

  it('ignores pending adjustments and does not duplicate auditLog copies', () => {
    const events = buildConsignmentTimeline({
      boxes: [{
        boxNo: 2,
        createdAt: '2026-09-23T12:00:00.000Z',
        totalQty: 10,
        adjustments: [
          { id: 'same', status: 'completed', completedAt: '2026-09-23T12:05:00.000Z', quantity: 1, actionType: 'remove' },
          { id: 'pending', status: 'pending_finalize', completedAt: '2026-09-23T12:06:00.000Z', quantity: 2, actionType: 'remove' },
        ],
        auditLog: [
          { id: 'same', status: 'completed', completedAt: '2026-09-23T12:05:00.000Z', quantity: 1, actionType: 'remove' },
        ],
      }],
    })
    expect(events.filter((event) => event.type === 'audit')).toHaveLength(1)
  })
})
