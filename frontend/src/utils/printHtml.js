/**
 * Safe HTML helpers for print windows — escape every dynamic value.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Open a print window with a fully assembled HTML document.
 * Caller must escape every dynamic value before interpolation into `html`.
 */
export function openEscapedPrintWindow(html, { width = 800, height = 1000 } = {}) {
  const w = window.open('', '_blank', `width=${width},height=${height}`)
  if (!w) return null
  w.document.open()
  w.document.write(html)
  w.document.close()
  return w
}
