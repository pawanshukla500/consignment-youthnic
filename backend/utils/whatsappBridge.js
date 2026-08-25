/**
 * Bridge between Consignment Workflow events and the WhatsApp Outbox.
 */

const { enqueueWhatsAppNotification } = require('./whatsappOutbox');
const { getShipmentCriticality } = require('./criticality');
const { STAGE_LABELS } = require('./consignmentWorkflow');

// Basic watermark formatting for text messages
function formatWatermark(text) {
  return `*youthnic operations*\n\n${text}\n\n_Auto-generated notification_`;
}

/**
 * Format consignment details for WhatsApp messages.
 */
function getConsignmentDetailsString(consignment) {
  const idStr = consignment.internalShipmentNo || consignment.id || 'N/A';
  const nameStr = consignment.name || 'N/A';
  return `*ID:* ${idStr}\n*Name:* ${nameStr}`;
}

/**
 * Map consignment creation.
 */
async function notifyWhatsappCreated(consignment) {
  if (!consignment?.id) return;
  const critical = getShipmentCriticality(consignment);
  const isPriority = critical?.level === 'high' || critical?.level === 'critical';
  const priorityTag = isPriority ? ` 🚨 *[PRIORITY]*` : '';

  const text = formatWatermark(`📦 *New Consignment Created*${priorityTag}\n\n${getConsignmentDetailsString(consignment)}`);
  
  await enqueueWhatsAppNotification('consignment', consignment.id, 'created', {
    type: 'text',
    text,
  });
}

/**
 * Map workflow stage changes.
 */
async function notifyWhatsappStages(consignment, stages = [], options = {}) {
  if (!consignment?.id || !stages.length) return;
  
  const stage = stages[stages.length - 1]; // Use the most recent stage if multiple
  const stageName = STAGE_LABELS[stage] || stage;
  const critical = getShipmentCriticality(consignment);
  const isPriority = critical?.level === 'high' || critical?.level === 'critical';
  const priorityTag = isPriority ? ` 🚨 *[PRIORITY]*` : '';
  
  let extraInfo = '';
  if (options.note) {
    extraInfo = `\n*Note:* ${options.note}`;
  }

  const text = formatWatermark(`✅ *Stage Confirmed: ${stageName}*${priorityTag}\n\n${getConsignmentDetailsString(consignment)}${extraInfo}`);
  
  await enqueueWhatsAppNotification('consignment', consignment.id, 'stage_confirmed', {
    type: 'text',
    text,
  });
}

/**
 * Map ground team assignment.
 */
async function notifyWhatsappAssignee(consignment) {
  if (!consignment?.id) return;
  const assignee = consignment.groundTeamName || consignment.groundTeamEmail || 'Unassigned';
  const text = formatWatermark(`👤 *Ground Team Assigned*\n\n${getConsignmentDetailsString(consignment)}\n*Assigned To:* ${assignee}`);
  
  await enqueueWhatsAppNotification('consignment', consignment.id, 'assignment_changed', {
    type: 'text',
    text,
  });
}

/**
 * Map dispute events.
 */
async function notifyWhatsappDisputeEvent(consignment, options = {}) {
  if (!consignment?.id) return;
  const { event } = options;
  const isOpened = event === 'opened';
  const title = isOpened ? `⚠️ *Inward Dispute Opened*` : `✅ *Inward Dispute Resolved*`;
  
  const text = formatWatermark(`${title}\n\n${getConsignmentDetailsString(consignment)}`);
  
  await enqueueWhatsAppNotification('consignment', consignment.id, `dispute_${event}`, {
    type: 'text',
    text,
  });
}

/**
 * Map escalations.
 */
async function notifyWhatsappEscalation(consignment) {
  if (!consignment?.id) return;
  const text = formatWatermark(`🚨 *Consignment Escalated*\n\n${getConsignmentDetailsString(consignment)}\n*Reason:* TAT Overdue`);
  
  await enqueueWhatsAppNotification('consignment', consignment.id, 'escalated', {
    type: 'text',
    text,
  });
}

module.exports = {
  notifyWhatsappCreated,
  notifyWhatsappStages,
  notifyWhatsappAssignee,
  notifyWhatsappDisputeEvent,
  notifyWhatsappEscalation,
};
