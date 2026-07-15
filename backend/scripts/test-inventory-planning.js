/**
 * Inventory planning allocation + status tests.
 * Run: node scripts/test-inventory-planning.js
 */
const assert = require('assert');
const {
  allocateInventory,
  deriveInventoryStatus,
  buildSkuDemand,
  applyStockToDemand,
  isOpenConsignment,
  INVENTORY_STATUSES,
  buildAlertFingerprint,
  normalizeInventoryRows,
} = (() => {
  const planning = require('../utils/inventoryPlanning');
  const client = require('../utils/omsGuruInventoryClient');
  return { ...planning, normalizeInventoryRows: client.normalizeInventoryRows };
})();

// --- Example from the product brief ---
{
  const a = allocateInventory(50, 30, 20, 60);
  assert.strictEqual(a.criticalCovered, 50);
  assert.strictEqual(a.criticalShortage, 0);
  assert.strictEqual(a.remainingAfterAllocation, 0); // 60-50-10=0 after urgent partial
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

// Duplicate consignment / SKU demand aggregation (same SKU across consignments, no double count within one line)
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
      skus: [{ internalSku: 'SKU123', requiredQty: 40, packedQty: 10 }], // remaining 30 urgent
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
  assert.strictEqual(demand[0].totalPlannedQty, 100); // 50+30+20
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

// Duplicate SKU rows in OMSGuru response — first wins
{
  const { rows, skipped } = normalizeInventoryRows([
    { sku_code: 'A', quantity: 5 },
    { sku: 'A', inventory: 9 },
    { sku: 'B', qty: '' },
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].quantity, 5);
  assert.ok(skipped.some((s) => s.reason === 'duplicate_sku_in_response'));
  assert.ok(skipped.some((s) => s.reason === 'blank'));
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

// Sync failed status
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
