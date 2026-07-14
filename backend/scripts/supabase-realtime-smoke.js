/**
 * Smoke-test Supabase Realtime Broadcast (no DB/Storage writes).
 * Usage: node scripts/supabase-realtime-smoke.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { broadcastConsignmentChange, getRealtimeStatus } = require('../utils/supabaseRealtime');

async function main() {
  const status = getRealtimeStatus();
  console.log('[realtime-smoke] status:', JSON.stringify(status, null, 2));
  if (!status.configured) {
    console.error('FAIL: SUPABASE_URL / SUPABASE_ANON_KEY not configured');
    process.exit(1);
  }

  const result = await broadcastConsignmentChange({
    id: `smoke-${Date.now()}`,
    status: 'in_progress',
    realtimeType: 'smoke_test',
    updatedAt: new Date().toISOString(),
  });

  if (result?.ok) {
    console.log('PASS: broadcast accepted');
    process.exit(0);
  }

  console.error('FAIL:', result);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
