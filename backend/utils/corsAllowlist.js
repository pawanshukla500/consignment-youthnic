/**
 * Exact CORS origin allowlist — no suffix / wildcard matching.
 */
function parseAllowedOrigins(raw = process.env.ALLOWED_ORIGINS || '') {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildDevOrigins() {
  if (process.env.NODE_ENV === 'production') return [];
  return [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ];
}

function isOriginAllowed(origin, allowedList = null) {
  if (!origin) return true; // non-browser / same-origin tooling
  const allowed = new Set([...(allowedList || parseAllowedOrigins()), ...buildDevOrigins()]);
  return allowed.has(origin);
}

function createCorsOriginDelegate(allowedList = null) {
  const list = allowedList || [...parseAllowedOrigins(), ...buildDevOrigins()];
  return (origin, cb) => {
    if (isOriginAllowed(origin, list)) return cb(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    return cb(null, false);
  };
}

module.exports = {
  parseAllowedOrigins,
  buildDevOrigins,
  isOriginAllowed,
  createCorsOriginDelegate,
};
