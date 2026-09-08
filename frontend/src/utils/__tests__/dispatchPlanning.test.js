import { describe, expect, it } from 'vitest'
import { applyDispatchDates, computeRequiredDispatchDate } from '../dispatchPlanning'

const flipkart = {
  id: 'mp-flipkart',
  warehouses: [{ name: 'HYD-2', transitDays: 4 }],
}

describe('dispatch planning dates', () => {
  it('subtracts transit days from a date-only appointment without timezone shift', () => {
    expect(computeRequiredDispatchDate('2026-09-15', 3)).toBe('2026-09-12')
    expect(computeRequiredDispatchDate('2026-01-02', 1)).toBe('2026-01-01')
  })

  it('clears stale scheduled dispatch when marketplace change leaves warehouse empty', () => {
    const next = applyDispatchDates({
      marketplaceId: 'mp-flipkart',
      warehouse: '',
      appointmentDate: '2026-09-15',
      scheduledDispatchDate: '2026-09-10',
    }, [flipkart])
    expect(next.scheduledDispatchDate).toBe('')
  })

  it('recomputes scheduled dispatch for the selected warehouse', () => {
    const next = applyDispatchDates({
      marketplaceId: 'mp-flipkart',
      warehouse: 'HYD-2',
      appointmentDate: '2026-09-15',
      scheduledDispatchDate: '2026-09-10',
    }, [flipkart])
    expect(next.scheduledDispatchDate).toBe('2026-09-11')
  })
})
