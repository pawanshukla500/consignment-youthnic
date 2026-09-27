/**
 * Inventory planning email — branded executive summary body (website theme).
 * SKU-level line-item detail belongs in the Excel attachment, not the HTML body.
 * Logo uses the shared Login-style frosted mark via emailShell / CID.
 */

const { emailShell, escapeHtml, getAppUrl } = require('./emailTemplates');

function fmtQty(val) {
  if (val === null || val === undefined || val === '') return '0';
  const num = Number(val);
  if (Number.isNaN(num)) return escapeHtml(String(val));
  return num.toLocaleString('en-IN');
}

function summaryRow(label, value, valueColor = '#0f172a') {
  return `
    <tr>
      <td style="padding:10px 12px;font-size:12.5px;color:#64748b;width:52%;vertical-align:top;border-bottom:1px solid #f1f5f9">${escapeHtml(label)}</td>
      <td style="padding:10px 12px;font-size:13.5px;color:${valueColor};font-weight:700;vertical-align:top;border-bottom:1px solid #f1f5f9;text-align:right">${value}</td>
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

  const bannerBg = (critical > 0 || shortageQty > 0) ? '#FFF1F2' : '#ECFDF5';
  const bannerBorder = (critical > 0 || shortageQty > 0) ? '#FECDD3' : '#A7F3D0';
  const bannerAccent = (critical > 0 || shortageQty > 0) ? '#E11D48' : '#059669';
  const bannerTitleColor = (critical > 0 || shortageQty > 0) ? '#9F1239' : '#065F46';
  const bannerTitle = (critical > 0 || shortageQty > 0) ? 'Action Required · Shortage Alert' : 'Inventory Optimal · All Covered';

  const bodyHtml = `
    <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.4px;font-family:'Plus Jakarta Sans',Inter,'Segoe UI',Arial,sans-serif">
      ${escapeHtml(subject)}
    </p>
    <p style="margin:0 0 18px;font-size:13.5px;color:#64748b;line-height:1.6">
      Executive inventory planning summary comparing active consignment requirements with Google Sheet Column C stock.<br>
      Allocation priority when stock is limited: <strong style="color:#0f172a">Critical (0–2d) &rarr; Urgent (3–4d) &rarr; Normal (5+d)</strong>.
    </p>

    <!-- Action Banner -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:${bannerBg};border:1px solid ${bannerBorder};border-left:4px solid ${bannerAccent};border-radius:12px;margin:0 0 20px">
      <tr><td style="padding:16px 18px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${bannerAccent}">
          ${bannerTitle}
        </p>
        <p style="margin:0;font-size:14px;color:${bannerTitleColor};line-height:1.55;font-weight:700">
          ${escapeHtml(highlightLine)}
        </p>
      </td></tr>
    </table>

    <!-- Quick KPI Stat Cards (2x2 Grid) -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 22px">
      <tr>
        <td width="25%" style="padding:4px;vertical-align:top">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
            style="background:#FFF1F2;border:1px solid #FECDD3;border-radius:12px;text-align:center">
            <tr><td style="padding:14px 8px">
              <div style="font-size:10px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#9F1239">Total Shortage</div>
              <div style="font-size:22px;font-weight:800;color:${shortageQty > 0 ? '#E11D48' : '#059669'};margin-top:4px;line-height:1.1">
                ${fmtQty(shortageQty)}<!-- ${shortageQty} -->
              </div>
              <div style="font-size:10px;color:#BE123C;margin-top:4px">units short</div>
            </td></tr>
          </table>
        </td>
        <td width="25%" style="padding:4px;vertical-align:top">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
            style="background:#FFF1F2;border:1px solid #FECDD3;border-radius:12px;text-align:center">
            <tr><td style="padding:14px 8px">
              <div style="font-size:10px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#9F1239">Critical SKUs</div>
              <div style="font-size:22px;font-weight:800;color:${critical > 0 ? '#E11D48' : '#0F172A'};margin-top:4px;line-height:1.1">
                ${fmtQty(critical)}<!-- ${critical} -->
              </div>
              <div style="font-size:10px;color:#BE123C;margin-top:4px">0–2d dispatch</div>
            </td></tr>
          </table>
        </td>
        <td width="25%" style="padding:4px;vertical-align:top">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
            style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;text-align:center">
            <tr><td style="padding:14px 8px">
              <div style="font-size:10px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#92400E">Urgent SKUs</div>
              <div style="font-size:22px;font-weight:800;color:${urgent > 0 ? '#D97706' : '#0F172A'};margin-top:4px;line-height:1.1">
                ${fmtQty(urgent)}<!-- ${urgent} -->
              </div>
              <div style="font-size:10px;color:#B45309;margin-top:4px">3–4d dispatch</div>
            </td></tr>
          </table>
        </td>
        <td width="25%" style="padding:4px;vertical-align:top">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
            style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;text-align:center">
            <tr><td style="padding:14px 8px">
              <div style="font-size:10px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:#475569">Suggested Qty</div>
              <div style="font-size:22px;font-weight:800;color:${produceQty > 0 ? '#E11D48' : '#059669'};margin-top:4px;line-height:1.1">
                ${fmtQty(produceQty)}<!-- ${produceQty} -->
              </div>
              <div style="font-size:10px;color:#64748B;margin-top:4px">to produce</div>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Group 1: Inventory Coverage & Scope -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#ffffff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;margin:0 0 18px">
      <tr>
        <td style="padding:14px 16px;background:#F8FAFC;border-bottom:1px solid #E2E8F0">
          <span style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#475569">
            Inventory Coverage &amp; SKU Scope
          </span>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 16px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            ${summaryRow('Active Consignments', fmtQty(summary.activeConsignmentCount))}
            ${summaryRow('Unique SKUs Reviewed', fmtQty(summary.totalSkusReviewed))}
            ${summaryRow('Total Planned Quantity', fmtQty(summary.totalPlannedQty))}
            ${summaryRow('Total Available Inventory (Col C)', fmtQty(summary.totalAvailableInventory))}
            ${summaryRow('Sufficient Stock SKUs', fmtQty(summary.sufficientSkuCount ?? 0), '#059669')}
            ${summaryRow('Low Inventory SKUs', fmtQty(summary.lowInventorySkuCount ?? 0), '#B45309')}
            ${summaryRow('Missing / Sync-Fail SKUs', fmtQty(missingFail), missingFail > 0 ? '#64748B' : '#0F172A')}
            ${summaryRow('SKUs Shared Across 2+ Consignments', fmtQty(sharedSkuCount), sharedSkuCount > 0 ? '#B45309' : '#059669')}
          </table>
        </td>
      </tr>
    </table>

    <!-- Group 2: Data Sync & Timelines -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#ffffff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;margin:0 0 20px">
      <tr>
        <td style="padding:14px 16px;background:#F8FAFC;border-bottom:1px solid #E2E8F0">
          <span style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#475569">
            Data Sync &amp; Operations Timeline
          </span>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 16px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            ${summaryRow('Google Sheet Sync Status', escapeHtml(summary.sheetSyncStatus || '—'))}
            ${summaryRow('Google Sheet Tab', escapeHtml(sheetName))}
            ${summaryRow('Last Inventory Sync', formatIst(summary.lastInventorySyncAt))}
            ${summaryRow('Earliest Target Dispatch / Appointment', escapeHtml(summary.earliestShipmentOrAppointmentDate || '—'))}
            ${summaryRow('Report Generation Time', formatIst(summary.generatedAt || Date.now()))}
          </table>
        </td>
      </tr>
    </table>

    <!-- Attached Excel Workbook Callout -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;margin:0 0 22px">
      <tr><td style="padding:16px 20px">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td width="38" valign="top" style="padding-right:14px">
              <div style="width:36px;height:36px;border-radius:10px;background:#15803D;text-align:center;line-height:36px;color:#ffffff;font-weight:800;font-size:12px;letter-spacing:0.5px">
                XLS
              </div>
            </td>
            <td valign="top">
              <div style="font-size:13.5px;font-weight:700;color:#166534;margin-bottom:3px">
                Full SKU line-item detail is in the attached Excel workbook
              </div>
              <div style="font-size:12.5px;color:#15803D;line-height:1.55">
                Open the attached <strong>Inventory_Planning_*.xlsx</strong> workbook for item-by-item breakdown:
                planned vs available qty, shortage, suggested production, and affected consignments.
              </div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- Primary CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 8px">
      <tr><td align="center">
        <a href="${escapeHtml(appUrl)}"
          style="display:inline-block;background:#E11D48;background-image:linear-gradient(135deg,#E11D48 0%,#BE123C 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 34px;border-radius:10px;box-shadow:0 2px 6px rgba(225,29,72,0.22)">
          Open Inventory Planning Station &rarr;
        </a>
      </td></tr>
    </table>`;

  const html = emailShell({
    title: subject,
    preheader: highlights.length
      ? `${highlights.join(' · ')}. Details in Excel attachment.`
      : 'Inventory planning summary — details in Excel attachment.',
    bodyHtml,
    accent: '#6A040F',
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
