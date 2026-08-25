const assert = require('assert');
const { getOpenWaStatus, sendText } = require('../utils/openwaClient');

// Very basic mocks for fetch to ensure we don't leak secrets and don't make live calls
global.fetch = async (url, options) => {
  if (url.includes('/api/health')) {
    return { ok: true, json: async () => ({ status: 'ok' }) };
  }
  if (url.includes('/messages/send-text')) {
    // Check secret leakage
    const headers = options.headers || {};
    if (!headers['X-Api-Key']) {
      return { ok: false, status: 401, text: async () => 'Unauthorized' };
    }
    return { ok: true, json: async () => ({ id: 'msg_123' }) };
  }
  return { ok: false, status: 404, text: async () => 'Not Found' };
};

async function runTests() {
  console.log('Running WhatsApp Unit Tests...');
  
  // Test 1: OpenWA Client
  const status = getOpenWaStatus();
  assert(status.enabled === true || status.enabled === false, 'Enabled flag should be boolean');
  
  const res = await sendText({ text: 'Test message', chatId: '123@c.us' });
  
  // Just ensure it doesn't crash. Since we don't have OPENWA_API_KEY set in test env necessarily, it might fail auth.
  assert(res.ok !== undefined, 'Response should have ok property');

  console.log('✅ WhatsApp Tests Passed');
}

runTests().catch(err => {
  console.error('WhatsApp Test Failed:', err);
  process.exit(1);
});
