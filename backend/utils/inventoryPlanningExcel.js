/**
 * Inventory planning XLSX (ExcelJS) — five worksheets.
 */

const ExcelJS = require('exceljs');

const HEADER_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF0F766E' },
};
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
};

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = THIN_BORDER;
  });
  row.height = 22;
}

function autosize(sheet, min = 10, max = 40) {
  sheet.columns.forEach((col) => {
    let width = min;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length + 2;
      if (len > width) width = Math.min(max, len);
    });
    col.width = width;
  });
}

function statusFill(status) {
  const map = {
    'Critical Shortage': 'FFFECACA',
    'Urgent Production Required': 'FFFED7AA',
    'Low Inventory': 'FEF3C7',
    'Inventory Data Missing': 'E2E8F0',
    'Sheet Sync Failed': 'FCE7F3',
    'OMSGuru Sync Failed': 'FCE7F3',
    Sufficient: 'D1FAE5',
  };
  const argb = map[status];
  if (!argb) return null;
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${argb}` } };
}

async function buildInventoryPlanningWorkbook(report, syncLogs = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Youthnic Consignment Packing';
  wb.created = new Date();

  const summary = report.summary || {};
  const skus = report.skus || [];
  const consignments = report.consignments || [];
  const criticalUrgent = report.criticalUrgentSkus || [];

  // 1. Executive Summary
  const exec = wb.addWorksheet('Executive Summary');
  exec.addRow(['Metric', 'Value']);
  styleHeader(exec.getRow(1));
  const execRows = [
    ['Report generation time', summary.generatedAt],
    ['Sheet sync status', summary.sheetSyncStatus || summary.omsGuruSyncStatus],
    ['Last inventory sync', summary.lastInventorySyncAt],
    ['Total active consignments', summary.activeConsignmentCount],
    ['Total unique SKUs', summary.totalSkusReviewed],
    ['Total planned quantity', summary.totalPlannedQty],
    ['Total available inventory', summary.totalAvailableInventory],
    ['Total shortage', summary.totalShortageQty],
    ['Total suggested production quantity', summary.totalSuggestedProductionQty],
    ['Critical SKU count', summary.criticalShortageSkuCount],
    ['Urgent SKU count', summary.urgentSkuCount],
    ['Low-inventory SKU count', summary.lowInventorySkuCount],
    ['Sufficient SKU count', summary.sufficientSkuCount],
    ['Missing inventory SKU count', summary.missingInventorySkuCount],
    ['Sync-failed SKU count', summary.syncFailedSkuCount],
    ['Earliest shipment / appointment', summary.earliestShipmentOrAppointmentDate],
  ];
  execRows.forEach((r) => exec.addRow(r));
  autosize(exec, 18, 48);
  exec.views = [{ state: 'frozen', ySplit: 1 }];

  // 2. SKU Planning
  const skuSheet = wb.addWorksheet('SKU Planning');
  const skuHeaders = [
    'Internal SKU',
    'Product name',
    'Marketplace',
    'Active consignments',
    'Consignment IDs',
    'Total planned qty',
    'Critical qty',
    'Urgent qty',
    'Normal qty',
    'Latest sheet inventory',
    'Allocated critical',
    'Allocated urgent',
    'Allocated normal',
    'Critical shortage',
    'Urgent shortage',
    'Normal shortage',
    'Total shortage',
    'Suggested production qty',
    'Earliest appointment/shipment',
    'Warehouse TAT (days)',
    'Last inventory sync',
    'Inventory status',
    'Recommended action',
  ];
  skuSheet.addRow(skuHeaders);
  styleHeader(skuSheet.getRow(1));
  for (const row of skus) {
    const r = skuSheet.addRow([
      row.internalSku,
      row.productName,
      row.marketplace,
      row.activeConsignmentCount,
      (row.consignmentIds || []).join(', '),
      row.totalPlannedQty,
      row.criticalQty,
      row.urgentQty,
      row.normalQty,
      row.latestInventory,
      row.inventoryAllocatedCritical,
      row.inventoryAllocatedUrgent,
      row.inventoryAllocatedNormal,
      row.criticalShortage,
      row.urgentShortage,
      row.normalShortage,
      row.totalShortage,
      row.suggestedProductionQty,
      row.earliestShipmentDate || row.earliestAppointmentDate,
      row.warehouseTatDays,
      row.lastInventorySyncAt,
      row.inventoryStatus,
      row.recommendedAction,
    ]);
    const fill = statusFill(row.inventoryStatus);
    if (fill) r.getCell(22).fill = fill;
  }
  // Totals
  if (skus.length) {
    const t = skuSheet.addRow([
      'TOTALS',
      '',
      '',
      '',
      '',
      summary.totalPlannedQty,
      skus.reduce((s, r) => s + (r.criticalQty || 0), 0),
      skus.reduce((s, r) => s + (r.urgentQty || 0), 0),
      skus.reduce((s, r) => s + (r.normalQty || 0), 0),
      summary.totalAvailableInventory,
      '',
      '',
      '',
      skus.reduce((s, r) => s + (r.criticalShortage || 0), 0),
      skus.reduce((s, r) => s + (r.urgentShortage || 0), 0),
      skus.reduce((s, r) => s + (r.normalShortage || 0), 0),
      summary.totalShortageQty,
      summary.totalSuggestedProductionQty,
    ]);
    t.font = { bold: true };
  }
  skuSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: skuHeaders.length } };
  skuSheet.views = [{ state: 'frozen', ySplit: 1 }];
  autosize(skuSheet);

  // 3. Consignment Details
  const cSheet = wb.addWorksheet('Consignment Details');
  const cHeaders = [
    'Consignment ID',
    'Consignment status',
    'Shipment status',
    'Internal SKU',
    'Planned quantity',
    'Priority',
    'Appointment date',
    'Shipping deadline',
    'Warehouse TAT',
    'Packing progress %',
    'Available inventory',
    'Shortage',
    'Inventory status',
    'Recommended action',
  ];
  cSheet.addRow(cHeaders);
  styleHeader(cSheet.getRow(1));
  for (const row of consignments) {
    cSheet.addRow([
      row.consignmentId,
      row.status,
      row.shipmentStatus,
      row.internalSku,
      row.plannedQty,
      row.priorityBucket || row.criticalityLevel,
      row.appointmentDate,
      row.shippingDeadline,
      row.warehouseTatDays,
      row.packingProgress,
      row.availableInventory,
      row.shortage,
      row.inventoryStatus,
      row.recommendedAction,
    ]);
  }
  cSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cHeaders.length } };
  cSheet.views = [{ state: 'frozen', ySplit: 1 }];
  autosize(cSheet);

  // 4. Critical and Urgent SKUs
  const cu = wb.addWorksheet('Critical and Urgent SKUs');
  cu.addRow(skuHeaders);
  styleHeader(cu.getRow(1));
  for (const row of criticalUrgent) {
    const r = cu.addRow([
      row.internalSku,
      row.productName,
      row.marketplace,
      row.activeConsignmentCount,
      (row.consignmentIds || []).join(', '),
      row.totalPlannedQty,
      row.criticalQty,
      row.urgentQty,
      row.normalQty,
      row.latestInventory,
      row.inventoryAllocatedCritical,
      row.inventoryAllocatedUrgent,
      row.inventoryAllocatedNormal,
      row.criticalShortage,
      row.urgentShortage,
      row.normalShortage,
      row.totalShortage,
      row.suggestedProductionQty,
      row.earliestShipmentDate || row.earliestAppointmentDate,
      row.warehouseTatDays,
      row.lastInventorySyncAt,
      row.inventoryStatus,
      row.recommendedAction,
    ]);
    const fill = statusFill(row.inventoryStatus);
    if (fill) r.getCell(22).fill = fill;
  }
  cu.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: skuHeaders.length } };
  cu.views = [{ state: 'frozen', ySplit: 1 }];
  autosize(cu);

  // 5. Inventory Sync Log
  const logSheet = wb.addWorksheet('Inventory Sync Log');
  const logHeaders = [
    'Internal SKU',
    'Sheet quantity',
    'Previous quantity',
    'Quantity change',
    'Sync status',
    'Last successful sync time',
    'Error message',
  ];
  logSheet.addRow(logHeaders);
  styleHeader(logSheet.getRow(1));
  for (const row of syncLogs) {
    logSheet.addRow([
      row.internal_sku || row.internalSku,
      row.omsguru_quantity ?? row.omsguruQuantity,
      row.previous_quantity ?? row.previousQuantity,
      row.quantity_change ?? row.quantityChange,
      row.sync_status || row.syncStatus,
      row.run_started_at || row.last_success_at || row.created_at,
      row.error_message || row.errorMessage || '',
    ]);
  }
  logSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: logHeaders.length } };
  logSheet.views = [{ state: 'frozen', ySplit: 1 }];
  autosize(logSheet);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = {
  buildInventoryPlanningWorkbook,
};
