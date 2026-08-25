const { enqueueWhatsAppNotification } = require('./whatsappOutbox');
const { getShipmentCriticality } = require('./criticality');
const { getPendingAction } = require('./consignmentWorkflow');
const { getDocument } = require('./helpers');

const BRAND = process.env.WHATSAPP_BRAND_NAME || 'YOUTHNIC • CONSIGNMENT OPERATIONS';
const FRONTEND_URL = process.env.APP_URL || 'https://consignment.youthnic.shop';

async function resolveUserMention(userId) {
  if (!userId) return null;
  try {
    const user = await getDocument('users', userId);
    if (!user) return null;
    let mobile = null;
    if (user.source_document && user.source_document.mobile) {
      mobile = user.source_document.mobile;
    } else if (user.mobile) {
      mobile = user.mobile;
    }
    
    if (mobile) {
      mobile = mobile.replace(/\D/g, '');
      if (mobile.length === 10) return '91' + mobile;
      if (mobile.startsWith('91') && mobile.length === 12) return mobile;
      return mobile;
    }
  } catch(e) {
    console.error('[WhatsAppBridge] Failed to resolve mention for', userId, e.message);
  }
  return null;
}

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

async function notifyWhatsappCreated(consignment) {
  const criticality = getShipmentCriticality(consignment);
  const pendingAction = getPendingAction(consignment) || 'Pending Assignment';
  
  let assignedPersonText = consignment.assignedUserId || 'Unassigned';
  const mentions = [];
  const mobile = await resolveUserMention(consignment.assignedUserId);
  if (mobile) {
    assignedPersonText = `@${mobile}`;
    mentions.push(`${mobile}@c.us`);
  }
  
  const body = [
    `Consignment: ${consignment.id}`,
    `Internal Shipment: ${consignment.internalShipmentNo || 'N/A'}`,
    `Assigned: ${assignedPersonText}`,
    `Marketplace: ${consignment.marketplaceId || 'N/A'}`,
    `Warehouse: ${consignment.warehouse || 'N/A'}`,
    `SKUs: ${consignment.skus?.length || 0}`,
    `Planned Qty: ${consignment.totalRequiredQty || 0}`,
    `Appointment Date: ${formatDateIST(consignment.appointmentDate)}`,
    `Required Dispatch: ${formatDateIST(consignment.scheduledDispatchDate)}`,
    `Priority: ${criticality.priority}`,
    `Created By: ${consignment.createdBy || 'System'}`,
    `Created At: ${formatDateIST(consignment.createdAt)} IST`,
    `\nLink: ${FRONTEND_URL}/consignments/${consignment.id}`
  ];

  const text = buildMessage('🆕 NEW CONSIGNMENT CREATED', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'consignment_created', `created:${consignment.id}`, text, [], mentions);
}

async function notifyWhatsappAssignee(consignment) {
  const pendingAction = getPendingAction(consignment) || 'Pending Assignment';
  
  let assignedPersonText = consignment.assignedUserId || 'Unassigned';
  const mentions = [];
  const mobile = await resolveUserMention(consignment.assignedUserId);
  if (mobile) {
    assignedPersonText = `@${mobile}`;
    mentions.push(`${mobile}@c.us`);
  }

  const body = [
    `Consignment: ${consignment.id}`,
    `Internal Shipment: ${consignment.internalShipmentNo || 'N/A'}`,
    `Assigned Department: ${consignment.assignedDepartment || 'N/A'}`,
    `Assigned Person: ${assignedPersonText}`,
    `TAT Deadline: ${formatDateIST(consignment.tatDeadline)}`,
    `\nLink: ${FRONTEND_URL}/consignments/${consignment.id}`
  ];

  const text = buildMessage('👥 ASSIGNMENT CHANGED', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'assignment_changed', `assign:${consignment.id}:${consignment.assignedUserId || 'dept'}`, text, [], mentions);
}

async function notifyWhatsappStages(consignment, stages, options = {}) {
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

  const mentions = [];
  const mobile = await resolveUserMention(consignment.assignedUserId);
  if (mobile) {
    mentions.push(`${mobile}@c.us`);
    body.splice(1, 0, `Assigned: @${mobile}`);
  }

  body.push(`\nLink: ${FRONTEND_URL}/consignments/${consignment.id}`);
  const text = buildMessage(`✅ ${stageLabel}`, body, pendingAction);

  // Load attachments if requested
  const attachments = [];
  if (['packing_completed', 'ready_for_invoice', 'invoice_created', 'dispatched'].includes(stage)) {
    try {
      const { firestoreHelpers } = require('./helpers');
      let docs = [];
      if (consignment.documentIds && consignment.documentIds.length > 0) {
        docs = await firestoreHelpers.batchGetDocuments('documents', consignment.documentIds);
      } else {
        docs = await firestoreHelpers.queryCollection('documents', 'consignmentId', '==', consignment.id);
      }
      
      const labels = (docs || []).filter(d => d && (d.type === 'document' || d.type === 'invoice' || d.type === 'label' || d.type === 'pdf' || d.type === 'export'));
      for (const doc of labels.slice(0, 2)) {
        attachments.push({
          type: 'document',
          url: doc.storageUrl || doc.url,
          storagePath: doc.storagePath,
          filename: doc.originalName || doc.name || 'document.pdf',
          mimeType: doc.mimeType || 'application/pdf'
        });
      }
    } catch (err) {
      console.warn('[WhatsAppBridge] Failed to load attachments for stage', stage, err.message);
    }
  }

  return enqueueWhatsAppNotification(consignment.id, 'stage_confirmed', `stage:${consignment.id}:${stage}`, text, attachments, mentions);
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
  const disputeKeyId = disputeInfo.id || disputeInfo.ticketId || disputeInfo.event;
  return enqueueWhatsAppNotification(consignment.id, 'dispute_event', `dispute:${consignment.id}:${disputeInfo.event}:${disputeKeyId}`, text);
}

async function notifyWhatsappEscalation(consignment) {
  const pendingAction = getPendingAction(consignment);
  
  let assignedPersonText = consignment.assignedUserId || 'Unassigned';
  const mentions = [];
  const mobile = await resolveUserMention(consignment.assignedUserId);
  if (mobile) {
    assignedPersonText = `@${mobile}`;
    mentions.push(`${mobile}@c.us`);
  }

  const body = [
    `Consignment: ${consignment.id}`,
    `Internal Shipment: ${consignment.internalShipmentNo || 'N/A'}`,
    `Pending Action: ${pendingAction || 'N/A'}`,
    `Assigned Team: ${consignment.assignedDepartment || 'N/A'}`,
    `Assigned Person: ${assignedPersonText}`,
    `Required Dispatch: ${formatDateIST(consignment.scheduledDispatchDate)}`,
  ];
  
  if (consignment.totalRequiredQty > 0) {
    const perc = Math.round(((consignment.totalPackedQty || 0) / consignment.totalRequiredQty) * 100);
    body.push(`Packing: ${perc}%`);
  }
  
  body.push(`\nLink: ${FRONTEND_URL}/consignments/${consignment.id}`);

  const text = buildMessage('🔴 TAT ESCALATION', body, pendingAction);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return enqueueWhatsAppNotification(consignment.id, 'tat_escalation', `escalation:${consignment.id}:${today}`, text, [], mentions);
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

async function notifyWhatsappPackingStarted(consignment) {
  const pendingAction = getPendingAction(consignment) || 'Start Packing Boxes';
  
  let assignedPersonText = consignment.assignedUserId || 'Unassigned';
  const mentions = [];
  const mobile = await resolveUserMention(consignment.assignedUserId);
  if (mobile) {
    assignedPersonText = `@${mobile}`;
    mentions.push(`${mobile}@c.us`);
  }

  const body = [
    `Consignment: ${consignment.id}`,
    `Internal Shipment: ${consignment.internalShipmentNo || 'N/A'}`,
    `Assigned Team: ${consignment.assignedDepartment || 'N/A'}`,
    `Assigned Person: ${assignedPersonText}`,
    `Planned Qty: ${consignment.totalRequiredQty || 0}`,
    `\nLink: ${FRONTEND_URL}/consignments/${consignment.id}`
  ];

  const text = buildMessage('📦 PACKING IN PROGRESS', body, pendingAction);
  return enqueueWhatsAppNotification(consignment.id, 'packing_started', `packing_started:${consignment.id}`, text, [], mentions);
}

module.exports = {
  notifyWhatsappCreated,
  notifyWhatsappAssignee,
  notifyWhatsappStages,
  notifyWhatsappDisputeEvent,
  notifyWhatsappEscalation,
  notifyWhatsappArchived,
  notifyWhatsappPackingStarted,
};
