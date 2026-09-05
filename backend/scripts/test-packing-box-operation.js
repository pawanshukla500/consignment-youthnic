const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildBoxOperationHash, assertBoxOperationMatches } = require('../utils/packingOperation');

const a = buildBoxOperationHash({
  consignmentId: 'c-1', boxNo: '1', weight: 10, weightUnit: 'KG',
  items: [{ skuId: 'sku-2', qty: 1 }, { skuId: 'sku-1', qty: 2 }],
});
const b = buildBoxOperationHash({
  consignmentId: 'c-1', boxNo: '1', weight: 10, weightUnit: 'KG',
  items: [{ skuId: 'sku-1', qty: 2 }, { skuId: 'sku-2', qty: 1 }],
});
assert.equal(a, b, 'operation hash must not depend on item order');

assert.throws(
  () => assertBoxOperationMatches({ consignment_id: 'c-1', box_id: 'c-1::1', payload_hash: a }, {
    consignmentId: 'c-1', boxId: 'c-1::1', payloadHash: 'different',
  }),
  (error) => error.code === 'BOX_OPERATION_PAYLOAD_MISMATCH' && error.statusCode === 409,
);

const route = fs.readFileSync(require.resolve('../routes/packing.js'), 'utf8');
const migration = fs.readFileSync(require.resolve('../../supabase/migrations/20260904000000_desktop_packing_station.sql'), 'utf8');
const cockroachSchema = fs.readFileSync(require.resolve('./apply-cockroach-schema.js'), 'utf8');
assert.match(route, /operation_id/);
assert.match(route, /DESKTOP_POSTGRES_REQUIRED/);
assert.match(route, /PACKING_LEASE_NOT_ACTIVE/);
assert.match(route, /DESKTOP_STATION_ID_REQUIRED/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS packing_box_operations/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS packing_station_leases/);
assert.match(cockroachSchema, /CREATE TABLE IF NOT EXISTS packing_box_operations/);
assert.match(cockroachSchema, /CREATE TABLE IF NOT EXISTS packing_station_leases/);
console.log('packing box operation idempotency checks passed');

// Exercise station isolation with the PostgreSQL interface, without connecting
// to a configured/live database or bootstrapping users.
const databasePath = require.resolve('../config/database');
const previousDatabase = require.cache[databasePath];
let lease = { station_id: 'station-a', user_id: 'operator-a', station_name: 'Station A' };
const queryable = { async query(sql) {
  if (sql.includes('to_regclass')) return { rows: [{ relation: 'packing_station_leases' }] };
  assert.match(sql, /status = 'active'/);
  return { rows: lease ? [lease] : [] };
} };
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { pgEnabled: () => true, getPool: () => queryable } };
const { assertPackingStationAccess } = require('../utils/packingLease');
(async () => {
  await assert.rejects(assertPackingStationAccess('c1', null, 'operator-a'), { code: 'PACKING_STATION_CONFLICT' });
  await assert.rejects(assertPackingStationAccess('c1', 'station-b', 'operator-a'), { code: 'PACKING_STATION_CONFLICT' });
  await assert.rejects(assertPackingStationAccess('c1', 'station-a', 'operator-b'), { code: 'PACKING_STATION_CONFLICT' });
  await assert.doesNotReject(assertPackingStationAccess('c1', 'station-a', 'operator-a', queryable));
  lease = null;
  await assert.doesNotReject(assertPackingStationAccess('c1', null, 'web-operator'));
  console.log('packing station owner and web conflict tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (previousDatabase) require.cache[databasePath] = previousDatabase;
  else delete require.cache[databasePath];
});
