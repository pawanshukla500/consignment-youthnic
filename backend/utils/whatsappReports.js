const { getPool, pgEnabled } = require('../config/database');
const { enqueueWhatsAppNotification } = require('./whatsappOutbox');
const exceljs = require('exceljs');
const { getShipmentCriticality } = require('./criticality');
const { getPendingAction } = require('./consignmentWorkflow');

function getCurrentDateIST() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date()); // YYYY-MM-DD in IST
}

function formatDateIST(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    return new Date(dateStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  } catch(e) { return dateStr; }
}

async function sendMorningWhatsAppBrief() {
  if (!pgEnabled()) throw new Error('Postgres required');
  const pool = getPool();

  const query = `
    SELECT data 
    FROM documents 
    WHERE collection = 'consignments'
      AND data->>'status' != 'completed' 
      AND data->>'operationalStatus' != 'archived'
  `;
  const result = await pool.query(query);
  const activeConsignments = result.rows.map(row => row.data);

  const buckets = {
    critical: [],
    mustPack: [],
    highRisk: [],
    packing: [],
    packed: [],
    dispatch: [],
    inwardPending: [],
    disputes: [],
  };

  let unitsToPack = 0;

  activeConsignments.forEach(c => {
    const criticality = getShipmentCriticality(c);
    const pending = getPendingAction(c);
    const planned = c.totalRequiredQty || 0;
    const packed = c.totalPackedQty || 0;
    
    if (planned > packed) {
      unitsToPack += (planned - packed);
    }

    if (c.isDisputed) {
      buckets.disputes.push(c);
    } else if (criticality.priority === 'Critical') {
      buckets.critical.push(c);
    } else if (c.status === 'ready_for_dispatch') {
      buckets.dispatch.push(c);
    } else if (c.status === 'invoice_created') {
      buckets.packed.push(c);
    } else if (c.status === 'packing_completed') {
      buckets.packed.push(c);
    } else if (c.status === 'packing_in_progress') {
      buckets.packing.push(c);
    } else if (criticality.priority === 'High') {
      buckets.highRisk.push(c);
    } else {
      buckets.mustPack.push(c);
    }
  });

  const textLines = [
    `🌅 *MORNING OPERATIONS BRIEF*`,
    `Date: ${getCurrentDateIST()}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `*TOTALS:*`,
    `Active: ${activeConsignments.length}`,
    `Critical: ${buckets.critical.length}`,
    `High Risk: ${buckets.highRisk.length}`,
    `Units to Pack: ${unitsToPack}`,
    `Ready to Dispatch: ${buckets.dispatch.length}`,
    `Open Disputes: ${buckets.disputes.length}`,
    ``,
    `*🚨 CRITICAL / OVERDUE (${buckets.critical.length})*`,
    ...buckets.critical.slice(0, 5).map(c => `• ${c.id} | ${c.marketplaceId || 'N/A'}\n  Packed: ${c.totalPackedQty || 0}/${c.totalRequiredQty || 0}\n  Action: ${getPendingAction(c)}`),
    ``,
    `*🔥 MUST PACK / DISPATCH SOON (${buckets.mustPack.length})*`,
    ``,
    `*🟠 HIGH RISK (${buckets.highRisk.length})*`,
    ``,
    `*⚠️ OPEN DISPUTES (${buckets.disputes.length})*`,
    ...buckets.disputes.slice(0, 5).map(c => `• ${c.id} | Ticket: ${c.marketplaceTicketId || 'N/A'}`)
  ];

  const workbook = new exceljs.Workbook();
  const sheet = workbook.addWorksheet('Morning Priority');
  sheet.columns = [
    { header: 'Consignment', key: 'id', width: 20 },
    { header: 'Marketplace', key: 'marketplaceId', width: 15 },
    { header: 'Priority', key: 'priority', width: 15 },
    { header: 'Pending Action', key: 'action', width: 25 },
    { header: 'Assigned', key: 'assigned', width: 20 },
    { header: 'Packed / Req', key: 'packed', width: 15 },
    { header: 'Dispatch Date', key: 'dispatch', width: 20 },
  ];

  activeConsignments.forEach(c => {
    sheet.addRow({
      id: c.id,
      marketplaceId: c.marketplaceId,
      priority: getShipmentCriticality(c).priority,
      action: getPendingAction(c),
      assigned: c.assignedDepartment || 'N/A',
      packed: `${c.totalPackedQty || 0} / ${c.totalRequiredQty || 0}`,
      dispatch: formatDateIST(c.scheduledDispatchDate),
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const base64Excel = buffer.toString('base64');
  const filename = `Morning-Priority-${getCurrentDateIST()}.xlsx`;

  await enqueueWhatsAppNotification('system', 'morning_brief', `morning:${getCurrentDateIST()}`, textLines.join('\n'), [
    { type: 'document', base64: base64Excel, filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  ]);

  return { ok: true, active: activeConsignments.length };
}

async function sendEndOfDayWhatsAppSummary() {
  if (!pgEnabled()) throw new Error('Postgres required');
  const pool = getPool();
  
  const todayIST = getCurrentDateIST();

  const query = `
    SELECT data 
    FROM documents 
    WHERE collection = 'consignments'
      AND data->>'status' != 'completed' 
      AND data->>'operationalStatus' != 'archived'
  `;
  const result = await pool.query(query);
  const activeConsignments = result.rows.map(row => row.data);

  // We should ideally query audit logs for exact "today" stats.
  // For simplicity, we approximate using actualDispatchDate for dispatch.
  const dispatchedQuery = `
    SELECT data FROM documents
    WHERE collection = 'consignments' AND data->>'actualDispatchDate' LIKE $1 || '%'
  `;
  const dispatchResult = await pool.query(dispatchedQuery, [todayIST]);
  const dispatchedToday = dispatchResult.rows.map(r => r.data);
  const unitsDispatched = dispatchedToday.reduce((sum, c) => sum + (c.unitsShipped || c.totalPackedQty || 0), 0);

  const textLines = [
    `🌙 *END OF DAY OPERATIONS — ${todayIST}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*TODAY:*`,
    `🚚 Dispatched: ${dispatchedToday.length} consignments (${unitsDispatched} units)`,
    ``,
    `*CURRENT SNAPSHOT:*`,
    `Active Consignments: ${activeConsignments.length}`,
    `Disputed: ${activeConsignments.filter(c => c.isDisputed).length}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `_Automated by Youthnic Consignment System_`
  ];

  const workbook = new exceljs.Workbook();
  const sheet = workbook.addWorksheet('EOD Summary');
  sheet.columns = [
    { header: 'Consignment', key: 'id', width: 20 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'Shipment Status', key: 'shipmentStatus', width: 20 },
    { header: 'Packed / Req', key: 'packed', width: 15 },
  ];

  activeConsignments.forEach(c => {
    sheet.addRow({
      id: c.id,
      status: c.status,
      shipmentStatus: c.shipmentStatus,
      packed: `${c.totalPackedQty || 0} / ${c.totalRequiredQty || 0}`,
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const base64Excel = buffer.toString('base64');
  const filename = `Consignment-EOD-${todayIST}.xlsx`;

  await enqueueWhatsAppNotification('system', 'eod_summary', `eod:${todayIST}`, textLines.join('\n'), [
    { type: 'document', base64: base64Excel, filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  ]);

  return { ok: true, dispatched: dispatchedToday.length };
}
async function sendTATApproachingAlert() {
  if (!pgEnabled()) throw new Error('Postgres required');
  const pool = getPool();

  const query = `
    SELECT data 
    FROM documents 
    WHERE collection = 'consignments'
      AND data->>'status' != 'completed' 
      AND data->>'operationalStatus' != 'archived'
  `;
  const result = await pool.query(query);
  const activeConsignments = result.rows.map(row => row.data);

  const tatApproaching = [];

  activeConsignments.forEach(c => {
    const criticality = getShipmentCriticality(c);
    // TAT Approaching = Critical or High
    if (criticality.level === 'critical' || criticality.level === 'high') {
      tatApproaching.push({ consignment: c, criticality });
    }
  });

  if (tatApproaching.length === 0) {
    // We can still send a message saying all is good
    const goodNews = `✅ *TAT STATUS: ALL GOOD*\nDate: ${getCurrentDateIST()}\n\nNo consignments are currently overdue or at risk. Excellent work! 🎉`;
    await enqueueWhatsAppNotification('system', 'tat_alert', `tat_alert:${Date.now()}`, goodNews);
    return { ok: true, active: 0, message: 'No consignments with approaching TAT.' };
  }

  // Sort by highest risk first
  tatApproaching.sort((a, b) => a.criticality.sort - b.criticality.sort);

  const textLines = [
    `🚨 *TAT ESCALATION ALERT*`,
    `Date: ${getCurrentDateIST()}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ *${tatApproaching.length}* Consignments are At Risk or Overdue!`,
    ``
  ];

  tatApproaching.slice(0, 15).forEach(({ consignment: c, criticality }) => {
    const icon = criticality.level === 'critical' ? '🔴' : '🟠';
    const packed = `${c.totalPackedQty || 0}/${c.totalRequiredQty || 0}`;
    const pending = getPendingAction(c);
    textLines.push(`${icon} *${c.id}*`);
    textLines.push(`  Action: ${pending}`);
    textLines.push(`  Packed: ${packed}`);
    textLines.push(`  Deadline: ${formatDateIST(c.scheduledDispatchDate) || 'N/A'}`);
    textLines.push(`  Assignee: ${c.assignedUserId || c.assignedDepartment || 'Unassigned'}`);
    textLines.push(``);
  });

  if (tatApproaching.length > 15) {
    textLines.push(`_... and ${tatApproaching.length - 15} more._`);
  }

  await enqueueWhatsAppNotification('system', 'tat_alert', `tat_alert:${Date.now()}`, textLines.join('\n'));

  return { ok: true, active: tatApproaching.length };
}

module.exports = {
  sendMorningWhatsAppBrief,
  sendEndOfDayWhatsAppSummary,
  sendTATApproachingAlert,
};
