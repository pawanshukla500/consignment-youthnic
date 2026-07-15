/**
 * Inventory planning email — branded summary body only.
 * SKU-level detail belongs in the Excel attachment, not the HTML body.
 * Logo is rendered via emailShell → cid:email-logo.png (Mailgun always inlines it).
 */

const { emailShell, escapeHtml, getAppUrl } = require('./emailTemplates');

function summaryRow(label, value, valueColor = '#0f172a') {
  return `
    <tr>
      <td style="padding:10px 0;font-size:13px;color:#64748b;width:52%;vertical-align:top;border-bottom:1px solid #f1f5f9">${escapeHtml(label)}</td>
      <td style="padding:10px 0;font-size:14px;color:${valueColor};font-weight:700;vertical-align:top;border-bottom:1px solid #f1f5f9;text-align:right">${value}</td>
    </tr>`;
}

function formatIst(value) {
  if (!value) return '—';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(value));
    return escapeHtml(
      `${d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST`
    );
  } catch {
    return escapeHtml(String(value));
  }
}

function buildInventoryPlanningEmail({ report, dashboardUrl, subject }) {
  const summary = report.summary || {};
  const syncMeta = report.syncMeta || {};
  const allSkus = report.skus || [];
  const sharedSkuCount = allSkus.filter((s) => (s.activeConsignmentCount || 0) > 1).length;

  const sheetName = syncMeta?.latestRun?.details?.fetchMeta?.sheetName
    || syncMeta?.sheetName
    || summary.inventorySheetName
    || 'Google Sheet';

  const critical = Number(summary.criticalShortageSkuCount || 0);
  const urgent = Number(summary.urgentSkuCount || 0);
  const shortageQty = Number(summary.totalShortageQty || 0);
  const produceQty = Number(summary.totalSuggestedProductionQty || 0);
  const missingFail = Number(summary.missingInventorySkuCount || 0)
    + Number(summary.syncFailedSkuCount || 0);

  const highlights = [];
  if (critical > 0) highlights.push(`${critical} critical SKU${critical === 1 ? '' : 's'}`);
  if (urgent > 0) highlights.push(`${urgent} urgent SKU${urgent === 1 ? '' : 's'}`);
  if (shortageQty > 0) highlights.push(`${shortageQty} units short`);
  const highlightLine = highlights.length
    ? `Action needed: ${highlights.join(' · ')}. Open the attached Excel workbook for SKU-level detail.`
    : 'No critical or urgent shortages in this report. Full SKU detail is in the attached Excel workbook.';

  const appUrl = dashboardUrl || `${getAppUrl()}/inventory-planning`;

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px">
      ${escapeHtml(subject)}
    </p>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;line-height:1.65">
      High-level inventory planning summary from open consignments compared with Google Sheet Column C.
      Allocation when stock is limited: <strong>Critical → Urgent → Normal</strong>.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;margin:0 0 22px">
      <tr><td style="padding:16px 18px">
        <p style="margin:0;font-size:14px;color:#0f766e;line-height:1.55;font-weight:600">
          ${escapeHtml(highlightLine)}
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8">
      Report summary
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 8px">
      ${summaryRow('Report generation time', formatIst(summary.generatedAt || Date.now()))}
      ${summaryRow('Sheet sync status', escapeHtml(summary.sheetSyncStatus || '—'))}
      ${summaryRow('Sheet tab', escapeHtml(sheetName))}
      ${summaryRow('Last inventory sync', formatIst(summary.lastInventorySyncAt))}
      ${summaryRow('Active consignments', escapeHtml(summary.activeConsignmentCount ?? '—'))}
      ${summaryRow('Unique SKUs reviewed', escapeHtml(summary.totalSkusReviewed ?? '—'))}
      ${summaryRow('Total planned quantity', escapeHtml(summary.totalPlannedQty ?? '—'))}
      ${summaryRow('Total available (Col C)', escapeHtml(summary.totalAvailableInventory ?? '—'))}
      ${summaryRow('Total shortage', escapeHtml(shortageQty), shortageQty > 0 ? '#b91c1c' : '#047857')}
      ${summaryRow('Suggested production qty', escapeHtml(produceQty), produceQty > 0 ? '#b91c1c' : '#047857')}
      ${summaryRow('Critical SKU count', escapeHtml(critical), critical > 0 ? '#b91c1c' : '#0f172a')}
      ${summaryRow('Urgent SKU count', escapeHtml(urgent), urgent > 0 ? '#c2410c' : '#0f172a')}
      ${summaryRow('Low inventory SKU count', escapeHtml(summary.lowInventorySkuCount ?? 0), '#b45309')}
      ${summaryRow('Sufficient SKU count', escapeHtml(summary.sufficientSkuCount ?? 0), '#047857')}
      ${summaryRow('Missing / sync-fail SKUs', escapeHtml(missingFail), missingFail > 0 ? '#64748b' : '#0f172a')}
      ${summaryRow('SKUs shared across 2+ consignments', escapeHtml(sharedSkuCount), sharedSkuCount > 0 ? '#b45309' : '#047857')}
      ${summaryRow('Earliest shipment / appointment', escapeHtml(summary.earliestShipmentOrAppointmentDate || '—'))}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;margin:20px 0 8px">
      <tr><td style="padding:14px 18px">
        <p style="margin:0;font-size:13px;color:#9a3412;line-height:1.55">
          <strong>SKU lists are not included in this email.</strong>
          Open the attached <em>Inventory_Planning_*.xlsx</em> workbook for full line-item detail:
          planned vs available qty, shortage, suggested production, and consignments.
        </p>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 8px">
      <tr><td align="center">
        <a href="${escapeHtml(appUrl)}"
          style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:10px">
          Open Inventory Planning
        </a>
      </td></tr>
    </table>`;

  const html = emailShell({
    title: subject,
    preheader: highlights.length
      ? `${highlights.join(' · ')}. Details in Excel attachment.`
      : 'Inventory planning summary — details in Excel attachment.',
    bodyHtml,
    accent: '#0f766e',
  });

  const text = [
    subject,
    '',
    highlightLine,
    '',
    `Report time (IST): ${new Date(summary.generatedAt || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })}`,
    `Sheet sync: ${summary.sheetSyncStatus || '—'}`,
    `Sheet tab: ${sheetName}`,
    `Last sync: ${summary.lastInventorySyncAt || '—'}`,
    `Active consignments: ${summary.activeConsignmentCount ?? '—'}`,
    `SKUs reviewed: ${summary.totalSkusReviewed ?? '—'}`,
    `Planned: ${summary.totalPlannedQty ?? '—'} | Available: ${summary.totalAvailableInventory ?? '—'} | Shortage: ${shortageQty}`,
    `Critical: ${critical} | Urgent: ${urgent} | Produce: ${produceQty}`,
    `Low: ${summary.lowInventorySkuCount ?? 0} | Sufficient: ${summary.sufficientSkuCount ?? 0} | Missing/fail: ${missingFail}`,
    `Shared SKUs (2+ consignments): ${sharedSkuCount}`,
    `Earliest ship/appt: ${summary.earliestShipmentOrAppointmentDate || '—'}`,
    '',
    'SKU-level detail is in the attached Excel workbook only (not listed in this email).',
    `Dashboard: ${appUrl}`,
  ].join('\n');

  return { html, text };
}

module.exports = {
  buildInventoryPlanningEmail,
  escapeHtml,
};
