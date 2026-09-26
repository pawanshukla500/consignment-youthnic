import { describe, it, expect } from 'vitest'
import { upsertToast } from '../toastDedupe'

const base = { id: 1, message: 'Resume and close Box 5 first', type: 'error', duration: 6000 }

describe('upsertToast', () => {
  it('appends a genuinely new toast', () => {
    const result = upsertToast([], base)
    expect(result.merged).toBe(false)
    expect(result.list).toHaveLength(1)
    expect(result.toast.count).toBe(1)
  })

  it('merges an identical repeat into the visible toast with a counter instead of stacking', () => {
    let list = []
    list = upsertToast(list, { ...base }).list
    list = upsertToast(list, { ...base, id: 2 }).list
    list = upsertToast(list, { ...base, id: 3 }).list
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(1)
    expect(list[0].count).toBe(3)
  })

  it('does not merge when the type differs — an error must not hide behind an info', () => {
    const first = upsertToast([], { ...base, type: 'info' }).list
    const second = upsertToast(first, { ...base, id: 2, type: 'error' })
    expect(second.merged).toBe(false)
    expect(second.list).toHaveLength(2)
  })

  it('does not merge different messages', () => {
    const first = upsertToast([], base).list
    const second = upsertToast(first, { ...base, id: 2, message: 'Not in shipment: X002' })
    expect(second.merged).toBe(false)
    expect(second.list).toHaveLength(2)
  })

  it('refreshes the duration on merge so a repeated warning stays visible', () => {
    const first = upsertToast([], { ...base, duration: 4000 }).list
    const { toast, merged } = upsertToast(first, { ...base, id: 2, duration: 8000 })
    expect(merged).toBe(true)
    expect(toast.duration).toBe(8000)
  })
})
