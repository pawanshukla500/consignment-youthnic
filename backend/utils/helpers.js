const { v4: uuidv4 } = require('uuid');
const pgHelpers = require('./pgHelpers');

// Generate unique IDs
const generateId = () => uuidv4();

// Standardized timestamp
const now = () => new Date().toISOString();

// Audit logging helper
const addAuditLog = async (action, entityType, entityId, userId, details = {}) => {
  const logEntry = {
    id: generateId(),
    action,
    entityType,
    entityId,
    userId,
    details,
    timestamp: now()
  };
  
  try {
    await pgHelpers.setDocument('auditLogs', logEntry.id, logEntry);
  } catch (error) {
    console.error('[AuditLog] Failed to write audit log:', error.message);
  }
};

module.exports = {
  generateId,
  now,
  addAuditLog,
  firestoreHelpers: pgHelpers // Kept this name for backwards compatibility across route imports
};
