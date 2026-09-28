import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import TrendChart from '../TrendChart'

describe('TrendChart component', () => {
  it('renders empty state when data has no values', () => {
    const html = renderToString(
      <TrendChart data={[]} emptyLabel="No trend data recorded" />
    )
    expect(html).toContain('No trend data recorded')
  })

  it('renders empty state when all data points have 0 values', () => {
    const data = [
      { date: '2026-09-28', label: '28 Sep', boxes: 0, items: 0 },
      { date: '2026-09-29', label: '29 Sep', boxes: 0, items: 0 },
    ]
    const html = renderToString(<TrendChart data={data} />)
    expect(html).toContain('No packing activity recorded')
  })

  it('renders smooth area chart with integrated title and KPIs', () => {
    const data = [
      { date: '2026-09-28', label: '28 Sep', boxes: 73, items: 142 },
      { date: '2026-09-29', label: '29 Sep', boxes: 0, items: 0 },
      { date: '2026-09-30', label: '30 Sep', boxes: 27, items: 50 },
    ]
    const html = renderToString(
      <TrendChart
        data={data}
        title="Packing Volume Trend"
        activePreset="This Week"
        valueLabel="boxes"
      />
    )

    // Header & Preset
    expect(html).toContain('Packing Volume Trend')
    expect(html).toContain('This Week')

    // KPIs
    expect(html).toContain('Total boxes')
    expect(html).toContain('100') // 73 + 27 = 100
    expect(html).toContain('Peak Day')
    expect(html).toContain('73')
    expect(html).toContain('28 Sep')

    // SVG elements
    expect(html).toContain('<svg')
    expect(html).toContain('aria-label="boxes packing trend"')
    expect(html).toContain('linearGradient')
  })

  it('supports backward compatibility with simple { label, value } data', () => {
    const legacyData = [
      { label: 'Day 1', value: 15 },
      { label: 'Day 2', value: 30 },
    ]
    const html = renderToString(<TrendChart data={legacyData} height={180} />)
    expect(html).toContain('<svg')
    expect(html).toContain('45') // Total
    expect(html).toContain('Day 1')
    expect(html).toContain('Day 2')
  })

  it('renders Units toggle even when all recorded items are 0', () => {
    const dataWithZeroItems = [
      { date: '2026-09-28', label: '28 Sep', boxes: 10, items: 0 },
      { date: '2026-09-29', label: '29 Sep', boxes: 5, items: 0 },
    ]
    const html = renderToString(
      <TrendChart data={dataWithZeroItems} title="Test Trend" />
    )
    expect(html).toContain('tab-metric-units')
    expect(html).toContain('Units')
  })
})
