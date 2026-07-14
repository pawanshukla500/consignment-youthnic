/**
 * PostgreSQL connection string resolution, validation, and pool configuration.
 * Supports Neon pooler, Supabase, Cloud SQL / Firebase SQL, and local/office Postgres.
 */
const fs = require('fs');
const { URL } = require('url');

const SUPPORTED_PROTOCOLS = ['postgresql:', 'postgres:'];

function resolveDatabaseUrl() {
  const raw = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  return String(raw).trim();
}

function redactDatabaseUrl(connectionString) {
  if (!connectionString) return null;
  try {
    const parsed = new URL(connectionString);
    const user = parsed.username || 'unknown';
    const host = parsed.hostname || 'unknown';
    const port = parsed.port || '5432';
    const db = parsed.pathname?.replace(/^\//, '') || 'unknown';
    const ssl = parsed.searchParams.get('sslmode') || (process.env.DB_SSL === 'true' ? 'require' : 'prefer');
    return `postgresql://${user}:***@${host}:${port}/${db}?sslmode=${ssl}`;
  } catch {
    return 'postgresql://[invalid-url]';
  }
}

function validateDatabaseUrl(connectionString) {
  const trimmed = String(connectionString || '').trim();

  if (!trimmed) {
    return {
      valid: false,
      code: 'MISSING_URL',
      error: 'Database URL is not set. Configure SUPABASE_DB_URL or DATABASE_URL.',
      hint: 'Set DATABASE_URL in GitHub Secrets and Cloud Run. URL-encode special characters in passwords ($ → %24, @ → %40).',
      source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : (process.env.DATABASE_URL ? 'DATABASE_URL' : 'none'),
    };
  }

  if (/^postgres(ql)?:\/\//i.test(trimmed) === false) {
    return {
      valid: false,
      code: 'MISSING_PROTOCOL',
      error: 'Database URL must start with postgresql:// or postgres://',
      hint: 'Example: postgresql://user:password@host:5432/dbname?sslmode=require',
      source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
    };
  }

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROTOCOLS.includes(parsed.protocol)) {
      return {
        valid: false,
        code: 'INVALID_PROTOCOL',
        error: `Unsupported protocol: ${parsed.protocol}`,
        source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
      };
    }
    if (!parsed.hostname) {
      return {
        valid: false,
        code: 'MISSING_HOST',
        error: 'Database URL is missing a hostname.',
        source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
      };
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      return {
        valid: false,
        code: 'MISSING_DATABASE',
        error: 'Database URL is missing a database name.',
        source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
      };
    }

    return {
      valid: true,
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, ''),
      user: parsed.username || null,
      sslMode: parsed.searchParams.get('sslmode') || null,
      provider: detectProvider(parsed.hostname),
      source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
      redacted: redactDatabaseUrl(trimmed),
    };
  } catch (e) {
    return {
      valid: false,
      code: 'INVALID_URL',
      error: `Database URL is malformed: ${e.message}`,
      hint: 'Check for unencoded special characters in the password. Encode $ as %24, @ as %40, # as %23, & as %26.',
      source: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL',
    };
  }
}

function detectProvider(hostname) {
  if (!hostname) return 'unknown';
  if (hostname.includes('neon.tech')) return 'neon';
  if (hostname.includes('supabase.co')) return 'supabase';
  if (hostname.includes('googleusercontent.com') || hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) return 'cloud-sql';
  return 'postgresql';
}

/** localhost + RFC1918 private ranges — OK to run without TLS on a trusted LAN. */
function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function shouldUseSsl(connectionString, hostname) {
  const explicit = String(process.env.DB_SSL || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'off') return false;
  if (explicit === 'true' || explicit === '1' || explicit === 'on') return true;
  if (connectionString.includes('sslmode=require')) return true;
  if (connectionString.includes('neon.tech') || connectionString.includes('supabase.co')) return true;
  // Production + public/routable host → require TLS unless explicitly opted out above.
  if (process.env.NODE_ENV === 'production' && !isLocalOrPrivateHost(hostname)) return true;
  return false;
}

function buildSslOptions() {
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
    || Boolean(process.env.DB_CA_CERT);
  const options = { rejectUnauthorized };
  if (process.env.DB_CA_CERT) {
    try {
      options.ca = fs.readFileSync(process.env.DB_CA_CERT, 'utf8');
    } catch (error) {
      console.warn('[Postgres] Could not read DB_CA_CERT:', error.message);
    }
  }
  return options;
}

function stripOrSetSslMode(connectionString, mode) {
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.set('sslmode', mode);
    // pg v8+ / pg-connection-string treats prefer/require as verify-full unless compat is on.
    if (mode === 'disable') {
      parsed.searchParams.delete('uselibpqcompat');
    }
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function buildPoolConfig(connectionString) {
  const validation = validateDatabaseUrl(connectionString);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const useSsl = shouldUseSsl(connectionString, validation.host);
  if (!useSsl && !isLocalOrPrivateHost(validation.host)) {
    console.warn(
      `[Postgres] Connecting to ${validation.host} without SSL. ` +
      'Set DB_SSL=true (and preferably DB_CA_CERT) when the database is reachable outside a private LAN.'
    );
  }

  // Important: even with ssl:undefined, a URL sslmode=prefer/require still triggers SSL in pg.
  const resolvedUrl = useSsl
    ? stripOrSetSslMode(connectionString, 'require')
    : stripOrSetSslMode(connectionString, 'disable');

  const poolMax = parseInt(process.env.DB_POOL_MAX, 10) || 20;

  return {
    connectionString: resolvedUrl,
    max: poolMax,
    min: 2,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    application_name: 'consignment-packing-api',
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10) || 60000,
    ssl: useSsl ? buildSslOptions() : false,
  };
}

module.exports = {
  resolveDatabaseUrl,
  validateDatabaseUrl,
  redactDatabaseUrl,
  buildPoolConfig,
  detectProvider,
  isLocalOrPrivateHost,
  shouldUseSsl,
};
