/**
 * Small dialect helpers for Postgres vs CockroachDB Cloud differences.
 */
const { validateDatabaseUrl, resolveDatabaseUrl } = require('./dbConnection');

let cachedProvider = null;

function getDbProvider() {
  if (cachedProvider) return cachedProvider;
  const validation = validateDatabaseUrl(resolveDatabaseUrl());
  cachedProvider = validation.valid ? validation.provider : 'unknown';
  return cachedProvider;
}

function isCockroach() {
  const provider = getDbProvider();
  if (provider === 'cockroach') return true;
  const url = resolveDatabaseUrl();
  return /cockroachlabs\.cloud|:26257\b/i.test(url);
}

/**
 * Serialize work for a logical key inside an open transaction.
 * Postgres: advisory xact lock. Cockroach: row FOR UPDATE on the consignment doc.
 */
async function acquireTxSerializationLock(client, key) {
  const lockKey = String(key || '');
  if (!lockKey) return;

  if (!isCockroach()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    return;
  }

  // packing:consignmentId → lock the consignments document row when present
  const consignmentId = lockKey.startsWith('packing:')
    ? lockKey.slice('packing:'.length)
    : lockKey;

  if (!consignmentId) return;

  await client.query(
    `SELECT id FROM documents
     WHERE collection = 'consignments' AND id = $1
     FOR UPDATE`,
    [consignmentId]
  );
}

module.exports = {
  getDbProvider,
  isCockroach,
  acquireTxSerializationLock,
};
