const DEFAULT_POSTHOG_EMBED_URL = 'https://us.posthog.com/embedded/aUBKw6XLlFMPLf2WJbRbmEzbfSpIyQ';

function resolvePosthogDashboardUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    if (url.pathname.startsWith('/shared/')) {
      url.pathname = url.pathname.replace(/^\/shared\//, '/embedded/');
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

function getPosthogDashboardUrl() {
  const configured = process.env.POSTHOG_DASHBOARD_URL
    || process.env.VITE_POSTHOG_DASHBOARD_URL
    || DEFAULT_POSTHOG_EMBED_URL;
  return resolvePosthogDashboardUrl(configured);
}

function getBetterStackDashboardUrl() {
  return String(
    process.env.BETTERSTACK_DASHBOARD_URL
    || process.env.VITE_BETTERSTACK_DASHBOARD_URL
    || ''
  ).trim();
}

module.exports = {
  DEFAULT_POSTHOG_EMBED_URL,
  resolvePosthogDashboardUrl,
  getPosthogDashboardUrl,
  getBetterStackDashboardUrl,
};
