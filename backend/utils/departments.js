/**
 * Operational departments for consignment workflow assignment.
 * Users may belong to multiple departments via users.departments (string[]).
 * Legacy users.department (single string) is still supported.
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

/**
 * Normalize one or many department values into a unique ordered list of keys.
 * Accepts: string, string[], comma/pipe-separated string, or null.
 */
function normalizeDepartments(raw) {
  let values = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    values = raw.split(/[,|;]/).map((s) => s.trim()).filter(Boolean);
  } else if (raw != null) {
    values = [raw];
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = normalizeDepartment(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Departments belonging to a user document / session user. */
function getUserDepartments(user) {
  if (!user) return [];
  if (Array.isArray(user.departments) && user.departments.length) {
    return normalizeDepartments(user.departments);
  }
  if (user.department) {
    return normalizeDepartments(user.department);
  }
  if (user.role === 'admin' || user.role === 'organization_head') {
    return ['management'];
  }
  return [];
}

/**
 * Resolve departments for create/update payloads.
 * Prefers `departments`; falls back to singular `department`.
 * Elevated roles always include management.
 */
function resolveUserDepartments({ departments, department, role } = {}) {
  let keys = normalizeDepartments(
    departments !== undefined ? departments : department
  );
  if ((role === 'admin' || role === 'organization_head') && !keys.includes('management')) {
    keys = ['management', ...keys];
  }
  return keys;
}

function departmentLabel(key) {
  const normalized = normalizeDepartment(key);
  return normalized ? DEPARTMENTS[normalized].label : null;
}

function departmentLabels(keys) {
  return normalizeDepartments(keys).map((key) => DEPARTMENTS[key].label);
}

function userCanConfirmStage(user, stage, consignment = null) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'organization_head') return true;
  const depts = getUserDepartments(user);
  if (depts.includes('management')) return true;
  const allowed = STAGE_DEPARTMENTS[stage] || [];
  if (depts.some((dept) => allowed.includes(dept))) return true;
  // Legacy: assigned ground team member can still act on stages they own
  if (consignment?.groundTeamUserId && consignment.groundTeamUserId === user.id) {
    return ['packing_completed', 'ready_for_dispatch', 'dispatched'].includes(stage);
  }
  return false;
}

function userInDepartment(user, departmentKey) {
  const dept = normalizeDepartment(departmentKey);
  if (!dept) return false;
  return getUserDepartments(user).includes(dept);
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
  normalizeDepartments,
  getUserDepartments,
  resolveUserDepartments,
  departmentLabel,
  departmentLabels,
  userCanConfirmStage,
  userInDepartment,
  listDepartmentOptions,
};
