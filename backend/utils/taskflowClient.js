/**
 * Low-level TaskFlow Pro client (Supabase PostgREST).
 * One-way: Consignment Packing → TaskFlow create / advance.
 *
 * Auth: TaskFlow project service-role key (bypasses RLS for S2S).
 */
const crypto = require('crypto');

function getConfig() {
  const enabledRaw = String(process.env.TASKFLOW_ENABLED || '').trim();
  // Accept true / 1 / "true" (quoted secret values are a common GitHub Secrets mistake)
  const enabledFlag = enabledRaw.replace(/^["']|["']$/g, '').trim().toLowerCase();
  const url = String(process.env.TASKFLOW_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.TASKFLOW_SERVICE_ROLE_KEY || process.env.TASKFLOW_API_KEY || '').trim();
  const templateId = String(process.env.TASKFLOW_TEMPLATE_ID || '').trim().replace(/^["']|["']$/g, '');
  const raisedBy = String(process.env.TASKFLOW_RAISED_BY_USER_ID || '').trim().replace(/^["']|["']$/g, '');
  const webhookSecret = String(process.env.TASKFLOW_WEBHOOK_SECRET || '').trim();
  const mcpPat = String(process.env.TASKFLOW_MCP_PAT || '').trim();
  const configured = Boolean(url && serviceKey && templateId && raisedBy);
  const enabled = (enabledFlag === 'true' || enabledFlag === '1') && configured;
  return {
    url,
    serviceKey,
    templateId,
    raisedBy,
    webhookSecret,
    mcpPat,
    configured,
    enabled,
    enabledFlagRaw: enabledRaw || null,
  };
}

function isTaskflowConfigured() {
  return getConfig().configured;
}

function isTaskflowEnabled() {
  return getConfig().enabled;
}

function signBody(bodyText, secret) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(bodyText).digest('hex');
}

async function rest(path, { method = 'GET', body, prefer, query } = {}) {
  const { url, serviceKey, webhookSecret } = getConfig();
  if (!url || !serviceKey) {
    throw new Error('TaskFlow is not configured');
  }

  let endpoint = `${url}/rest/v1/${path.replace(/^\//, '')}`;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      qs.append(key, String(value));
    });
    const q = qs.toString();
    if (q) endpoint += `?${q}`;
  }

  const bodyText = body === undefined ? null : JSON.stringify(body);
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  if (bodyText && webhookSecret) {
    headers['X-TaskFlow-Signature'] = signBody(bodyText, webhookSecret);
  }

  const response = await fetch(endpoint, {
    method,
    headers,
    body: bodyText,
  });

  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data?.message
      ? data.message
      : (typeof data === 'string' ? data.slice(0, 300) : response.statusText);
    const error = new Error(`TaskFlow REST ${method} ${path} failed (${response.status}): ${message}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }

  return data;
}

async function invokeNotify(workflowId, stageId, changeType) {
  const { url, serviceKey } = getConfig();
  if (!url || !serviceKey || !workflowId || !stageId) return { skipped: true };

  try {
    const response = await fetch(`${url}/functions/v1/notify-workflow-stage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
        'x-internal-service-key': serviceKey,
      },
      body: JSON.stringify({ workflowId, stageId, changeType }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`[TaskFlow] notify-workflow-stage ${response.status}:`, text.slice(0, 200));
      return { ok: false, status: response.status };
    }
    return { ok: true };
  } catch (error) {
    console.warn('[TaskFlow] notify failed:', error.message);
    return { ok: false, error: error.message };
  }
}

async function fetchTemplate(templateId) {
  const rows = await rest('workflow_templates', {
    query: {
      id: `eq.${templateId}`,
      select: '*',
      limit: '1',
    },
  });
  let template = Array.isArray(rows) ? rows[0] : rows;
  if (!template) {
    const byName = await rest('workflow_templates', {
      query: {
        name: 'ilike.*Packing*',
        select: '*',
        order: 'created_at.desc',
        limit: '5',
      },
    });
    const list = Array.isArray(byName) ? byName : [];
    template = list.find((t) => /consignments?\s*packing/i.test(String(t.name || ''))) || list[0] || null;
    if (template) {
      console.warn(`[TaskFlow] Template id ${templateId} not found — using ${template.id} (${template.name})`);
    }
  }
  if (!template) throw new Error(`TaskFlow template not found: ${templateId}`);

  const stages = await rest('workflow_template_stages', {
    query: {
      template_id: `eq.${template.id}`,
      select: '*',
      order: 'position.asc',
    },
  });
  const fields = await rest('workflow_template_fields', {
    query: {
      template_id: `eq.${template.id}`,
      select: '*',
      order: 'position.asc',
    },
  });

  return {
    template,
    stages: Array.isArray(stages) ? stages : [],
    fields: Array.isArray(fields) ? fields : [],
  };
}

async function findWorkflowByConsignmentId(consignmentId) {
  const key = String(consignmentId || '').trim();
  if (!key) return null;

  const values = await rest('workflow_field_values', {
    query: {
      field_key: 'eq.consignment_id',
      value: `eq.${key}`,
      select: 'workflow_id,value',
      limit: '5',
    },
  });
  const workflowId = Array.isArray(values) && values[0]?.workflow_id ? values[0].workflow_id : null;
  if (!workflowId) return null;
  return getWorkflow(workflowId);
}

async function getWorkflow(workflowId) {
  const rows = await rest('workflows', {
    query: {
      id: `eq.${workflowId}`,
      select: '*',
      limit: '1',
    },
  });
  const wf = Array.isArray(rows) ? rows[0] : rows;
  if (!wf) return null;

  const stages = await rest('workflow_stages', {
    query: {
      workflow_id: `eq.${workflowId}`,
      select: '*',
      order: 'position.asc',
    },
  });
  return { ...wf, stages: Array.isArray(stages) ? stages : [] };
}

async function upsertFieldValues(workflowId, fields) {
  if (!workflowId || !Array.isArray(fields) || fields.length === 0) return;
  for (const field of fields) {
    if (!field?.field_key) continue;
    const value = String(field.value ?? '').trim();
    if (!value) continue;
    const existing = await rest('workflow_field_values', {
      query: {
        workflow_id: `eq.${workflowId}`,
        field_key: `eq.${field.field_key}`,
        select: 'id',
        limit: '1',
      },
    });
    if (Array.isArray(existing) && existing[0]?.id) {
      await rest('workflow_field_values', {
        method: 'PATCH',
        query: { id: `eq.${existing[0].id}` },
        body: { value, label: field.label || field.field_key },
      });
    } else {
      await rest('workflow_field_values', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          workflow_id: workflowId,
          field_key: field.field_key,
          label: field.label || field.field_key,
          value,
        },
      });
    }
  }
}

async function findProfileByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const rows = await rest('profiles', {
    query: {
      email: `ilike.${normalized}`,
      select: 'id,name,email,department_id,active',
      limit: '5',
    },
  });
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.find((p) => String(p.email || '').trim().toLowerCase() === normalized && p.active !== false);
  return exact || list.find((p) => p.active !== false) || list[0] || null;
}

async function findProfileByNameAndEmail({ name, email }) {
  const byEmail = await findProfileByEmail(email);
  if (!byEmail) return null;
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return byEmail;
  return byEmail;
}

async function updateWorkflow(workflowId, patch) {
  if (!workflowId || !patch || typeof patch !== 'object') return null;
  await rest('workflows', {
    method: 'PATCH',
    query: { id: `eq.${workflowId}` },
    body: patch,
  });
  return getWorkflow(workflowId);
}

async function patchStageAssignee(stageId, assigneeUserId) {
  if (!stageId || !assigneeUserId) return;
  await rest('workflow_stages', {
    method: 'PATCH',
    query: { id: `eq.${stageId}` },
    body: { assignee_user_id: assigneeUserId },
  });
}

async function createWorkflowFromTemplate({
  title,
  description,
  priority = 'medium',
  consignmentId,
  consignmentNo,
  raisedByDepartmentId = null,
  stageAssignees = {},
}) {
  const { templateId, raisedBy } = getConfig();
  const { template, stages: templateStages, fields: templateFields } = await fetchTemplate(templateId);
  const resolvedTemplateId = template.id;

  if (!templateStages.length) {
    throw new Error(`TaskFlow template ${resolvedTemplateId} has no stages`);
  }

  // Ensure template is visible in TaskFlow UI.
  try {
    await rest('workflow_templates', {
      method: 'PATCH',
      query: { id: `eq.${resolvedTemplateId}` },
      body: { active: true },
    });
  } catch (_) { /* ignore */ }

  const inserted = await rest('workflows', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      template_id: resolvedTemplateId,
      title,
      description: description || '',
      priority,
      raised_by: raisedBy,
      raised_by_department_id: raisedByDepartmentId,
      current_stage_position: 1,
      status: 'active',
    },
  });
  const wf = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!wf?.id) throw new Error('TaskFlow create workflow returned no id');

  const nowIso = new Date().toISOString();
  const stageRows = templateStages.map((s, i) => {
    const position = Number(s.position) || i + 1;
    const overrideAssignee = stageAssignees[position] || stageAssignees[String(position)] || null;
    return {
      workflow_id: wf.id,
      position,
      name: s.name,
      owner_department_id: s.is_terminal ? null : (s.owner_department_id || null),
      assignee_user_id: s.is_terminal
        ? null
        : (overrideAssignee || s.assignee_user_id || null),
      tat_hours: s.default_tat_hours ?? s.tat_hours ?? 24,
      escalate_on_breach: s.escalate_on_breach !== false,
      status: i === 0 ? 'in_progress' : 'pending',
      started_at: i === 0 ? nowIso : null,
      is_decision: Boolean(s.is_decision),
      yes_next_position: s.is_decision ? (s.yes_next_position || null) : null,
      no_next_position: s.is_decision ? (s.no_next_position || null) : null,
      is_terminal: Boolean(s.is_terminal),
      outcome_label: s.is_terminal ? (s.outcome_label || null) : null,
    };
  });

  const insertedStages = await rest('workflow_stages', {
    method: 'POST',
    prefer: 'return=representation',
    body: stageRows,
  });
  const stages = Array.isArray(insertedStages) ? insertedStages : [];

  const fieldRows = [];
  fieldRows.push({
    field_key: 'consignment_id',
    label: 'Consignment ID',
    value: String(consignmentId),
  });
  if (consignmentNo) {
    fieldRows.push({
      field_key: 'consignment_no',
      label: 'Consignment No',
      value: String(consignmentNo),
    });
  }

  for (const f of templateFields || []) {
    if (!f?.field_key || f.field_key === 'reference_id') continue;
    if (f.field_key === 'consignment_id' || f.field_key === 'consignment_no') continue;
    // Prefer packing-provided values for known keys; leave other required fields empty unless defaulted.
  }

  await upsertFieldValues(wf.id, fieldRows);

  // Override auto tracking reference with business consignment number when available.
  if (consignmentNo) {
    await upsertFieldValues(wf.id, [{
      field_key: 'reference_id',
      label: 'Reference / Consignment No',
      value: String(consignmentNo),
    }]);
  }

  const firstStage = stages.find((s) => Number(s.position) === 1) || stages[0];
  if (firstStage?.id) {
    invokeNotify(wf.id, firstStage.id, 'start').catch(() => {});
  }

  return getWorkflow(wf.id);
}

/**
 * Complete current stage and move forward (mirrors TaskFlow MCP advance_workflow_stage + UI terminal handling).
 */
async function advanceWorkflowOnce(workflowId, { decision = 'yes', note = null, completedBy = null } = {}) {
  const { raisedBy, mcpPat, url, serviceKey } = getConfig();

  if (mcpPat) {
    try {
      const response = await fetch(`${url}/functions/v1/mcp-server`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mcpPat}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'advance_workflow_stage',
            arguments: {
              workflow_id: workflowId,
              decision,
              note: note || undefined,
            },
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        throw new Error(payload.error?.message || `MCP advance failed (${response.status})`);
      }
      const content = payload.result?.content;
      const text = Array.isArray(content) ? content.map((c) => c.text || '').join('') : '';
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : payload.result; } catch { parsed = payload.result; }
      return { via: 'mcp', result: parsed, workflow: await getWorkflow(workflowId) };
    } catch (mcpError) {
      console.warn('[TaskFlow] MCP advance failed, falling back to REST:', mcpError.message);
    }
  }

  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('Workflow not found');
  if (wf.status !== 'active') {
    return { via: 'rest', skipped: true, reason: 'not_active', workflow: wf };
  }

  const stage = (wf.stages || []).find((s) => Number(s.position) === Number(wf.current_stage_position));
  if (!stage) throw new Error('Current stage not found');
  if (stage.status === 'completed') {
    // Heal drift: move pointer to next incomplete stage if needed.
    const nextOpen = (wf.stages || []).find((s) => s.status !== 'completed' && !s.is_terminal);
    if (!nextOpen) {
      return { via: 'rest', skipped: true, reason: 'already_complete', workflow: wf };
    }
  }

  const nowIso = new Date().toISOString();
  const actor = completedBy || raisedBy;
  const decisionValue = stage.is_decision ? (decision || 'yes') : null;
  if (stage.is_decision && !decisionValue) {
    throw new Error('Decision stage requires yes/no');
  }

  await rest('workflow_stages', {
    method: 'PATCH',
    query: { id: `eq.${stage.id}` },
    body: {
      status: 'completed',
      completed_at: nowIso,
      completed_by: actor,
      decision: decisionValue,
      notes: note ? String(note).slice(0, 5000) : stage.notes,
    },
  });

  try {
    await rest('workflow_stage_events', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        workflow_id: wf.id,
        stage_id: stage.id,
        actor_id: actor,
        event_type: 'completed',
        to_value: decisionValue,
        note: note ? String(note).slice(0, 2000) : null,
      },
    });
  } catch (_) { /* optional table / RLS */ }

  let nextPosition = null;
  if (stage.is_terminal) {
    nextPosition = null;
  } else if (stage.is_decision) {
    nextPosition = decisionValue === 'yes' ? stage.yes_next_position : stage.no_next_position;
    if (nextPosition == null) nextPosition = Number(stage.position) + 1;
  } else {
    nextPosition = Number(stage.position) + 1;
  }

  const nextStage = nextPosition != null
    ? (wf.stages || []).find((s) => Number(s.position) === Number(nextPosition))
    : null;

  if (nextStage?.is_terminal) {
    await rest('workflow_stages', {
      method: 'PATCH',
      query: { id: `eq.${nextStage.id}` },
      body: {
        status: 'completed',
        started_at: nowIso,
        completed_at: nowIso,
        completed_by: actor,
      },
    });
    await rest('workflows', {
      method: 'PATCH',
      query: { id: `eq.${wf.id}` },
      body: {
        status: 'completed',
        completed_at: nowIso,
        current_stage_position: nextStage.position,
        outcome_label: nextStage.outcome_label || 'Completed',
      },
    });
    invokeNotify(wf.id, nextStage.id, 'completed').catch(() => {});
  } else if (nextStage) {
    await rest('workflow_stages', {
      method: 'PATCH',
      query: { id: `eq.${nextStage.id}` },
      body: { status: 'in_progress', started_at: nowIso },
    });
    await rest('workflows', {
      method: 'PATCH',
      query: { id: `eq.${wf.id}` },
      body: { current_stage_position: nextStage.position },
    });
    invokeNotify(wf.id, nextStage.id, 'advance').catch(() => {});
  } else {
    await rest('workflows', {
      method: 'PATCH',
      query: { id: `eq.${wf.id}` },
      body: {
        status: 'completed',
        completed_at: nowIso,
        outcome_label: stage.is_decision
          ? (decisionValue === 'yes' ? 'Successful' : 'Unsuccessful')
          : 'Completed',
      },
    });
    invokeNotify(wf.id, stage.id, stage.is_decision && decisionValue === 'no' ? 'rejected' : 'completed').catch(() => {});
  }

  // silence unused serviceKey when MCP path unused
  void serviceKey;

  return {
    via: 'rest',
    completedStage: stage.name,
    completedPosition: stage.position,
    nextStagePosition: nextStage && !nextStage.is_terminal ? nextStage.position : null,
    workflow: await getWorkflow(wf.id),
  };
}

async function advanceWorkflowThroughPosition(workflowId, targetPosition, options = {}) {
  const target = Number(targetPosition);
  if (!Number.isFinite(target) || target < 1) {
    return { skipped: true, reason: 'invalid_target' };
  }

  const advances = [];
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const wf = await getWorkflow(workflowId);
    if (!wf) throw new Error('Workflow not found');
    if (wf.status !== 'active') {
      return { ok: true, advances, workflow: wf, stopped: 'not_active' };
    }

    const currentPos = Number(wf.current_stage_position) || 1;
    const currentStage = (wf.stages || []).find((s) => Number(s.position) === currentPos);
    if (!currentStage) {
      return { ok: true, advances, workflow: wf, stopped: 'no_current_stage' };
    }

    // Already past the target (current open stage is after target).
    if (currentPos > target) {
      return { ok: true, advances, workflow: wf, stopped: 'already_past_target' };
    }

    // Target stage already completed and pointer still on it — heal by advancing once more if needed.
    if (currentPos === target && currentStage.status === 'completed') {
      return { ok: true, advances, workflow: wf, stopped: 'target_already_completed' };
    }

    const stepNote = typeof options.noteForPosition === 'function'
      ? options.noteForPosition(currentPos, currentStage)
      : options.note;

    // Need to complete current stage (currentPos <= target).
    const step = await advanceWorkflowOnce(workflowId, {
      ...options,
      note: stepNote,
    });
    advances.push(step);
    if (step.skipped) break;

    const after = step.workflow || await getWorkflow(workflowId);
    const afterPos = Number(after?.current_stage_position) || currentPos;
    if (after?.status !== 'active') {
      return { ok: true, advances, workflow: after, stopped: 'completed' };
    }
    // Completed the target stage when we finished position === target.
    if (Number(step.completedPosition) >= target) {
      return { ok: true, advances, workflow: after, stopped: 'reached_target' };
    }
    if (afterPos === currentPos && !step.skipped) {
      // Safety: no progress
      break;
    }
  }

  return { ok: true, advances, workflow: await getWorkflow(workflowId), stopped: 'guard' };
}

module.exports = {
  getConfig,
  isTaskflowConfigured,
  isTaskflowEnabled,
  fetchTemplate,
  findWorkflowByConsignmentId,
  getWorkflow,
  createWorkflowFromTemplate,
  advanceWorkflowOnce,
  advanceWorkflowThroughPosition,
  upsertFieldValues,
  invokeNotify,
  findProfileByEmail,
  findProfileByNameAndEmail,
  updateWorkflow,
  patchStageAssignee,
};
