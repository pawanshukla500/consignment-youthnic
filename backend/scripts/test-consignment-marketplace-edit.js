const assert = require('assert');
const {
  collectChangedFields,
  resolveWarehouseForMarketplace,
  buildConsignmentUpdateAuditDetails,
} = require('../utils/consignmentFieldAudit');

const existing = {
  marketplaceId: 'mp-amazon',
  warehouse: 'BLR-1',
  docketNo: 'D1',
};

const amazon = {
  id: 'mp-amazon',
  name: 'Amazon',
  warehouses: [{ name: 'BLR-1', transitDays: 3 }, { name: 'DEL-9', transitDays: 2 }],
};

const flipkart = {
  id: 'mp-flipkart',
  name: 'Flipkart',
  warehouses: [{ name: 'HYD-2', transitDays: 4 }],
};

const unchanged = collectChangedFields(existing, {
  marketplaceId: 'mp-amazon',
  warehouse: 'BLR-1',
  updatedAt: '2026-09-08T00:00:00.000Z',
}, ['marketplaceId', 'warehouse']);
assert.deepStrictEqual(unchanged, {});

const changed = collectChangedFields(existing, {
  marketplaceId: 'mp-flipkart',
  warehouse: 'HYD-2',
}, ['marketplaceId', 'warehouse']);
assert.deepStrictEqual(changed.marketplaceId, { from: 'mp-amazon', to: 'mp-flipkart' });
assert.deepStrictEqual(changed.warehouse, { from: 'BLR-1', to: 'HYD-2' });

assert.deepStrictEqual(
  resolveWarehouseForMarketplace(amazon, 'DEL-9'),
  { warehouse: 'DEL-9', cleared: false, invalid: false }
);
assert.deepStrictEqual(
  resolveWarehouseForMarketplace(flipkart, 'BLR-1'),
  { warehouse: '', cleared: true, invalid: true }
);

const audit = buildConsignmentUpdateAuditDetails(
  existing,
  { marketplaceId: 'mp-flipkart', warehouse: 'HYD-2' },
  { id: 'user-1', name: 'Pawan Shukla', email: 'returnorders@vbexports.co.in' }
);
assert.strictEqual(audit.changedBy.id, 'user-1');
assert.strictEqual(audit.changedBy.name, 'Pawan Shukla');
assert.strictEqual(audit.changedBy.email, 'returnorders@vbexports.co.in');
assert.deepStrictEqual(audit.marketplaceId, { from: 'mp-amazon', to: 'mp-flipkart' });
assert.deepStrictEqual(audit.warehouse, { from: 'BLR-1', to: 'HYD-2' });
assert.ok(!audit.changes.updatedAt);

const timestampOnly = buildConsignmentUpdateAuditDetails(
  existing,
  { marketplaceId: 'mp-amazon', warehouse: 'BLR-1', updatedAt: '2026-09-08T00:00:00.000Z' },
  { id: 'user-1', name: 'Pawan Shukla', email: 'returnorders@vbexports.co.in' }
);
assert.deepStrictEqual(timestampOnly.changes, {});

const cleared = buildConsignmentUpdateAuditDetails(
  existing,
  { marketplaceId: 'mp-flipkart', warehouse: '' },
  { id: 'user-1', name: 'Pawan Shukla', email: 'returnorders@vbexports.co.in' },
  { warehouseClearedAsInvalid: true }
);
assert.strictEqual(cleared.warehouseClearedAsInvalid, true);
assert.deepStrictEqual(cleared.warehouse, { from: 'BLR-1', to: null });
assert.strictEqual(cleared.changedBy.email, 'returnorders@vbexports.co.in');

console.log('consignment marketplace/warehouse edit audit tests passed');
