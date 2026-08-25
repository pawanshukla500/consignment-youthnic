const { enqueueWhatsAppNotification } = require('./whatsappOutbox');
const { getShipmentCriticality } = require('./criticality');
const { getPendingAction } = require('./consignmentWorkflow');

const BRAND = process.env.WHATSAPP_BRAND_NAME || 'YOUTHNIC • CONSIGNMENT OPERATIONS';

function buildMessage(title, bodyLines, nextAction = null) {
  let text = `🟢 *${BRAND}*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (title) text += `*${title}*\n\n`;
  text += bodyLines.join('\n');
  if (nextAction) {
    text += `\n\n➡️ *NEXT ACTION*\n${nextAction}`;
  }
  text += `\n\n━━━━━━━━━━━━━━━━━━━━\n_Automated by Youthnic Consignment System_`;
  return text;
}

function formatDateIST(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    return new Date(dateStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  } catch(e) { return dateStr; }
}

function notifyWhatsappCreated(consignment) {
  const criticality = getShipmentCriticality(consignment);
  const pendingAction = getPendingAction(consignment) || 'Pending Assignment';
  
  const body = [
    `Consignment: ${consignment.id}`,
    `Internal Shipment: ${consignment.internalShipmentNo || 'N/A'}`,
    `Marketplace: ${consignment.marketplaceId || 'N/A'}`,
    `Warehouse: ${consignment.warehouse || 'N/A'}`,
    `SKUs: ${consignment.skus?.length || 0}`,
    `Planned Qty: ${consignment.totalRequiredQty || 0}`,
    `Appointment Date: ${formatDateIST(consignment.appointmentDate)}`,
    `Required Dispatch: ${formatDateIST(consignment.scheduledDispatchDate)}`,
    `Priority: ${criticality.priority}`,
    `Created By: ${consignment.createdBy || 'System'}`,
    `Created At: ${formatDateIST(consignment.createdAt)} IST`
  ];

  const text = buildMessage('🆕 NEW CONSIGNMENT CREATED', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'consignment_created', `created:${consignment.id}`, text);
}

function notifyWhatsappAssignee(consignment) {
  const pendingAction = getPendingAction(consignment) || 'Pending Assignment';
  const body = [
    `Consignment: ${consignment.id}`,
    `Assigned Department: ${consignment.assignedDepartment || 'N/A'}`,
    `Assigned Person: ${consignment.assignedUserId || 'Unassigned'}`,
    `TAT Deadline: ${formatDateIST(consignment.tatDeadline)}`
  ];

  const text = buildMessage('👥 ASSIGNMENT CHANGED', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'assignment_changed', `assign:${consignment.id}:${consignment.assignedUserId || 'dept'}`, text);
}

function notifyWhatsappStages(consignment, stages, options = {}) {
  const pendingAction = getPendingAction(consignment);
  const stage = stages[stages.length - 1]; // latest stage
  const stageLabel = stage.toUpperCase().replace(/_/g, ' ');

  const body = [
    `Consignment: ${consignment.id}`,
    `Confirmed By: ${options.confirmedBy || 'System'}`,
    `Time: ${formatDateIST(new Date().toISOString())} IST`,
  ];

  if (options.note) body.push(`Note: ${options.note}`);

  // Special cases for certain stages
  if (stage === 'packing_completed') {
    const planned = consignment.totalRequiredQty || 0;
    const packed = consignment.totalPackedQty || 0;
    const short = planned - packed;
    const perc = planned > 0 ? Math.round((packed / planned) * 100) : 0;
    body.push(`Planned Qty: ${planned}`);
    body.push(`Packed Qty: ${packed} (${perc}%)`);
    if (short > 0) {
      body.push(`Short Qty: ${short}`);
      body.push(`Short Reason: ${consignment.shortReason || 'Not Provided'}`);
    }
    body.push(`Box Count: ${consignment.boxes?.length || 0}`);
  } else if (stage === 'invoice_created') {
    body.push(`Invoice No: ${consignment.forwardInvoiceNo || 'N/A'}`);
  } else if (stage === 'dispatched') {
    body.push(`Planned Qty: ${consignment.totalRequiredQty || 0}`);
    body.push(`Dispatched Qty: ${consignment.unitsShipped || consignment.totalPackedQty || 0}`);
    body.push(`Boxes: ${consignment.boxes?.length || 0}`);
    body.push(`Transporter: ${consignment.docketCompany || 'N/A'}`);
    body.push(`Docket No: ${consignment.docketNo || 'N/A'}`);
    body.push(`Actual Dispatch: ${formatDateIST(consignment.actualDispatchDate)}`);
  } else if (stage === 'inward_completed') {
    const shipped = consignment.unitsShipped || 0;
    const inwarded = consignment.unitsInwarded || 0;
    const variance = inwarded - shipped;
    body.push(`Units Shipped: ${shipped}`);
    body.push(`Units Inwarded: ${inwarded}`);
    body.push(`Variance: ${variance}`);
    body.push(`State: ${variance === 0 ? 'Clean' : 'Mismatch'}`);
  }

  // TODO: Add attachments integration here based on R2 records if provided in options
  const text = buildMessage(`✅ ${stageLabel}`, body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'stage_confirmed', `stage:${consignment.id}:${stage}`, text, options.attachments || []);
}

function notifyWhatsappDisputeEvent(consignment, disputeInfo) {
  const isOpened = disputeInfo.event === 'opened';
  const title = isOpened ? '🚨 INWARD DISPUTE OPENED' : (disputeInfo.event === 'resolved' ? '✅ DISPUTE RESOLVED' : '🎫 DISPUTE TICKET RECORDED');
  
  const body = [
    `Consignment: ${consignment.id}`,
    `Assigned Team: ${consignment.assignedDepartment || 'N/A'}`,
    `Ticket ID: ${consignment.marketplaceTicketId || 'None'}`,
  ];

  if (isOpened) {
    const shipped = consignment.unitsShipped || 0;
    const inwarded = consignment.unitsInwarded || 0;
    body.push(`Shipped Qty: ${shipped}`);
    body.push(`Inward Qty: ${inwarded}`);
    body.push(`Variance: ${inwarded - shipped}`);
  }

  if (disputeInfo.event === 'resolved') {
    body.push(`Resolution: ${disputeInfo.resolution || 'N/A'}`);
    body.push(`Remark: ${disputeInfo.remark || 'N/A'}`);
    body.push(`Resolved By: ${disputeInfo.resolvedBy || 'System'}`);
  }

  const text = buildMessage(title, body, getPendingAction(consignment));
  return enqueueWhatsAppNotification(consignment.id, 'dispute_event', `dispute:${consignment.id}:${disputeInfo.event}:${Date.now()}`, text);
}

function notifyWhatsappEscalation(consignment) {
  const pendingAction = getPendingAction(consignment);
  const body = [
    `Consignment: ${consignment.id}`,
    `Pending Action: ${pendingAction || 'N/A'}`,
    `Assigned Team: ${consignment.assignedDepartment || 'N/A'}`,
    `Assigned Person: ${consignment.assignedUserId || 'Unassigned'}`,
    `Required Dispatch: ${formatDateIST(consignment.scheduledDispatchDate)}`,
  ];
  
  if (consignment.totalRequiredQty > 0) {
    const perc = Math.round(((consignment.totalPackedQty || 0) / consignment.totalRequiredQty) * 100);
    body.push(`Packing: ${perc}%`);
  }

  const text = buildMessage('🔴 TAT ESCALATION', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'tat_escalation', `escalation:${consignment.id}:${Date.now()}`, text);
}

function notifyWhatsappArchived(consignment) {
  const body = [
    `Consignment: ${consignment.id}`,
    `Final Quantities - Req: ${consignment.totalRequiredQty}, Packed: ${consignment.totalPackedQty}`,
    `Archive Reason: ${consignment.archiveReason || 'Completed'}`,
    `Completion Timestamp: ${formatDateIST(new Date().toISOString())}`
  ];

  const text = buildMessage('🏁 CONSIGNMENT CLOSED', body);
  return enqueueWhatsAppNotification(consignment.id, 'archived', `archived:${consignment.id}`, text);
}

module.exports = {
  notifyWhatsappCreated,
  notifyWhatsappAssignee,
  notifyWhatsappStages,
  notifyWhatsappDisputeEvent,
  notifyWhatsappEscalation,
  notifyWhatsappArchived,
};
