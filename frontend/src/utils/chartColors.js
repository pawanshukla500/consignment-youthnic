/**
 * Chart color tokens.
 *
 * STATUS_HEX / WORKFLOW_BUCKET_HEX are a *reserved* mapping — one hex per
 * state, tied to meaning, mirroring the same colors already used for badges
 * and pills across Dashboard/Productivity/Consignments (see
 * utils/workflowPriority.js WORKFLOW_BUCKET_CLASS). A chart segment for
 * "Disputed" must be the same red as the "Disputed" badge next to it, so
 * these are keyed by bucket/status, never reassigned by rank or filter.
 *
 * CATEGORICAL is the validated default palette for genuinely identity-based
 * series with no inherent status meaning (e.g. marketplace names) — fixed
 * hue order, never cycled, worst-case adjacent CVD ΔE 9.1 (OKLab, ≥8 target).
 */

export const STATUS_HEX = {
  completed: '#10b981',
  inProgress: '#3b82f6',
  pending: '#f59e0b',
  disputed: '#ef4444',
  neutral: '#94a3b8',
};

/** Mirrors WORKFLOW_BUCKET_CLASS's badge hues, one hex per bucket. */
export const WORKFLOW_BUCKET_HEX = {
  new: '#0ea5e9',
  active: '#3b82f6',
  packed_pending_invoice: '#f59e0b',
  ready_for_dispatch: '#10b981',
  shipped: '#6366f1',
  inward_pending: '#8b5cf6',
  disputed: '#ef4444',
  inwarded: '#94a3b8',
  archived: '#64748b',
};

/** Validated categorical order — assign by first-seen rank, never reassign. */
export const CATEGORICAL = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export const SEQUENTIAL_BLUE = '#2a78d6';

export const CHART_INK = {
  primary: '#0f172a',
  secondary: '#475569',
  muted: '#94a3b8',
  grid: '#e2e8f0',
  baseline: '#cbd5e1',
};

export function categoricalColor(index) {
  return CATEGORICAL[index % CATEGORICAL.length];
}

/** Compact number formatting for axis ticks / stat values: 1284 -> "1.3K". */
export function formatCompactNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

/** Round a max value up to a "clean" tick ceiling (0/1000/2000-style steps). */
export function niceCeiling(max) {
  const n = Math.max(1, Number(max) || 0);
  const magnitude = 10 ** Math.floor(Math.log10(n));
  const normalized = n / magnitude;
  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;
  return step * magnitude;
}
