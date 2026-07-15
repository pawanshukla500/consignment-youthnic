/**
 * Inventory planning email HTML + helpers — full team report.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function metric(label, value, color = '#0f766e') {
  return `
    <td style="padding:10px 12px;border:1px solid #e2e8f0;background:#f8fafc;text-align:center;min-width:110px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748b">${escapeHtml(label)}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin-top:4px">${escapeHtml(value)}</div>
    </td>`;
}

function statusColor(status) {
  if (String(status).includes('Critical')) return '#b91c1c';
  if (String(status).includes('Urgent')) return '#c2410c';
  if (String(status).includes('Low')) return '#b45309';
  if (String(status).includes('Missing') || String(status).includes('Failed')) return '#64748b';
  return '#047857';
}

function skuTableRows(rows) {
  return (rows || []).map((r) => `
    <tr>
      <td style="padding:8px;border:1px solid #e2e8f0;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(r.internalSku)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px;color:${statusColor(r.inventoryStatus)};font-weight:600">${escapeHtml(r.inventoryStatus)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px">${escapeHtml(r.totalPlannedQty)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:11px">${escapeHtml(r.criticalQty || 0)} / ${escapeHtml(r.urgentQty || 0)} / ${escapeHtml(r.normalQty || 0)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px">${r.latestInventory == null ? '—' : escapeHtml(r.latestInventory)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px;font-weight:600;color:${(r.inventoryBalance ?? 0) < 0 ? '#b91c1c' : '#047857'}">${r.inventoryBalance == null ? '—' : escapeHtml(r.inventoryBalance)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px;color:#b91c1c;font-weight:600">${escapeHtml(r.totalShortage)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px;font-weight:600">${escapeHtml(r.suggestedProductionQty)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px">${escapeHtml(r.activeConsignmentCount || (r.consignmentIds || []).length)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:11px">${escapeHtml((r.consignmentIds || []).join(', '))}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px">${escapeHtml(r.recommendedAction)}</td>
    </tr>`).join('');
}

function buildSkuTable(title, rows) {
  if (!rows?.length) {
    return `<h2 style="font-size:16px;margin:18px 0 8px">${escapeHtml(title)}</h2>
      <p style="color:#047857;margin:0 0 12px">None in this report.</p>`;
  }
  return `
    <h2 style="font-size:16px;margin:18px 0 8px">${escapeHtml(title)} (${rows.length})</h2>
    <table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:12px">
      <thead>
        <tr style="background:#0f766e;color:#fff">
          <th style="padding:8px;text-align:left">Internal SKU</th>
          <th style="padding:8px;text-align:left">Status</th>
          <th style="padding:8px;text-align:right">Planned</th>
          <th style="padding:8px;text-align:right">Crit/Urg/Norm</th>
          <th style="padding:8px;text-align:right">Available (Col C)</th>
          <th style="padding:8px;text-align:right">Avail − Planned</th>
          <th style="padding:8px;text-align:right">Shortage</th>
          <th style="padding:8px;text-align:right">Produce</th>
          <th style="padding:8px;text-align:right"># Cons.</th>
          <th style="padding:8px;text-align:left">Consignments</th>
          <th style="padding:8px;text-align:left">Action</th>
        </tr>
      </thead>
      <tbody>${skuTableRows(rows)}</tbody>
    </table>`;
}

function buildInventoryPlanningEmail({ report, dashboardUrl, subject }) {
  const summary = report.summary || {};
  const syncMeta = report.syncMeta || {};
  const allSkus = report.skus || [];
  const criticalUrgent = report.criticalUrgentSkus || allSkus.filter((s) =>
    s.inventoryStatus === 'Critical Shortage' ||
    s.inventoryStatus === 'Urgent Production Required' ||
    (s.criticalShortage || 0) > 0 ||
    (s.urgentShortage || 0) > 0
  );
  const shortages = allSkus
    .filter((s) => (s.totalShortage || 0) > 0)
    .sort((a, b) => (b.totalShortage || 0) - (a.totalShortage || 0));
  const contended = allSkus
    .filter((s) => (s.activeConsignmentCount || 0) > 1)
    .sort((a, b) => (b.activeConsignmentCount || 0) - (a.activeConsignmentCount || 0) || (b.totalShortage || 0) - (a.totalShortage || 0));
  const missing = allSkus.filter((s) =>
    s.inventoryStatus === 'Inventory Data Missing' || s.inventoryStatus === 'Sheet Sync Failed'
  );

  const sheetName = syncMeta?.latestRun?.details?.fetchMeta?.sheetName
    || syncMeta?.sheetName
    || summary.inventorySheetName
    || 'Google Sheet';

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:1100px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#0f766e;color:#fff;padding:20px 24px">
        <div style="font-size:13px;opacity:.85">Youthnic Packing Station · Inventory Planning</div>
        <h1 style="margin:6px 0 0;font-size:22px">${escapeHtml(subject)}</h1>
      </div>
      <div style="padding:20px 24px">
        <p style="margin:0 0 16px;color:#334155;line-height:1.55">
          Full production planning report from open consignments (created / planned / under packing, not fully packed)
          compared with available inventory from Google Sheet Column C (Internal SKU / sku_code).
          Allocation order when stock is limited: <strong>Critical → Urgent → Normal</strong>.
          Negative <em>Avail − Planned</em> means production is required before those consignments can finish.
        </p>

        <table style="border-collapse:collapse;width:100%;margin-bottom:12px"><tr>
          ${metric('Report time', new Date(summary.generatedAt || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ' IST')}
          ${metric('Sheet sync', summary.sheetSyncStatus || '—')}
          ${metric('Sheet tab', sheetName)}
          ${metric('Active consignments', summary.activeConsignmentCount)}
        </tr></table>
        <table style="border-collapse:collapse;width:100%;margin-bottom:12px"><tr>
          ${metric('SKUs reviewed', summary.totalSkusReviewed)}
          ${metric('Planned qty', summary.totalPlannedQty)}
          ${metric('Available (Col C)', summary.totalAvailableInventory)}
          ${metric('Total shortage', summary.totalShortageQty, '#b91c1c')}
        </tr></table>
        <table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr>
          ${metric('Critical SKUs', summary.criticalShortageSkuCount, '#b91c1c')}
          ${metric('Urgent SKUs', summary.urgentSkuCount, '#c2410c')}
          ${metric('Suggested production', summary.totalSuggestedProductionQty, '#b91c1c')}
          ${metric('Earliest ship/appt', summary.earliestShipmentOrAppointmentDate || '—')}
        </tr></table>
        <table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr>
          ${metric('Sufficient', summary.sufficientSkuCount, '#047857')}
          ${metric('Low inventory', summary.lowInventorySkuCount, '#b45309')}
          ${metric('Missing / sync fail', (summary.missingInventorySkuCount || 0) + (summary.syncFailedSkuCount || 0), '#64748b')}
          ${metric('Shared SKUs (2+ cons)', contended.length, contended.length ? '#b45309' : '#047857')}
        </tr></table>

        ${buildSkuTable('Critical & urgent SKUs (act first)', criticalUrgent.slice(0, 80))}
        ${buildSkuTable('Top shortages by quantity', shortages.slice(0, 60))}
        ${buildSkuTable('SKUs shared across multiple open consignments', contended.slice(0, 40))}
        ${missing.length ? buildSkuTable('Missing inventory / sheet sync issues', missing.slice(0, 30)) : ''}

        <p style="margin:16px 0 8px;color:#334155;font-size:13px">
          Full SKU-wise detail, consignments, and sync logs are in the attached Excel workbook.
          Last inventory sync: ${escapeHtml(summary.lastInventorySyncAt || '—')}.
        </p>
        <p style="margin:0">
          <a href="${escapeHtml(dashboardUrl)}"
             style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">
            Open Inventory Planning
          </a>
        </p>
      </div>
    </div>
  </div>
</body></html>`;

  const text = [
    subject,
    `Generated (IST): ${new Date(summary.generatedAt || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })}`,
    `Sheet sync: ${summary.sheetSyncStatus}`,
    `Sheet tab: ${sheetName}`,
    `Active consignments: ${summary.activeConsignmentCount}`,
    `SKUs reviewed: ${summary.totalSkusReviewed}`,
    `Planned: ${summary.totalPlannedQty} | Available: ${summary.totalAvailableInventory} | Shortage: ${summary.totalShortageQty}`,
    `Critical: ${summary.criticalShortageSkuCount} | Urgent: ${summary.urgentSkuCount} | Produce: ${summary.totalSuggestedProductionQty}`,
    `Shared SKUs (2+ consignments): ${contended.length}`,
    `Dashboard: ${dashboardUrl}`,
    '',
    '--- Critical & urgent ---',
    ...criticalUrgent.slice(0, 80).map((r) =>
      `${r.internalSku} | ${r.inventoryStatus} | planned=${r.totalPlannedQty} avail=${r.latestInventory ?? 'n/a'} bal=${r.inventoryBalance ?? 'n/a'} shortage=${r.totalShortage} | ${(r.consignmentIds || []).join(',')}`
    ),
    '',
    '--- Top shortages ---',
    ...shortages.slice(0, 40).map((r) =>
      `${r.internalSku} | shortage=${r.totalShortage} | produce=${r.suggestedProductionQty}`
    ),
  ].join('\n');

  return { html, text };
}

module.exports = {
  buildInventoryPlanningEmail,
  escapeHtml,
};
