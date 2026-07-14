export function resolvePosthogDashboardUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.pathname.startsWith('/shared/')) {
      url.pathname = url.pathname.replace(/^\/shared\//, '/embedded/')
    }
    return url.toString()
  } catch {
    return trimmed
  }
}
