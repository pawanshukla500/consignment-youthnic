/**
 * Monotone Cubic Spline (Fritsch-Carlson) interpolation for SVG charts.
 * Guarantees monotonic curves with zero overshoot or negative dips,
 * creating smooth, high-fidelity visual trajectories.
 */

/**
 * Builds a smooth SVG cubic Bezier curve path string for an array of 2D points.
 * @param {Array<{ x: number, y: number }>} points
 * @returns {string} SVG path string
 */
export function getMonotoneCubicPath(points) {
  if (!points || points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`
  }

  const n = points.length
  const deltas = new Array(n - 1)
  const m = new Array(n)

  // 1. Compute secant line slopes between consecutive points
  for (let k = 0; k < n - 1; k++) {
    const dx = points[k + 1].x - points[k].x
    deltas[k] = dx === 0 ? 0 : (points[k + 1].y - points[k].y) / dx
  }

  // 2. Initialise tangents at each point
  m[0] = deltas[0]
  for (let k = 1; k < n - 1; k++) {
    // If adjacent secant slopes have opposite signs, tangent must be 0 to prevent local extrema
    if (deltas[k - 1] * deltas[k] <= 0) {
      m[k] = 0
    } else {
      m[k] = (deltas[k - 1] + deltas[k]) / 2
    }
  }
  m[n - 1] = deltas[n - 2]

  // 3. Fritsch-Carlson bounds: ensure monotonicity within each interval
  for (let k = 0; k < n - 1; k++) {
    if (deltas[k] === 0) {
      m[k] = 0
      m[k + 1] = 0
      continue
    }
    const alpha = m[k] / deltas[k]
    const beta = m[k + 1] / deltas[k]

    if (alpha < 0) m[k] = 0
    if (beta < 0) m[k + 1] = 0

    const hypo = alpha * alpha + beta * beta
    if (hypo > 9) {
      const tau = 3 / Math.sqrt(hypo)
      m[k] = tau * alpha * deltas[k]
      m[k + 1] = tau * beta * deltas[k]
    }
  }

  // 4. Construct SVG Bezier curve segments
  let path = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
  for (let k = 0; k < n - 1; k++) {
    const p0 = points[k]
    const p1 = points[k + 1]
    const dx = p1.x - p0.x
    const cp1x = p0.x + dx / 3
    const cp1y = p0.y + (m[k] * dx) / 3
    const cp2x = p1.x - dx / 3
    const cp2y = p1.y - (m[k + 1] * dx) / 3

    path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
  }

  return path
}

/**
 * Creates a closed SVG area path under the curve down to baselineY.
 * @param {Array<{ x: number, y: number }>} points
 * @param {number} baselineY
 * @returns {string}
 */
export function getAreaClosedPath(points, baselineY) {
  if (!points || points.length === 0) return ''
  const linePath = getMonotoneCubicPath(points)
  const last = points[points.length - 1]
  const first = points[0]
  return `${linePath} L ${last.x.toFixed(1)},${baselineY.toFixed(1)} L ${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`
}

/**
 * Computes summary KPI metrics for a timeseries dataset.
 * @param {Array<object>} data
 * @param {string} metricKey
 * @returns {object}
 */
export function calculateChartKpis(data = [], metricKey = 'value') {
  if (!data || data.length === 0) {
    return {
      total: 0,
      peak: 0,
      peakItem: null,
      activeDays: 0,
      dailyAvg: 0,
      activeAvg: 0,
      hasData: false,
    }
  }

  let total = 0
  let peak = -Infinity
  let peakItem = null
  let activeDays = 0

  for (const item of data) {
    const v = Number(item[metricKey] ?? item.value ?? 0)
    total += v
    if (v > peak) {
      peak = v
      peakItem = item
    }
    if (v > 0) {
      activeDays += 1
    }
  }

  if (peak === -Infinity) peak = 0

  return {
    total,
    peak,
    peakItem,
    activeDays,
    totalDays: data.length,
    dailyAvg: data.length > 0 ? total / data.length : 0,
    activeAvg: activeDays > 0 ? total / activeDays : 0,
    hasData: total > 0,
  }
}
