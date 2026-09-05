// Read-only release gate: connectivity alone cannot prove desktop readiness.
const { BackendClient } = require('../../desktop/src/backendClient.cjs');
const base = (process.argv[2] || 'https://consignment.youthnic.shop').replace(/\/$/, '');
const client = new BackendClient({ baseUrl: base.endsWith('/api') ? base : `${base}/api` });
(async () => {
  const health = await client.request('/health', { timeoutMs: 15000 });
  if (health.database !== 'connected') throw new Error('Configured application database is not connected');
  await client.checkCompatibility();
  console.log('PASS: deployed desktop protocol, database tables, and unique station ownership index are ready');
})().catch((error) => {
  console.error(`Desktop release blocked (${error.code || error.status || 'CONNECTION_FAILED'}): ${error.message}`);
  process.exitCode = 1;
});
