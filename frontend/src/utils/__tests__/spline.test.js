import { describe, it, expect } from 'vitest'
import { getMonotoneCubicPath, getAreaClosedPath, calculateChartKpis } from '../spline'

describe('spline utility', () => {
  it('handles empty and small point arrays', () => {
    expect(getMonotoneCubicPath([])).toBe('')
    expect(getMonotoneCubicPath([{ x: 10, y: 20 }])).toBe('M 10.0,20.0')
    expect(getMonotoneCubicPath([{ x: 10, y: 20 }, { x: 30, y: 40 }])).toBe('M 10.0,20.0 L 30.0,40.0')
  })

  it('generates smooth cubic bezier curves for 3+ points without overshooting', () => {
    const points = [
      { x: 0, y: 100 },
      { x: 50, y: 20 },
      { x: 100, y: 80 },
      { x: 150, y: 80 },
      { x: 200, y: 100 },
    ]
    const path = getMonotoneCubicPath(points)
    expect(path.startsWith('M 0.0,100.0')).toBe(true)
    expect(path).toContain('C ')
  })

  it('generates closed area path to baseline', () => {
    const points = [
      { x: 0, y: 50 },
      { x: 100, y: 20 },
    ]
    const area = getAreaClosedPath(points, 200)
    expect(area).toBe('M 0.0,50.0 L 100.0,20.0 L 100.0,200.0 L 0.0,200.0 Z')
  })

  it('computes correct KPIs for timeseries data', () => {
    const data = [
      { date: '2026-09-28', label: '28 Sep', boxes: 73, items: 140 },
      { date: '2026-09-29', label: '29 Sep', boxes: 0, items: 0 },
      { date: '2026-09-30', label: '30 Sep', boxes: 27, items: 60 },
      { date: '2026-10-01', label: '1 Oct', boxes: 0, items: 0 },
    ]

    const boxKpis = calculateChartKpis(data, 'boxes')
    expect(boxKpis.total).toBe(100)
    expect(boxKpis.peak).toBe(73)
    expect(boxKpis.peakItem.label).toBe('28 Sep')
    expect(boxKpis.activeDays).toBe(2)
    expect(boxKpis.totalDays).toBe(4)
    expect(boxKpis.dailyAvg).toBe(25)
    expect(boxKpis.activeAvg).toBe(50)
    expect(boxKpis.hasData).toBe(true)

    const itemKpis = calculateChartKpis(data, 'items')
    expect(itemKpis.total).toBe(200)
    expect(itemKpis.peak).toBe(140)
    expect(itemKpis.activeDays).toBe(2)
  })

  it('handles empty and all-zero datasets gracefully', () => {
    const emptyKpis = calculateChartKpis([])
    expect(emptyKpis.hasData).toBe(false)
    expect(emptyKpis.total).toBe(0)

    const zeroKpis = calculateChartKpis([{ value: 0 }, { value: 0 }])
    expect(zeroKpis.hasData).toBe(false)
    expect(zeroKpis.total).toBe(0)
    expect(zeroKpis.activeDays).toBe(0)
  })
})
