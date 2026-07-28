/**
 * Ground-team workflow + Org Head reporting routes.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePermission, requireAnyPermission } = require('../utils/permissions');
const { firestoreHelpers, now, addAuditLog } = require('../utils/helpers');
const { emitConsignmentChange } = require('../utils/syncBus');
const { sendViaMailgun, isMailgunConfigured } = require('../utils/mailgun');
const {
  buildWorkflowEmail,
  buildWeeklyReportEmail,
  escapeHtml,
} = require('../utils/emailTemplates');
const {
  STAGE_ORDER,
  STAGE_LABELS,
  buildTatDeadlines,
  applyStageConfirmation,
  enrichWorkflowFields,
  buildWeeklyReportSummary,
  getOverdueStages,
  canAdvanceLogistics,
  sortConsignmentsByWorkflowPriority,
  normalizeDepartment,
} = require('../utils/consignmentWorkflow');
const {
  userCanConfirmStage,
  departmentLabel,
  departmentLabels,
  listDepartmentOptions,
  getUserDepartments,
  userInDepartment,
  NEXT_ASSIGNMENT_DEPARTMENT,
} = require('../utils/departments');
const {
  notifyTaskflowStages,
  resyncConsignmentToTaskflow,
  getTaskflowStatus,
} = require('../utils/taskflowBridge');

/** Prevent duplicate Org Head emails within the same UTC calendar day */
let lastWeeklyReportKey = null;
const TAT_REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000; // ~once per day while overdue

async function getUserEmail(userId) {
  if (!userId) return null;
  const user = await firestoreHelpers.getDocument('users', userId);
  if (!user || user.isActive === false) return null;
  const departments = getUserDepartments(user);
  return {
    email: user.email,
    name: user.name || user.email,
    id: user.id,
    role: user.role,
    department: departments[0] || null,
    departments,
  };
}

async function listUsersByDepartment(departmentKey) {
  const dept = normalizeDepartment(departmentKey);
  if (!dept) return [];
  const users = await firestoreHelpers.getCollection('users');
  return users.filter(
    (u) => u.isActive !== false
      && u.email
      && (userInDepartment(u, dept) || (dept === 'management' && ['admin', 'organization_head'].includes(u.role)))
  );
}

async function autoAssignDepartment(consignmentId, consignment, departmentKey, actor) {
  const candidates = await listUsersByDepartment(departmentKey);
  if (!candidates.length) {
    return {
      ok: false,
      reason: `No active users in ${departmentLabel(departmentKey) || departmentKey}`,
      department: departmentKey,
    };
  }
  // Prefer an already-assigned person in that department; else first candidate
  const preferred = candidates.find((u) => u.id === consignment.groundTeamUserId) || candidates[0];
  const assignedAt = now();
  const updates = {
    groundTeamUserId: preferred.id,
    groundTeamName: preferred.name || preferred.email,
    groundTeamEmail: preferred.email,
    assignedAt,
    assignedByUserId: actor?.id || 'system',
    assignedDepartment: departmentKey,
    assignedDepartmentLabel: departmentLabel(departmentKey),
    departmentAssignedAt: assignedAt,
    updatedAt: assignedAt,
  };
  await firestoreHelpers.setDocument('consignments', consignmentId, updates);
  await addAuditLog('auto_assign_department', 'consignment', consignmentId, actor?.id || 'system', {
    department: departmentKey,
    userId: preferred.id,
    userName: preferred.name,
  });
  return {
    ok: true,
    assignee: preferred,
    updates,
    notifiedUsers: candidates,
  };
}

async function listManagementEmails() {
  const users = await firestoreHelpers.getCollection('users');
  const heads = users.filter((u) => u.role === 'organization_head' && u.email && u.isActive !== false);
  const admins = users.filter((u) => u.role === 'admin' && u.email && u.isActive !== false);
  const preferred = heads.length ? heads : admins;
  return preferred.map((u) => ({ email: u.email, name: u.name || u.email, role: u.role }));
}

async function notifyUser({ to, subject, html, text, tags = ['workflow'] }) {
  if (!isMailgunConfigured()) {
    console.warn(`[WorkflowEmail] Skipped (Mailgun not configured): ${subject} → ${to}`);
    return { ok: false, reason: 'Mailgun not configured' };
  }
  if (!to) {
    return { ok: false, reason: 'No recipient' };
  }
  try {
    await sendViaMailgun({ to, subject, html, text, tags });
    return { ok: true };
  } catch (error) {
    console.error('[WorkflowEmail] FAILED', subject, to, error.message);
    return { ok: false, reason: error.message };
  }
}

async function notifyMany(recipients, payload) {
  const unique = [...new Set((recipients || []).map((r) => (typeof r === 'string' ? r : r?.email)).filter(Boolean))];
  const results = [];
  for (const to of unique) {
    results.push(await notifyUser({ ...payload, to }));
  }
  return results;
}

/** Assign / reassign ground team member */
router.post('/:id/assign-ground-team', authenticateToken, requireAnyPermission(['consignments', 'users'], 'assign ground team'), async (req, res) => {
  try {
    const consignment = await firestoreHelpers.getDocument('consignments', req.params.id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found.' });

    const { userId, tatHours } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const assignee = await getUserEmail(userId);
    if (!assignee) return res.status(404).json({ error: 'Ground team user not found.' });

    const assignedAt = now();
    const updates = {
      groundTeamUserId: assignee.id,
      groundTeamName: assignee.name,
      groundTeamEmail: assignee.email,
      assignedAt,
      assignedByUserId: req.user.id,
      tatDeadlines: buildTatDeadlines(assignedAt, tatHours || undefined),
      stageConfirmations: consignment.stageConfirmations || undefined,
      isEscalated: false,
      escalationLevel: 0,
      updatedAt: assignedAt,
    };

    const next = { ...consignment, ...updates };
    await firestoreHelpers.setDocument('consignments', consignment.id, updates);
    await addAuditLog('assign_ground_team', 'consignment', consignment.id, req.user.id, {
      groundTeamUserId: assignee.id,
      groundTeamName: assignee.name,
    });
    const enriched = enrichWorkflowFields(next);
    emitConsignmentChange(enriched);

    const mail = buildWorkflowEmail({
      title: 'Ground team assignment',
      headline: 'You were assigned as ground team',
      intro: 'You are responsible for confirming each consignment stage on time. Invoice and dispatch only proceed after packing is confirmed.',
      consignment: enriched,
      stageLabel: 'Ownership assigned — confirm packing when complete',
      badge: 'Action required',
      accent: '#0f172a',
      extraHtml: `<p style="margin:0 0 16px;font-size:13px;color:#475569;line-height:1.6">Track TAT for every stage in the app. Delayed consignments are escalated automatically to Organization Head / management.</p>`,
    });
    const assignMail = await notifyUser({
      ...mail,
      to: assignee.email,
      tags: ['workflow', 'assign'],
    });
    if (!assignMail.ok) {
      console.warn('[assign-ground-team] Email not delivered:', assignMail.reason);
    }

    res.json({ consignment: enriched, emailSent: assignMail.ok });
  } catch (error) {
    console.error('[assign-ground-team]', error);
    res.status(500).json({ error: error.message });
  }
});

/** Ground team confirms a workflow stage */
router.post('/:id/confirm-stage', authenticateToken, requirePermission('consignments', 'confirm workflow stage'), async (req, res) => {
  try {
    const consignment = await firestoreHelpers.getDocument('consignments', req.params.id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found.' });

    const {
      stage,
      note,
      approve_invoice_exception: approveInvoiceException,
      ...stagePayload
    } = req.body || {};
    if (!stage) return res.status(400).json({ error: 'stage is required.' });

    const isAdmin = req.user.role === 'admin';
    if (!userCanConfirmStage(req.user, stage, consignment) && !isAdmin) {
      return res.status(403).json({
        error: 'Your department is not authorized to confirm this workflow stage.',
        code: 'DEPARTMENT_FORBIDDEN',
        requiredDepartments: require('../utils/departments').STAGE_DEPARTMENTS[stage] || [],
      });
    }

    if (
      (stage === 'ready_for_dispatch' || stage === 'dispatched')
      && consignment.dispatchBlockedForInvoiceMismatch
      && !consignment.invoiceMismatchExceptionApproved
    ) {
      if (approveInvoiceException && isAdmin) {
        await firestoreHelpers.setDocument('consignments', consignment.id, {
          invoiceMismatchExceptionApproved: true,
          invoiceMismatchExceptionApprovedBy: req.user.id,
          invoiceMismatchExceptionApprovedAt: new Date().toISOString(),
          dispatchBlockedForInvoiceMismatch: false,
          updatedAt: new Date().toISOString(),
        });
        consignment.invoiceMismatchExceptionApproved = true;
        consignment.dispatchBlockedForInvoiceMismatch = false;
      } else {
        return res.status(409).json({
          error: 'Dispatch is blocked until invoice quantity matches final packed quantity after a post-packing removal. An admin can approve an exception.',
          code: 'INVOICE_QTY_MISMATCH',
        });
      }
    }

    const result = applyStageConfirmation(consignment, stage, req.user, note, stagePayload);
    if (!result.ok) {
      return res.status(409).json({
        error: result.error,
        code: result.code,
        requiredStage: result.requiredStage,
        plannedQty: result.plannedQty,
        packedQty: result.packedQty,
        shortQty: result.shortQty,
      });
    }

    await firestoreHelpers.setDocument('consignments', consignment.id, result.updates);
    let merged = { ...consignment, ...result.updates };

    // Auto-assign next department owners (invoice / dispatch / inward)
    let autoAssign = null;
    const nextDept = result.assignDepartment || NEXT_ASSIGNMENT_DEPARTMENT[stage];
    if (nextDept && !merged.isArchived && merged.operationalStatus !== 'archived') {
      autoAssign = await autoAssignDepartment(consignment.id, merged, nextDept, req.user);
      if (autoAssign.ok) {
        merged = { ...merged, ...autoAssign.updates };
      }
    }

    const next = enrichWorkflowFields(merged);
    await addAuditLog('confirm_stage', 'consignment', consignment.id, req.user.id, {
      stage,
      note: note || null,
      details: result.updates.stageConfirmations?.[stage]?.details || null,
      autoStages: result.autoStages || [],
      assignedDepartment: nextDept || null,
    });
    emitConsignmentChange(next);

    const taskflowStages = [stage, ...(result.autoStages || [])];
    notifyTaskflowStages(next, taskflowStages, {
      note: note || `Confirmed in Packing: ${STAGE_LABELS[stage] || stage}`,
    });

    const mail = buildWorkflowEmail({
      title: 'Stage confirmed',
      headline: `${STAGE_LABELS[stage] || stage} confirmed`,
      intro: `Confirmed by ${escapeHtml(req.user.name || req.user.email || 'team member')}. Consignment workflow has been updated automatically.`,
      consignment: next,
      stageLabel: STAGE_LABELS[stage] || stage,
      badge: next.pendingAction ? 'Next action pending' : 'Stage complete',
      accent: '#047857',
      extraHtml: [
        next.pendingAction
          ? `<p style="margin:0 0 16px;font-size:13px;color:#b45309;line-height:1.6"><strong>Next required action:</strong> ${escapeHtml(next.pendingAction)}</p>`
          : '',
        next.assignedDepartmentLabel
          ? `<p style="margin:0 0 16px;font-size:13px;color:#475569;line-height:1.6"><strong>Assigned department:</strong> ${escapeHtml(next.assignedDepartmentLabel)}</p>`
          : '',
      ].join(''),
    });

    const recipients = [];
    if (autoAssign?.ok && autoAssign.notifiedUsers?.length) {
      recipients.push(...autoAssign.notifiedUsers.map((u) => u.email));
    } else if (next.groundTeamEmail) {
      recipients.push(next.groundTeamEmail);
    }
    const managers = await listManagementEmails();
    recipients.push(...managers.map((m) => m.email));
    const emailResults = await notifyMany(recipients, { ...mail, tags: ['workflow', 'stage-confirm'] });

    res.json({
      consignment: next,
      stage,
      autoStages: result.autoStages || [],
      assignedDepartment: nextDept || null,
      autoAssign: autoAssign
        ? { ok: autoAssign.ok, reason: autoAssign.reason || null, userId: autoAssign.assignee?.id || null }
        : null,
      emailSent: emailResults.some((r) => r.ok),
    });
  } catch (error) {
    console.error('[confirm-stage]', error);
    res.status(500).json({ error: error.message });
  }
});

/** Management visibility feed */
router.get('/management-board', authenticateToken, requireAnyPermission(['consignments', 'productivity'], 'view management board'), async (req, res) => {
  try {
    const all = await firestoreHelpers.getCollection('consignments');
    const enriched = sortConsignmentsByWorkflowPriority(all.map(enrichWorkflowFields));
    const pending = enriched.filter((c) => c.listPriorityBucket !== 'shipped' && c.listPriorityBucket !== 'inwarded');
    const delayed = enriched.filter((c) => c.isTatOverdue || c.isEscalated);
    res.json({
      summary: {
        total: enriched.length,
        needingAction: pending.length,
        delayed: delayed.length,
        escalated: enriched.filter((c) => c.isEscalated).length,
      },
      consignments: enriched,
      delayed,
    });
  } catch (error) {
    console.error('[management-board]', error);
    res.status(500).json({ error: error.message });
  }
});

/** Organization Head dashboard summary */
router.get('/org-head/summary', authenticateToken, requireRole('admin', 'organization_head'), async (req, res) => {
  try {
    const all = await firestoreHelpers.getCollection('consignments');
    const report = buildWeeklyReportSummary(all);
    const enriched = sortConsignmentsByWorkflowPriority(all.map(enrichWorkflowFields));
    res.json({
      report,
      buckets: {
        new: enriched.filter((c) => c.listPriorityBucket === 'new').length,
        active: enriched.filter((c) => c.listPriorityBucket === 'active').length,
        packed_pending_invoice: enriched.filter((c) => c.listPriorityBucket === 'packed_pending_invoice').length,
        ready_for_dispatch: enriched.filter((c) => c.listPriorityBucket === 'ready_for_dispatch').length,
        shipped: enriched.filter((c) => c.listPriorityBucket === 'shipped').length,
        inwarded: enriched.filter((c) => c.listPriorityBucket === 'inwarded').length,
      },
      recentDelayed: report.delayedItems,
    });
  } catch (error) {
    console.error('[org-head/summary]', error);
    res.status(500).json({ error: error.message });
  }
});

/** Manual weekly report send (also used by cron) */
router.post('/org-head/send-weekly-report', authenticateToken, requireRole('admin', 'organization_head'), async (req, res) => {
  try {
    const result = await sendWeeklyOrgHeadReport(req.body?.emails, { force: true });
    res.json(result);
  } catch (error) {
    console.error('[org-head/send-weekly-report]', error);
    res.status(500).json({ error: error.message });
  }
});

async function sendWeeklyOrgHeadReport(extraEmails = [], { force = false } = {}) {
  if (!isMailgunConfigured()) {
    return { ok: false, reason: 'Mailgun not configured' };
  }

  const d = new Date();
  const dayKey = d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  if (!force && lastWeeklyReportKey === dayKey) {
    return { ok: true, skipped: true, reason: 'Org Head report already sent today', dayKey };
  }

  const all = await firestoreHelpers.getCollection('consignments');
  const report = buildWeeklyReportSummary(all);
  const managers = await listManagementEmails();
  const recipients = [
    ...managers.map((m) => m.email),
    ...(Array.isArray(extraEmails) ? extraEmails : []),
  ].filter(Boolean);

  if (!recipients.length) {
    return { ok: false, reason: 'No organization_head or admin users with email', report };
  }

  const mail = buildWeeklyReportEmail(report);
  const results = await notifyMany(recipients, { ...mail, tags: ['workflow', 'weekly-report'] });
  const anyOk = results.some((r) => r.ok);
  if (anyOk) lastWeeklyReportKey = dayKey;

  return {
    ok: anyOk,
    recipients: [...new Set(recipients)],
    report,
    results,
    dayKey,
    reason: anyOk ? undefined : (results[0]?.reason || 'All sends failed'),
  };
}

/** Scan TAT breaches → remind assignee + escalate to org heads/admins */
async function processTatRemindersAndEscalations() {
  if (!isMailgunConfigured()) {
    console.warn('[Workflow] TAT check skipped — Mailgun not configured');
    return { reminded: 0, escalated: 0, skipped: true, reason: 'Mailgun not configured' };
  }

  const all = await firestoreHelpers.getCollection('consignments');
  const managers = await listManagementEmails();
  let reminded = 0;
  let escalated = 0;
  let emailFailures = 0;

  for (const raw of all) {
    const c = enrichWorkflowFields(raw);
    if (c.listPriorityBucket === 'shipped' || c.listPriorityBucket === 'inwarded') continue;
    const overdue = getOverdueStages(c);
    if (!overdue.length) continue;

    const reason = overdue.map((o) => o.label).join(', ');
    const level = overdue.length >= 2 || (overdue[0]?.overdueMs || 0) > 24 * 60 * 60 * 1000 ? 2 : 1;
    const lastReminderMs = c.lastTatReminderAt ? new Date(c.lastTatReminderAt).getTime() : 0;
    const canRemind = !lastReminderMs || (Date.now() - lastReminderMs) >= TAT_REMINDER_COOLDOWN_MS;

    if (c.groundTeamEmail && canRemind) {
      const mail = buildWorkflowEmail({
        title: 'TAT reminder',
        headline: 'Consignment overdue — action needed',
        intro: 'This consignment has not progressed within the defined TAT. Please confirm the pending stage in the app as soon as possible.',
        consignment: c,
        stageLabel: c.pendingAction || 'Action required',
        badge: 'TAT overdue',
        accent: '#b45309',
        extraHtml: `<p style="margin:0 0 16px;font-size:13px;color:#b91c1c;line-height:1.6"><strong>Overdue stages:</strong> ${escapeHtml(reason)}</p>`,
      });
      const sent = await notifyUser({ ...mail, to: c.groundTeamEmail, tags: ['workflow', 'tat-reminder'] });
      if (sent.ok) {
        reminded += 1;
        await firestoreHelpers.setDocument('consignments', c.id, {
          lastTatReminderAt: now(),
          updatedAt: now(),
        });
      } else {
        emailFailures += 1;
      }
    }

    if (level >= 2 && !c.isEscalated) {
      await firestoreHelpers.setDocument('consignments', c.id, {
        isEscalated: true,
        escalationLevel: 2,
        escalatedAt: now(),
        escalationReason: reason,
        escalatedToRole: 'organization_head',
        updatedAt: now(),
      });
      escalated += 1;

      const escMail = buildWorkflowEmail({
        title: 'Escalation',
        headline: 'Escalated consignment — management attention',
        intro: 'This consignment exceeded TAT and has been escalated automatically to Organization Head / management.',
        consignment: { ...c, isEscalated: true },
        stageLabel: c.pendingAction || '—',
        badge: 'Escalated',
        accent: '#b91c1c',
        extraHtml: `
          <p style="margin:0 0 8px;font-size:13px;color:#475569"><strong>Assignee:</strong> ${escapeHtml(c.groundTeamName || 'Unassigned')}</p>
          <p style="margin:0 0 16px;font-size:13px;color:#b91c1c"><strong>Overdue:</strong> ${escapeHtml(reason)}</p>
        `,
      });
      const escResults = await notifyMany(managers.map((m) => m.email), { ...escMail, tags: ['workflow', 'escalation'] });
      if (!escResults.some((r) => r.ok)) emailFailures += 1;
      emitConsignmentChange(enrichWorkflowFields({ ...c, isEscalated: true, escalationLevel: 2 }));
    }
  }

  return { reminded, escalated, emailFailures };
}

router.post('/run-tat-check', authenticateToken, requireRole('admin', 'organization_head'), async (req, res) => {
  try {
    const result = await processTatRemindersAndEscalations();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stages', authenticateToken, (req, res) => {
  res.json({
    stages: STAGE_ORDER.map((key) => ({ key, label: STAGE_LABELS[key] })),
  });
});

/** Active users selectable as ground-team assignees */
router.get('/assignees', authenticateToken, requireAnyPermission(['consignments', 'users'], 'list assignees'), async (req, res) => {
  try {
    const { department } = req.query || {};
    const deptFilter = normalizeDepartment(department);
    const users = await firestoreHelpers.getCollection('users');
    const list = users
      .filter((u) => u.isActive !== false && u.email)
      .filter((u) => !deptFilter || userInDepartment(u, deptFilter))
      .map((u) => {
        const departments = getUserDepartments(u);
        return {
          id: u.id,
          name: u.name || u.email,
          email: u.email,
          role: u.role || 'user',
          department: departments[0] || null,
          departments,
          departmentLabel: departments[0] ? departmentLabel(departments[0]) : null,
          departmentLabels: departmentLabels(departments),
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ users: list, departments: listDepartmentOptions() });
  } catch (error) {
    console.error('[workflow/assignees]', error);
    res.status(500).json({ error: error.message });
  }
});

/** Department catalog for user management + workflow UI */
router.get('/departments', authenticateToken, (_req, res) => {
  res.json({ departments: listDepartmentOptions() });
});

/** TaskFlow Pro integration status (admin) */
router.get('/taskflow/status', authenticateToken, requireRole('admin'), (_req, res) => {
  res.json({ taskflow: getTaskflowStatus() });
});

/** Resync one consignment into TaskFlow (admin) — create/advance to match packing stages */
router.post('/:id/taskflow-resync', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const consignment = await firestoreHelpers.getDocument('consignments', req.params.id);
    if (!consignment) return res.status(404).json({ error: 'Consignment not found.' });
    const result = await resyncConsignmentToTaskflow(enrichWorkflowFields(consignment));
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'TaskFlow resync failed' });
    }
    await addAuditLog('taskflow_resync', 'consignment', consignment.id, req.user.id, {
      workflowId: result.createdResult?.workflowId || result.stagesResult?.workflowId || null,
      confirmedStages: result.confirmedStages || [],
    });
    const refreshed = await firestoreHelpers.getDocument('consignments', consignment.id);
    res.json({
      ok: true,
      result,
      consignment: enrichWorkflowFields(refreshed || consignment),
    });
  } catch (error) {
    console.error('[taskflow-resync]', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  sendWeeklyOrgHeadReport,
  processTatRemindersAndEscalations,
  canAdvanceLogistics,
  enrichWorkflowFields,
  sortConsignmentsByWorkflowPriority,
};
