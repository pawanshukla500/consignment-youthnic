/**
 * Inventory planning allocation + Google Sheet read helpers tests.
 * Run: node scripts/test-inventory-planning.js
 */
const assert = require('assert');
const {
  allocateInventory,
  deriveInventoryStatus,
  buildSkuDemand,
  applyStockToDemand,
  isOpenConsignment,
  normalizeSkuKey,
  INVENTORY_STATUSES,
  buildAlertFingerprint,
} = require('../utils/inventoryPlanning');
const {
  resolveInventoryColumn,
  parseQuantityCell,
  formatSheetDate,
} = require('../utils/googleSheetsInventory');

// --- Example from the product brief ---
{
  const a = allocateInventory(50, 30, 20, 60);
  assert.strictEqual(a.criticalCovered, 50);
  assert.strictEqual(a.criticalShortage, 0);
  assert.strictEqual(a.urgentCovered, 10);
  assert.strictEqual(a.urgentShortage, 20);
  assert.strictEqual(a.normalCovered, 0);
  assert.strictEqual(a.normalShortage, 20);
  assert.strictEqual(a.totalShortage, 40);
  assert.strictEqual(a.suggestedProductionQty, 40);
  assert.strictEqual(deriveInventoryStatus(a), INVENTORY_STATUSES.URGENT_PRODUCTION);
}

// Sufficient inventory
{
  const a = allocateInventory(10, 5, 5, 100);
  assert.strictEqual(a.totalShortage, 0);
  assert.strictEqual(deriveInventoryStatus(a), INVENTORY_STATUSES.SUFFICIENT);
}

// Critical shortage
{
  const a = allocateInventory(80, 10, 10, 50);
  assert.strictEqual(a.criticalShortage, 30);
  assert.strictEqual(deriveInventoryStatus(a), INVENTORY_STATUSES.CRITICAL_SHORTAGE);
}

// Missing inventory treated as missing (not zero)
{
  const a = allocateInventory(10, 0, 0, null);
  assert.strictEqual(a.inventoryMissing, true);
  assert.strictEqual(a.available, null);
  assert.strictEqual(a.totalShortage, 10);
  assert.strictEqual(deriveInventoryStatus(a), INVENTORY_STATUSES.MISSING);
}

// Missing treated as zero when configured
{
  const a = allocateInventory(10, 0, 0, null, { treatMissingAsZero: true });
  assert.strictEqual(a.inventoryMissing, false);
  assert.strictEqual(a.available, 0);
  assert.strictEqual(a.criticalShortage, 10);
}

// Cancelled / completed consignments excluded
{
  assert.strictEqual(isOpenConsignment({ status: 'pending' }), true);
  assert.strictEqual(isOpenConsignment({ status: 'in_progress' }), true);
  assert.strictEqual(isOpenConsignment({ status: 'completed' }), false);
  assert.strictEqual(isOpenConsignment({ status: 'cancelled' }), false);
  assert.strictEqual(isOpenConsignment({ status: 'pending', shipmentStatus: 'Dispatched' }), false);
}

// Demand aggregation across consignments
{
  const consignments = [
    {
      id: 'C1',
      status: 'pending',
      criticalityLevel: 'critical',
      marketplaceName: 'Amazon',
      appointmentDate: '2026-07-20',
      requiredDispatchDate: '2026-07-18',
      transitDays: 2,
      skus: [{ internalSku: 'SKU123', requiredQty: 50, packedQty: 0 }],
    },
    {
      id: 'C2',
      status: 'in_progress',
      criticalityLevel: 'high',
      marketplaceName: 'Flipkart',
      appointmentDate: '2026-07-22',
      requiredDispatchDate: '2026-07-20',
      transitDays: 2,
      skus: [{ internalSku: 'SKU123', requiredQty: 40, packedQty: 10 }],
    },
    {
      id: 'C3',
      status: 'pending',
      criticalityLevel: 'normal',
      skus: [{ internalSku: 'SKU123', requiredQty: 20, packedQty: 0 }],
    },
    {
      id: 'C4',
      status: 'completed',
      criticalityLevel: 'critical',
      skus: [{ internalSku: 'SKU123', requiredQty: 999, packedQty: 0 }],
    },
  ];
  const demand = buildSkuDemand(consignments);
  assert.strictEqual(demand.length, 1);
  assert.strictEqual(demand[0].internalSku, 'SKU123');
  assert.strictEqual(demand[0].totalPlannedQty, 100);
  assert.strictEqual(demand[0].criticalQty, 50);
  assert.strictEqual(demand[0].urgentQty, 30);
  assert.strictEqual(demand[0].normalQty, 20);
  assert.strictEqual(demand[0].activeConsignmentCount, 3);

  const reportRows = applyStockToDemand(demand, {
    SKU123: { quantity: 60, sync_status: 'ok', last_success_at: '2026-07-15T00:00:00Z' },
  });
  assert.strictEqual(reportRows[0].totalShortage, 40);
  assert.strictEqual(reportRows[0].criticalShortage, 0);
  assert.strictEqual(reportRows[0].urgentShortage, 20);
  assert.strictEqual(reportRows[0].normalShortage, 20);
  assert.strictEqual(reportRows[0].inventoryStatus, INVENTORY_STATUSES.URGENT_PRODUCTION);
}

// Sheet Column C is preferred for latest available inventory (default)
{
  const today = formatSheetDate(new Date('2026-07-15T12:00:00Z'));
  const colC = resolveInventoryColumn(['id', 'sku_code', '15/07/2026', '14/07/2026'], today);
  assert.strictEqual(colC.index, 2);
  assert.strictEqual(colC.reason, 'column_c');

  // Even when a newer date exists elsewhere, prefer Column C by default
  const stillC = resolveInventoryColumn(
    ['id', 'sku_code', '14/07/2026', '15/07/2026'],
    '15/07/2026'
  );
  assert.strictEqual(stillC.index, 2);
  assert.strictEqual(stillC.reason, 'column_c');

  const colLatest = resolveInventoryColumn(
    ['id', 'sku_code', '14/07/2026', '15/07/2026'],
    '99/99/9999',
    { preferColumnC: false }
  );
  assert.strictEqual(colLatest.label, '15/07/2026');
  assert.strictEqual(colLatest.reason, 'latest_date');
}

// Available − Planned balance on shortage example
{
  const demand = buildSkuDemand([{
    id: 'C1', status: 'pending', criticalityLevel: 'critical',
    skus: [{ internalSku: 'SKU123', requiredQty: 100, packedQty: 0 }],
  }]);
  const rows = applyStockToDemand(demand, {
    SKU123: { quantity: 80, sync_status: 'ok' },
  });
  assert.strictEqual(rows[0].latestInventory, 80);
  assert.strictEqual(rows[0].totalPlannedQty, 100);
  assert.strictEqual(rows[0].inventoryBalance, -20);
  assert.strictEqual(rows[0].totalShortage, 20);
  assert.strictEqual(rows[0].suggestedProductionQty, 20);
}

// Blank / invalid sheet quantities are rejected (sync writes 0 instead of keeping stale)
{
  assert.strictEqual(parseQuantityCell('').ok, false);
  assert.strictEqual(parseQuantityCell(null).ok, false);
  assert.strictEqual(parseQuantityCell('-1').ok, false);
  assert.strictEqual(parseQuantityCell('12').value, 12);
  assert.strictEqual(parseQuantityCell('1,200').value, 1200);
  assert.strictEqual(parseQuantityCell(0).ok, true);
  assert.strictEqual(parseQuantityCell(0).value, 0);
}

// EJ1201-16001 style: sheet Col C = 0 must win over stale DB qty 955 (case-insensitive match)
{
  assert.strictEqual(normalizeSkuKey('ej1201-16001'), 'EJ1201-16001');
  assert.strictEqual(normalizeSkuKey(' EJ1201-16001 '), 'EJ1201-16001');

  const demand = buildSkuDemand([{
    id: 'C1',
    status: 'pending',
    criticalityLevel: 'critical',
    skus: [{ internalSku: 'ej1201-16001', requiredQty: 100, packedQty: 0 }],
  }]);
  assert.strictEqual(demand[0].internalSku, 'EJ1201-16001');

  // After sync, stock map uses uppercase key and sheet qty 0 (not leftover 955)
  const rows = applyStockToDemand(demand, {
    'EJ1201-16001': { quantity: 0, sync_status: 'ok' },
  });
  assert.strictEqual(rows[0].latestInventory, 0);
  assert.strictEqual(rows[0].inventoryBalance, -100);
  assert.strictEqual(rows[0].totalShortage, 100);

  // Legacy mixed-case stock key still matches
  const rowsMixed = applyStockToDemand(demand, {
    'Ej1201-16001': { quantity: 0, sync_status: 'ok' },
  });
  assert.strictEqual(rowsMixed[0].latestInventory, 0);
}

// Fingerprint changes when shortage changes
{
  const r1 = applyStockToDemand(
    buildSkuDemand([{
      id: 'C1', status: 'pending', criticalityLevel: 'critical',
      skus: [{ internalSku: 'X', requiredQty: 10, packedQty: 0 }],
    }]),
    { X: { quantity: 10, sync_status: 'ok' } }
  );
  const r2 = applyStockToDemand(
    buildSkuDemand([{
      id: 'C1', status: 'pending', criticalityLevel: 'critical',
      skus: [{ internalSku: 'X', requiredQty: 10, packedQty: 0 }],
    }]),
    { X: { quantity: 2, sync_status: 'ok' } }
  );
  assert.notStrictEqual(buildAlertFingerprint(r1), buildAlertFingerprint(r2));
}

// Sheet sync failed status
{
  const rows = applyStockToDemand(
    [{
      internalSku: 'Z',
      productName: '',
      marketplaces: [],
      consignmentIds: ['C'],
      consignmentDetails: [],
      criticalQty: 5,
      urgentQty: 0,
      normalQty: 0,
      totalPlannedQty: 5,
      activeConsignmentCount: 1,
      earliestAppointmentDate: '',
      earliestDispatchDate: '',
      warehouseTatDays: null,
    }],
    { Z: { quantity: null, sync_status: 'failed' } }
  );
  assert.strictEqual(rows[0].inventoryStatus, INVENTORY_STATUSES.SYNC_FAILED);
}

// Never negative available from bad input
{
  const a = allocateInventory(1, 1, 1, -20);
  assert.strictEqual(a.available, 0);
  assert.ok(a.totalShortage >= 0);
}

console.log('Inventory planning tests passed.');
