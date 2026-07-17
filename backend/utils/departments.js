/**
 * Operational departments for consignment workflow assignment.
 * Stored on users.department (string key). Admins bypass department gates.
 */

const DEPARTMENTS = Object.freeze({
  packing: {
    key: 'packing',
    label: 'Packing Team',
    stages: ['packing_completed'],
  },
  ground_team: {
    key: 'ground_team',
    label: 'Ground Team',
    stages: ['packing_completed', 'ready_for_dispatch', 'dispatched'],
  },
  invoice: {
    key: 'invoice',
    label: 'Invoice Creation Team',
    stages: ['ready_for_invoice', 'invoice_created'],
  },
  dispatch: {
    key: 'dispatch',
    label: 'Dispatch Team',
    stages: ['ready_for_dispatch', 'dispatched'],
  },
  inward: {
    key: 'inward',
    label: 'Inward Tracking Team',
    stages: ['inward_completed'],
  },
  management: {
    key: 'management',
    label: 'Admin / Management',
    stages: [
      'packing_completed',
      'ready_for_invoice',
      'invoice_created',
      'ready_for_dispatch',
      'dispatched',
      'inward_completed',
    ],
  },
});

const DEPARTMENT_KEYS = Object.keys(DEPARTMENTS);

/** Stage → departments that may confirm it (admins always can). */
const STAGE_DEPARTMENTS = Object.freeze({
  packing_completed: ['packing', 'ground_team', 'management'],
  ready_for_invoice: ['invoice', 'management'],
  invoice_created: ['invoice', 'management'],
  ready_for_dispatch: ['dispatch', 'ground_team', 'management'],
  dispatched: ['dispatch', 'ground_team', 'management'],
  inward_completed: ['inward', 'management'],
});

/** After confirming a stage, auto-assign ownership to this department. */
const NEXT_ASSIGNMENT_DEPARTMENT = Object.freeze({
  packing_completed: 'invoice',
  invoice_created: 'dispatch',
  dispatched: 'inward',
});

function normalizeDepartment(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  if (DEPARTMENTS[key]) return key;
  // Friendly aliases
  const aliases = {
    packing_team: 'packing',
    ground: 'ground_team',
    invoice_creation: 'invoice',
    invoice_team: 'invoice',
    dispatch_team: 'dispatch',
    inward_tracking: 'inward',
    admin: 'management',
    organization_head: 'management',
  };
  return aliases[key] || null;
}

function departmentLabel(key) {
  const normalized = normalizeDepartment(key);
  return normalized ? DEPARTMENTS[normalized].label : null;
}

function userCanConfirmStage(user, stage, consignment = null) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const dept = normalizeDepartment(user.department);
  if (dept === 'management') return true;
  const allowed = STAGE_DEPARTMENTS[stage] || [];
  if (dept && allowed.includes(dept)) return true;
  // Legacy: assigned ground team member can still act on stages they own
  if (consignment?.groundTeamUserId && consignment.groundTeamUserId === user.id) {
    return ['packing_completed', 'ready_for_dispatch', 'dispatched'].includes(stage);
  }
  return false;
}

function listDepartmentOptions() {
  return DEPARTMENT_KEYS.map((key) => ({
    key,
    label: DEPARTMENTS[key].label,
  }));
}

module.exports = {
  DEPARTMENTS,
  DEPARTMENT_KEYS,
  STAGE_DEPARTMENTS,
  NEXT_ASSIGNMENT_DEPARTMENT,
  normalizeDepartment,
  departmentLabel,
  userCanConfirmStage,
  listDepartmentOptions,
};
