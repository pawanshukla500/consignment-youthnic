/**
 * Branded HTML email templates — Consignment Packing App / Youthnic
 * Full-page table layouts + logo (CID inline preferred, absolute URL fallback).
 */
const path = require('path');
const fs = require('fs');

const APP_NAME = 'Consignment Packing App';
const BRAND = 'Youthnic Packing Station';
const LOGO_CID = 'email-logo.png';
const LOGO_FILE = path.join(__dirname, '..', 'assets', 'email-logo.png');

function getAppUrl() {
  return (process.env.APP_URL || 'https://consignment.youthnic.shop').replace(/\/$/, '');
}

function getLogoHttpUrl() {
  if (process.env.EMAIL_LOGO_URL) return String(process.env.EMAIL_LOGO_URL).trim();
  if (process.env.PUBLIC_API_URL) {
    return `${String(process.env.PUBLIC_API_URL).replace(/\/$/, '')}/brand-logo.png`;
  }
  // Local API serves /brand-logo.png even when APP_URL points at Vite
  if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 5000;
    return `http://localhost:${port}/brand-logo.png`;
  }
  return `${getAppUrl()}/brand-logo.png`;
}

function getLogoFilePath() {
  if (fs.existsSync(LOGO_FILE)) return LOGO_FILE;
  const alt = path.join(__dirname, '..', '..', 'frontend', 'public', 'brand-logo.png');
  if (fs.existsSync(alt)) return alt;
  return null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(value));
    return escapeHtml(d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  } catch {
    return escapeHtml(String(value));
  }
}

function detailRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 0;font-size:12px;color:#64748b;width:38%;vertical-align:top;border-bottom:1px solid #f1f5f9">${escapeHtml(label)}</td>
      <td style="padding:8px 0;font-size:13px;color:#0f172a;font-weight:600;vertical-align:top;border-bottom:1px solid #f1f5f9">${value}</td>
    </tr>`;
}

function logoBlock(httpUrl) {
  // Prefer absolute HTTPS URL (works in Gmail/Outlook when hosted).
  // CID inline attachment is also sent by Mailgun as a second source.
  return `
    <img src="${httpUrl}" alt="Youthnic Consignment Packing"
      width="56" height="56"
      style="display:block;margin:0 auto 12px;width:56px;height:56px;border-radius:12px;background:#fff;object-fit:contain;border:0" />
    <img src="cid:${LOGO_CID}" alt="" width="1" height="1" style="display:none;width:0;height:0;max-height:0;overflow:hidden;border:0" />`;
}

function emailShell({ title, preheader = '', bodyHtml, accent = '#0f172a' }) {
  const year = new Date().getFullYear();
  const safeTitle = escapeHtml(title);
  const safePre = escapeHtml(preheader);
  const httpUrl = escapeHtml(getLogoHttpUrl());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Inter,Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${safePre}</div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#eef2f7;width:100%">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
          <tr>
            <td style="background:${accent};padding:28px 28px 22px;text-align:center">
              ${logoBlock(httpUrl)}
              <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Youthnic</p>
              <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.75);letter-spacing:1.4px;text-transform:uppercase">${escapeHtml(APP_NAME)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 28px;background:#ffffff">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 28px;text-align:center">
              <p style="margin:0 0 6px;font-size:12px;color:#475569;font-weight:600">${escapeHtml(BRAND)}</p>
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6">
                © ${year} Youthnic Exports Pvt. Ltd. · Automated notification — do not reply to this email.<br>
                Open the app: <a href="${escapeHtml(getAppUrl())}" style="color:#4f46e5;text-decoration:none">${escapeHtml(getAppUrl())}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(href, label) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 8px">
      <tr><td align="center">
        <a href="${escapeHtml(href)}"
          style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px">
          ${escapeHtml(label)}
        </a>
      </td></tr>
    </table>`;
}

function consignmentDetailTable(consignment = {}) {
  const enriched = consignment;
  const cid = escapeHtml(enriched.internalShipmentNo || enriched.id || '—');
  const link = `${getAppUrl()}/consignments/${encodeURIComponent(enriched.id || '')}`;
  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 20px">
      <tr><td style="padding:18px 20px">
        <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8">Consignment details</p>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          ${detailRow('Internal shipment', cid)}
          ${detailRow('Consignment ID', escapeHtml(enriched.id || '—'))}
          ${detailRow('Name / marketplace', escapeHtml(enriched.name || enriched.marketplace?.name || '—'))}
          ${detailRow('Warehouse / FC', escapeHtml(enriched.warehouse || '—'))}
          ${detailRow('Pack status', escapeHtml(String(enriched.status || '—').replace(/_/g, ' ')))}
          ${detailRow('Shipment status', escapeHtml(enriched.shipmentStatus || 'Planned'))}
          ${detailRow('Ground team', escapeHtml(enriched.groundTeamName || 'Unassigned'))}
          ${detailRow('Pending action', escapeHtml(enriched.pendingAction || '—'))}
          ${detailRow('Invoice no.', escapeHtml(enriched.forwardInvoiceNo || '—'))}
          ${detailRow('Docket', escapeHtml([enriched.docketCompany, enriched.docketNo].filter(Boolean).join(' · ') || '—'))}
          ${detailRow('Required dispatch', fmtDate(enriched.requiredDispatchDate || enriched.scheduledDispatchDate))}
          ${detailRow('Appointment', fmtDate(enriched.appointmentDate))}
          ${detailRow('Packed qty', escapeHtml(`${enriched.totalPackedQty || 0} / ${enriched.totalRequiredQty || 0}`))}
          ${enriched.isEscalated ? detailRow('Escalation', '<span style="color:#b91c1c">Escalated to Organization Head</span>') : ''}
          ${enriched.isTatOverdue ? detailRow('TAT', '<span style="color:#b45309">Overdue</span>') : ''}
        </table>
        ${ctaButton(link, 'Open consignment in app')}
      </td></tr>
    </table>`;
}

function buildPasswordResetEmail({ name, email, resetUrl, fromEmail }) {
  const firstName = escapeHtml((name || email || 'there').split(' ')[0]);
  const subject = `Reset your password — ${BRAND}`;
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">Password reset requested</p>
    <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.65">
      Hi ${firstName}, we received a request to reset the password for your
      <strong>${escapeHtml(BRAND)}</strong> account (<span style="color:#4f46e5;font-family:monospace">${escapeHtml(email)}</span>).
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#64748b;line-height:1.65">
      Click the button below to choose a new password. This link expires in 1 hour for your security.
    </p>
    ${ctaButton(resetUrl, 'Reset Password')}
    <p style="margin:16px 0 12px;font-size:12px;color:#94a3b8;line-height:1.6">
      If the button doesn't work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 24px;font-size:11px;color:#6366f1;word-break:break-all;line-height:1.5">${escapeHtml(resetUrl)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px">
      <tr><td style="padding:14px 18px">
        <p style="margin:0;font-size:12px;color:#c2410c;line-height:1.5">
          <strong>Didn't request this?</strong> You can safely ignore this email. Your password will not change unless you use the link above.
        </p>
      </td></tr>
    </table>
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">
      Need help? Contact <a href="mailto:${escapeHtml(fromEmail)}" style="color:#4f46e5">${escapeHtml(fromEmail)}</a>
    </p>`;

  return {
    subject,
    html: emailShell({ title: subject, preheader: 'Reset your Youthnic Packing Station password', bodyHtml }),
    text: `Hi ${firstName},\n\nReset your ${BRAND} password for ${email}:\n${resetUrl}\n\nThis link expires in 1 hour.\n\n© ${new Date().getFullYear()} Youthnic Exports Pvt. Ltd.`,
  };
}

function buildAppPasswordResetUrl(firebaseLink, appUrl) {
  try {
    const parsed = new URL(firebaseLink);
    const oobCode = parsed.searchParams.get('oobCode');
    const mode = parsed.searchParams.get('mode') || 'resetPassword';
    if (!oobCode) return firebaseLink;
    const base = (appUrl || getAppUrl()).replace(/\/$/, '');
    return `${base}/reset-password?mode=${encodeURIComponent(mode)}&oobCode=${encodeURIComponent(oobCode)}`;
  } catch {
    return firebaseLink;
  }
}

function buildWorkflowEmail({
  title,
  headline,
  intro,
  consignment,
  stageLabel,
  extraHtml = '',
  accent = '#0f172a',
  badge,
}) {
  const cid = consignment?.internalShipmentNo || consignment?.id || 'consignment';
  const subject = `${title} — ${cid}`;
  const badgeHtml = badge
    ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px">${escapeHtml(badge)}</span>`
    : '';

  const bodyHtml = `
    ${badgeHtml}
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a">${escapeHtml(headline || title)}</p>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;line-height:1.65">${intro || ''}</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 16px">
      <tr><td style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:12px 16px">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#6366f1">Current stage / action</p>
        <p style="margin:6px 0 0;font-size:15px;font-weight:700;color:#312e81">${escapeHtml(stageLabel || '—')}</p>
      </td></tr>
    </table>
    ${extraHtml}
    ${consignmentDetailTable(consignment)}
  `;

  const text = [
    headline || title,
    stageLabel ? `Stage: ${stageLabel}` : '',
    `Consignment: ${cid}`,
    consignment?.pendingAction ? `Pending: ${consignment.pendingAction}` : '',
    consignment?.groundTeamName ? `Assignee: ${consignment.groundTeamName}` : '',
    `${getAppUrl()}/consignments/${consignment?.id || ''}`,
  ].filter(Boolean).join('\n');

  return {
    subject,
    html: emailShell({
      title: subject,
      preheader: `${headline || title} · ${cid}`,
      bodyHtml,
      accent,
    }),
    text,
  };
}

function buildWeeklyReportEmail(report = {}) {
  const t = report.totals || {};
  const subject = `Weekly consignment report — ${t.delayed || 0} delayed · ${BRAND}`;
  const gen = fmtDate(report.generatedAt);

  const metric = (label, value, color = '#0f172a') => `
    <td width="25%" style="padding:6px">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
        <tr><td style="padding:12px;text-align:center">
          <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.6px">${escapeHtml(label)}</p>
          <p style="margin:6px 0 0;font-size:22px;font-weight:800;color:${color}">${escapeHtml(String(value ?? 0))}</p>
        </td></tr>
      </table>
    </td>`;

  const assigneeRows = (report.byAssignee || []).map((r) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${escapeHtml(r.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center">${escapeHtml(r.packed)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center">${escapeHtml(r.dispatched)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;color:${r.delayed ? '#b91c1c' : '#0f172a'};font-weight:${r.delayed ? '700' : '400'}">${escapeHtml(r.delayed)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center">No assignee data</td></tr>`;

  const deptRows = (report.byDepartment || []).map((r) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${escapeHtml(r.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center">${escapeHtml(r.packed)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center">${escapeHtml(r.dispatched)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;color:${r.delayed ? '#b91c1c' : '#0f172a'};font-weight:${r.delayed ? '700' : '400'}">${escapeHtml(r.delayed)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center">No department data</td></tr>`;

  const delayedList = (report.delayedItems || []).map((d) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:12px">
        <a href="${escapeHtml(`${getAppUrl()}/consignments/${d.id}`)}" style="color:#4f46e5;font-weight:700;text-decoration:none">${escapeHtml(d.internalShipmentNo || d.id)}</a>
        <div style="color:#64748b;margin-top:2px">${escapeHtml(d.pendingAction || '—')} · ${escapeHtml(d.groundTeamName || 'Unassigned')}${d.isEscalated ? ' · Escalated' : ''}</div>
      </td>
    </tr>`).join('') || `<tr><td style="padding:12px;color:#94a3b8;text-align:center">No delayed consignments</td></tr>`;

  const bodyHtml = `
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#0f172a">Weekly consignment report</p>
    <p style="margin:0 0 22px;font-size:13px;color:#64748b">Generated ${gen} · last 7 days overview</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:8px">
      <tr>
        ${metric('Total', t.totalConsignments)}
        ${metric('New (7d)', t.newConsignments, '#0369a1')}
        ${metric('In progress', t.inProgress, '#1d4ed8')}
        ${metric('Packed', t.packed, '#047857')}
      </tr>
      <tr>
        ${metric('Pending invoice', t.pendingInvoice, '#b45309')}
        ${metric('Dispatched', t.dispatched, '#4338ca')}
        ${metric('Inwarded', t.inwarded, '#475569')}
        ${metric('Delayed', t.delayed, '#b91c1c')}
      </tr>
    </table>
    ${ctaButton(`${getAppUrl()}/consignments`, 'Open consignments')}

    <p style="margin:28px 0 10px;font-size:14px;font-weight:700;color:#0f172a">Assignee performance</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
      <tr style="background:#f8fafc">
        <th align="left" style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Person</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Packed</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Dispatched</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Delayed</th>
      </tr>
      ${assigneeRows}
    </table>

    <p style="margin:8px 0 10px;font-size:14px;font-weight:700;color:#0f172a">Marketplace / department</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
      <tr style="background:#f8fafc">
        <th align="left" style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Department</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Packed</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Dispatched</th>
        <th style="padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Delayed</th>
      </tr>
      ${deptRows}
    </table>

    <p style="margin:8px 0 10px;font-size:14px;font-weight:700;color:#0f172a">Delayed / escalated</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      ${delayedList}
    </table>
  `;

  const text = `Weekly consignment report (${report.generatedAt || ''})
Total=${t.totalConsignments} New=${t.newConsignments} InProgress=${t.inProgress} Packed=${t.packed}
PendingInvoice=${t.pendingInvoice} Dispatched=${t.dispatched} Inwarded=${t.inwarded} Delayed=${t.delayed}
Consignments: ${getAppUrl()}/consignments`;

  return {
    subject,
    html: emailShell({
      title: subject,
      preheader: `Weekly report · ${t.delayed || 0} delayed consignments`,
      bodyHtml,
      accent: '#0f172a',
    }),
    text,
  };
}

module.exports = {
  APP_NAME,
  BRAND,
  LOGO_CID,
  getAppUrl,
  getLogoHttpUrl,
  getLogoFilePath,
  escapeHtml,
  emailShell,
  buildPasswordResetEmail,
  buildAppPasswordResetUrl,
  buildWorkflowEmail,
  buildWeeklyReportEmail,
};
