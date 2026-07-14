/**
 * Supabase client config for the backend.
 * Live sync uses Realtime Broadcast only (see utils/supabaseRealtime.js).
 * Operational data uses DATABASE_URL Postgres. Files use Cloudflare R2.
 * Do not point SUPABASE_DB_URL at the free-tier Realtime project.
 */
const { getConfig, getRealtimeStatus } = require('../utils/supabaseRealtime');

module.exports = {
  supabase: null,
  supabaseEnabled: () => getConfig().enabled,
  getRealtimeStatus,
};
