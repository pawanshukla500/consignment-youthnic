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

  const invHeader = resolveInventoryColumn(['id', 'sku_code', 'Inventory'], today);
  assert.strictEqual(invHeader.index, 2);
  assert.strictEqual(invHeader.reason, 'column_c_inventory');

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

// Service-account JSON parsing (Cloud Run / double-encoded / base64)
{
  const {
    parseServiceAccount,
    getSheetsCredentialStatus,
    formatGoogleSheetsApiError,
  } = require('../utils/googleSheetsInventory');

  const sa = {
    type: 'service_account',
    client_email: 'drive-api@robust-solution-425310-t9.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n',
  };
  const prev = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON;

  process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON = JSON.stringify(sa);
  const parsed = parseServiceAccount();
  assert.strictEqual(parsed.client_email, sa.client_email);
  assert.ok(parsed.private_key.includes('\n'));
  assert.strictEqual(getSheetsCredentialStatus().ready, true);

  process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON = JSON.stringify(JSON.stringify(sa));
  assert.strictEqual(parseServiceAccount().client_email, sa.client_email);

  process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON = Buffer.from(JSON.stringify(sa), 'utf8').toString('base64');
  assert.strictEqual(parseServiceAccount().client_email, sa.client_email);

  delete process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON;
  assert.strictEqual(getSheetsCredentialStatus().ready, false);

  const msg = formatGoogleSheetsApiError(
    { code: 403, message: 'The caller does not have permission' },
    { clientEmail: sa.client_email }
  );
  assert.ok(msg.includes('403'));
  assert.ok(msg.includes(sa.client_email));

  if (prev === undefined) delete process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON;
  else process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON = prev;
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

// EJ1201-16001: FC inventory layout (Date meta row + Inventory header) must read 955
{
  const { parseInventorySheetValues, findHeaderRow } = require('../utils/googleSheetsInventory');

  const values = [
    ['', 'Date', '15/07/2026'],
    ['id', 'sku_code', 'Inventory'],
    [21591169, 'EJ1201-16001', 955],
    [1, 'SKD74-ARCHI-CHERRY_S', 40],
    [2, 'OTHER-SKU', 0],
  ];
  assert.strictEqual(findHeaderRow(values).index, 1);

  const parsed = parseInventorySheetValues(values, { preferColumnC: true, blankAsZero: true });
  assert.strictEqual(parsed.meta.columnReason, 'column_c_inventory');
  assert.strictEqual(parsed.meta.inventoryColumnIndex, 2);

  const ej = parsed.rows.find((r) => r.internalSku === 'EJ1201-16001');
  assert.ok(ej, 'EJ1201-16001 must be found');
  assert.strictEqual(ej.quantity, 955);

  const demand = buildSkuDemand([{
    id: 'C1',
    status: 'pending',
    criticalityLevel: 'critical',
    skus: [{ internalSku: 'ej1201-16001', requiredQty: 365, packedQty: 0 }],
  }]);
  const rows = applyStockToDemand(demand, {
    'EJ1201-16001': { quantity: ej.quantity, sync_status: 'ok' },
  });
  assert.strictEqual(rows[0].latestInventory, 955);
  assert.strictEqual(rows[0].totalPlannedQty, 365);
  assert.strictEqual(rows[0].inventoryBalance, 955 - 365);
  assert.strictEqual(rows[0].totalShortage, 0);
}

// Legacy AutoFetch multi-date layout still works
{
  const { parseInventorySheetValues } = require('../utils/googleSheetsInventory');
  const values = [
    ['id', 'sku_code', '15/07/2026', '14/07/2026'],
    ['', '', 'Inventory', 'Inventory'],
    [1, 'SKU-A', 12, 99],
  ];
  const parsed = parseInventorySheetValues(values, { preferColumnC: true });
  assert.strictEqual(parsed.rows[0].quantity, 12);
}

// Explicit sheet Col C = 0 is kept (not a stale DB value)
{
  assert.strictEqual(normalizeSkuKey('ej1201-16001'), 'EJ1201-16001');
  const demand = buildSkuDemand([{
    id: 'C1',
    status: 'pending',
    criticalityLevel: 'critical',
    skus: [{ internalSku: 'ej1201-16001', requiredQty: 100, packedQty: 0 }],
  }]);
  const rows = applyStockToDemand(demand, {
    'EJ1201-16001': { quantity: 0, sync_status: 'ok' },
  });
  assert.strictEqual(rows[0].latestInventory, 0);
  assert.strictEqual(rows[0].inventoryBalance, -100);
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

// Prefer tabs that actually contain stock over empty AutoFetch catalogues
{
  const { parseInventorySheetValues } = require('../utils/googleSheetsInventory');
  // Re-require score via parse + compare
  const empty = parseInventorySheetValues([
    ['id', 'sku_code', 'Inventory'],
    [1, 'A', 0],
    [2, 'B', null],
  ]);
  const stocked = parseInventorySheetValues([
    ['', 'Date', '15/07/2026'],
    ['id', 'sku_code', 'Inventory'],
    [21591169, 'EJ1201-16001', 955],
    [1, 'OTHER', 10],
  ]);
  assert.ok((stocked.meta.positiveQtyCount || 0) > (empty.meta.positiveQtyCount || 0));
  assert.strictEqual(
    stocked.rows.find((r) => r.internalSku === 'EJ1201-16001').quantity,
    955
  );
}

// Batched sheet read settings (2000 + pause)
{
  const { isDailySyncSlot, getZonedDateParts, DEFAULT_INVENTORY_SETTINGS } = require('../utils/inventorySettings');
  assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.syncHourLocal, 10);
  assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.syncMinuteLocal, 30);
  assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.sheetFetchBatchSize, 2000);
  assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.sheetFetchPauseMs, 2000);
  const parts = getZonedDateParts(new Date('2026-07-15T05:00:00.000Z'), 'Asia/Kolkata');
  // 05:00 UTC = 10:30 IST is wrong - 05:00 UTC = 10:30 IST yes: IST = UTC+5:30 so 05:00 UTC = 10:30 IST
  assert.strictEqual(parts.hour, 10);
  assert.strictEqual(parts.minute, 30);
  assert.strictEqual(
    isDailySyncSlot({ syncTimezone: 'Asia/Kolkata', syncHourLocal: 10, syncMinuteLocal: 30 }, new Date('2026-07-15T05:00:00.000Z')),
    true
  );
  assert.strictEqual(
    isDailySyncSlot({ syncTimezone: 'Asia/Kolkata', syncHourLocal: 10, syncMinuteLocal: 30 }, new Date('2026-07-15T05:01:00.000Z')),
    false
  );
}

console.log('Inventory planning tests passed.');


