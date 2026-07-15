/**
 * Inventory planning email HTML + helpers.
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

function buildInventoryPlanningEmail({ report, dashboardUrl, subject }) {
  const summary = report.summary || {};
  const criticalUrgent = report.criticalUrgentSkus || [];
  const top = criticalUrgent.slice(0, 40);

  const tableRows = top.map((r) => `
    <tr>
      <td style="padding:8px;border:1px solid #e2e8f0;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(r.internalSku)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px">${escapeHtml(r.inventoryStatus)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px">${escapeHtml(r.totalPlannedQty)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px">${r.latestInventory == null ? '—' : escapeHtml(r.latestInventory)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px;color:#b91c1c;font-weight:600">${escapeHtml(r.totalShortage)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-size:12px;font-weight:600">${escapeHtml(r.suggestedProductionQty)}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px">${escapeHtml((r.consignmentIds || []).join(', '))}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;font-size:12px">${escapeHtml(r.recommendedAction)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
  <div style="max-width:920px;margin:0 auto;padding:24px">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:#0f766e;color:#fff;padding:20px 24px">
        <div style="font-size:13px;opacity:.85">Youthnic Packing Station</div>
        <h1 style="margin:6px 0 0;font-size:22px">${escapeHtml(subject)}</h1>
      </div>
      <div style="padding:20px 24px">
        <p style="margin:0 0 16px;color:#334155;line-height:1.5">
          Inventory planning alert for production and inventory teams.
          Critical and urgent SKU requirements are based on Internal SKUs from consignments
          that are created/planned but not yet fully packed. Shortage =
          Total Planned − Available (Google Sheet Column C). Critical → Urgent → Normal allocation applies when inventory is partial.
        </p>

        <table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr>
          ${metric('Report time', new Date(summary.generatedAt || Date.now()).toLocaleString('en-GB'))}
          ${metric('Sheet sync', summary.sheetSyncStatus || summary.omsGuruSyncStatus)}
          ${metric('Active consignments', summary.activeConsignmentCount)}
          ${metric('SKUs reviewed', summary.totalSkusReviewed)}
        </tr></table>
        <table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr>
          ${metric('Sufficient', summary.sufficientSkuCount, '#047857')}
          ${metric('Low inventory', summary.lowInventorySkuCount, '#b45309')}
          ${metric('Critical shortage', summary.criticalShortageSkuCount, '#b91c1c')}
          ${metric('Suggested production', summary.totalSuggestedProductionQty, '#b91c1c')}
        </tr></table>
        <table style="border-collapse:collapse;width:100%;margin-bottom:18px"><tr>
          ${metric('Planned qty', summary.totalPlannedQty)}
          ${metric('Available inventory', summary.totalAvailableInventory)}
          ${metric('Total shortage', summary.totalShortageQty, '#b91c1c')}
          ${metric('Earliest ship/appt', summary.earliestShipmentOrAppointmentDate || '—')}
        </tr></table>

        <h2 style="font-size:16px;margin:0 0 10px">Critical &amp; urgent SKUs</h2>
        ${top.length ? `
        <table style="border-collapse:collapse;width:100%;font-size:12px">
          <thead>
            <tr style="background:#0f766e;color:#fff">
              <th style="padding:8px;text-align:left">Internal SKU</th>
              <th style="padding:8px;text-align:left">Status</th>
              <th style="padding:8px;text-align:right">Planned</th>
              <th style="padding:8px;text-align:right">Available (Col C)</th>
              <th style="padding:8px;text-align:right">Shortage</th>
              <th style="padding:8px;text-align:right">Produce</th>
              <th style="padding:8px;text-align:left">Consignments</th>
              <th style="padding:8px;text-align:left">Action</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>` : `<p style="color:#047857">No critical or urgent SKU shortages in this report.</p>`}

        <p style="margin:20px 0 8px;color:#334155">
          Open the Inventory Planning dashboard for the full SKU-wise report and downloadable XLSX.
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
    `Generated: ${summary.generatedAt}`,
    `Sheet sync: ${summary.sheetSyncStatus || summary.omsGuruSyncStatus}`,
    `Active consignments: ${summary.activeConsignmentCount}`,
    `SKUs reviewed: ${summary.totalSkusReviewed}`,
    `Critical shortages: ${summary.criticalShortageSkuCount}`,
    `Urgent SKUs: ${summary.urgentSkuCount}`,
    `Total shortage: ${summary.totalShortageQty}`,
    `Suggested production: ${summary.totalSuggestedProductionQty}`,
    `Dashboard: ${dashboardUrl}`,
    '',
    ...top.map((r) =>
      `${r.internalSku} | ${r.inventoryStatus} | planned=${r.totalPlannedQty} avail=${r.latestInventory ?? 'n/a'} shortage=${r.totalShortage} | ${(r.consignmentIds || []).join(',')}`
    ),
  ].join('\n');

  return { html, text };
}

module.exports = {
  buildInventoryPlanningEmail,
};
