/**
 * Ensure TaskFlow "Consignments Packing" template exists with the 5 stages
 * the packing app advances (Creation → Packing → Invoice → Dispatch → Inward).
 *
 * Uses TASKFLOW_* env (same as Cloud Run / GitHub Secrets).
 *
 * Run:
 *   node backend/scripts/ensure-taskflow-template.js
 */
const EXPECTED_STAGES = [
  { position: 1, name: 'Consignment Creation', default_tat_hours: 24 },
  { position: 2, name: 'Consignment Packing', default_tat_hours: 24 },
  { position: 3, name: 'Invoice Creation', default_tat_hours: 24 },
  { position: 4, name: 'Dispatched / Outward', default_tat_hours: 24 },
  { position: 5, name: 'Inwarding', default_tat_hours: 24 },
];

const EXPECTED_FIELDS = [
  { position: 1, label: 'Consignment ID', field_key: 'consignment_id', field_type: 'text', required: false },
  { position: 2, label: 'Consignment No', field_key: 'consignment_no', field_type: 'text', required: false },
];

function getConfig() {
  const enabledRaw = String(process.env.TASKFLOW_ENABLED || '').trim();
  const enabledFlag = enabledRaw.replace(/^["']|["']$/g, '').trim().toLowerCase();
  const url = String(process.env.TASKFLOW_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.TASKFLOW_SERVICE_ROLE_KEY || process.env.TASKFLOW_API_KEY || '').trim();
  const templateId = String(process.env.TASKFLOW_TEMPLATE_ID || '').trim().replace(/^["']|["']$/g, '');
  const raisedBy = String(process.env.TASKFLOW_RAISED_BY_USER_ID || '').trim().replace(/^["']|["']$/g, '');
  return {
    url,
    serviceKey,
    templateId,
    raisedBy,
    enabled: enabledFlag === 'true' || enabledFlag === '1',
    enabledRaw,
  };
}

async function rest(cfg, path, { method = 'GET', body, prefer, query } = {}) {
  let endpoint = `${cfg.url}/rest/v1/${path.replace(/^\//, '')}`;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v == null) return;
      qs.append(k, String(v));
    });
    const q = qs.toString();
    if (q) endpoint += `?${q}`;
  }
  const headers = {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const msg = typeof data === 'object' && data?.message ? data.message : text.slice(0, 300);
    throw new Error(`TaskFlow REST ${method} ${path} failed (${response.status}): ${msg}`);
  }
  return data;
}

async function fetchTemplate(cfg, id) {
  const rows = await rest(cfg, 'workflow_templates', {
    query: { id: `eq.${id}`, select: '*', limit: '1' },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function fetchStages(cfg, templateId) {
  const rows = await rest(cfg, 'workflow_template_stages', {
    query: {
      template_id: `eq.${templateId}`,
      select: 'id,position,name,default_tat_hours,is_terminal',
      order: 'position.asc',
    },
  });
  return Array.isArray(rows) ? rows : [];
}

function stagesLookGood(stages) {
  if (!Array.isArray(stages) || stages.length < 5) return false;
  // First 5 non-terminal (or any 5) positions should exist.
  for (let i = 1; i <= 5; i += 1) {
    if (!stages.some((s) => Number(s.position) === i)) return false;
  }
  return true;
}

async function createTemplate(cfg) {
  if (!cfg.raisedBy) {
    throw new Error('TASKFLOW_RAISED_BY_USER_ID is required to create a template');
  }
  const inserted = await rest(cfg, 'workflow_templates', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name: 'Consignments Packing',
      category: 'Operations',
      description: 'Auto template for Consignment Packing app — Creation → Packing → Invoice → Dispatch → Inward.',
      created_by: cfg.raisedBy,
      active: true,
    },
  });
  const template = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!template?.id) throw new Error('Template create returned no id');

  const stageRows = EXPECTED_STAGES.map((s) => ({
    template_id: template.id,
    position: s.position,
    name: s.name,
    description: null,
    default_tat_hours: s.default_tat_hours,
    escalate_on_breach: true,
    is_decision: false,
    yes_next_position: null,
    no_next_position: null,
    is_terminal: false,
    outcome_label: null,
  }));
  await rest(cfg, 'workflow_template_stages', {
    method: 'POST',
    prefer: 'return=minimal',
    body: stageRows,
  });

  await rest(cfg, 'workflow_template_fields', {
    method: 'POST',
    prefer: 'return=minimal',
    body: EXPECTED_FIELDS.map((f) => ({ ...f, template_id: template.id })),
  });

  return template;
}

async function repairStages(cfg, templateId, existingStages) {
  if (stagesLookGood(existingStages)) return existingStages;

  // Replace stages for a clean 5-step packing map.
  if (existingStages.length) {
    await rest(cfg, 'workflow_template_stages', {
      method: 'DELETE',
      query: { template_id: `eq.${templateId}` },
    });
  }
  await rest(cfg, 'workflow_template_stages', {
    method: 'POST',
    prefer: 'return=minimal',
    body: EXPECTED_STAGES.map((s) => ({
      template_id: templateId,
      position: s.position,
      name: s.name,
      description: null,
      default_tat_hours: s.default_tat_hours,
      escalate_on_breach: true,
      is_decision: false,
      yes_next_position: null,
      no_next_position: null,
      is_terminal: false,
      outcome_label: null,
    })),
  });

  // Ensure consignment field keys exist (best-effort).
  try {
    const fields = await rest(cfg, 'workflow_template_fields', {
      query: { template_id: `eq.${templateId}`, select: 'field_key' },
    });
    const keys = new Set((Array.isArray(fields) ? fields : []).map((f) => f.field_key));
    const missing = EXPECTED_FIELDS.filter((f) => !keys.has(f.field_key));
    if (missing.length) {
      await rest(cfg, 'workflow_template_fields', {
        method: 'POST',
        prefer: 'return=minimal',
        body: missing.map((f) => ({ ...f, template_id: templateId })),
      });
    }
  } catch (error) {
    console.warn('[ensure-taskflow-template] field upsert skipped:', error.message);
  }

  return fetchStages(cfg, templateId);
}

async function activateTemplate(cfg, templateId, template) {
  const patch = { active: true };
  if (!template?.name || /cosigment|consigment/i.test(template.name)) {
    patch.name = 'Consignments Packing';
  }
  if (!template?.category) patch.category = 'Operations';
  if (!template?.description) {
    patch.description = 'Auto-linked from Consignment Packing app (create → packing → invoice → dispatch → inward).';
  }
  await rest(cfg, 'workflow_templates', {
    method: 'PATCH',
    query: { id: `eq.${templateId}` },
    body: patch,
  });
  console.log('[ensure-taskflow-template] Template forced active=true for UI visibility');
}

async function smokeCreateWorkflow(cfg, templateId, stages) {
  if (!cfg.raisedBy) {
    console.warn('[ensure-taskflow-template] skip smoke workflow — no RAISED_BY');
    return null;
  }

  // Avoid duplicates: look for an existing smoke title from today.
  const title = `Packing bridge smoke · ${new Date().toISOString().slice(0, 10)}`;
  const existing = await rest(cfg, 'workflows', {
    query: {
      title: `eq.${title}`,
      select: 'id,tracking_number,status,title',
      limit: '1',
    },
  });
  if (Array.isArray(existing) && existing[0]?.id) {
    console.log('[ensure-taskflow-template] Smoke workflow already exists:', existing[0].tracking_number || existing[0].id);
    return existing[0];
  }

  const inserted = await rest(cfg, 'workflows', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      template_id: templateId,
      title,
      description: 'Deploy smoke test from consignment packing bridge. Safe to delete.',
      priority: 'low',
      raised_by: cfg.raisedBy,
      current_stage_position: 1,
      status: 'active',
    },
  });
  const wf = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!wf?.id) throw new Error('Smoke workflow create returned no id');

  const nowIso = new Date().toISOString();
  const stageRows = (stages || []).slice(0, 5).map((s, i) => ({
    workflow_id: wf.id,
    position: Number(s.position) || i + 1,
    name: s.name,
    owner_department_id: null,
    assignee_user_id: null,
    tat_hours: 24,
    escalate_on_breach: true,
    status: i === 0 ? 'in_progress' : 'pending',
    started_at: i === 0 ? nowIso : null,
    is_decision: false,
    is_terminal: false,
  }));
  if (stageRows.length) {
    await rest(cfg, 'workflow_stages', {
      method: 'POST',
      prefer: 'return=minimal',
      body: stageRows,
    });
  }

  await rest(cfg, 'workflow_field_values', {
    method: 'POST',
    prefer: 'return=minimal',
    body: [
      { workflow_id: wf.id, field_key: 'consignment_id', label: 'Consignment ID', value: 'SMOKE-TEST' },
      { workflow_id: wf.id, field_key: 'consignment_no', label: 'Consignment No', value: 'SMOKE-TEST' },
    ],
  });

  const refreshed = await rest(cfg, 'workflows', {
    query: { id: `eq.${wf.id}`, select: 'id,tracking_number,status,title', limit: '1' },
  });
  const row = Array.isArray(refreshed) ? refreshed[0] : refreshed;
  console.log('[ensure-taskflow-template] Smoke workflow created:', row?.tracking_number || wf.id);
  return row || wf;
}

async function main() {
  const cfg = getConfig();
  if (!cfg.enabled) {
    console.log('[ensure-taskflow-template] TASKFLOW_ENABLED is not true — skipped. raw=', JSON.stringify(cfg.enabledRaw));
    return;
  }
  if (!cfg.url || !cfg.serviceKey) {
    console.error('[ensure-taskflow-template] Missing TASKFLOW_SUPABASE_URL or TASKFLOW_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  let templateId = cfg.templateId;
  let template = templateId ? await fetchTemplate(cfg, templateId) : null;

  if (!template) {
    // Fall back: find by name in case the secret UUID drifted.
    const byName = await rest(cfg, 'workflow_templates', {
      query: {
        name: 'ilike.*Packing*',
        select: '*',
        order: 'created_at.desc',
        limit: '5',
      },
    });
    const list = Array.isArray(byName) ? byName : [];
    console.log('[ensure-taskflow-template] Lookup by id failed. id=', templateId || '(empty)', 'name matches=', list.map((t) => `${t.id}:${t.name}:active=${t.active}`).join(' | ') || '(none)');
    template = list.find((t) => /consignments?\s*packing/i.test(t.name)) || list[0] || null;
    if (template) {
      templateId = template.id;
      console.log('[ensure-taskflow-template] Using matched template:', templateId);
    }
  }

  if (!template) {
    console.log('[ensure-taskflow-template] Template id missing/not found — creating Consignments Packing…');
    template = await createTemplate(cfg);
    templateId = template.id;
    console.log('[ensure-taskflow-template] Created template id:', templateId);
    console.log('[ensure-taskflow-template] IMPORTANT: set GitHub secret TASKFLOW_TEMPLATE_ID=' + templateId);
  } else {
    console.log('[ensure-taskflow-template] Found template:', template.id, template.name || '', 'active=', template.active);
  }

  await activateTemplate(cfg, templateId, template);

  const stages = await fetchStages(cfg, templateId);
  const repaired = await repairStages(cfg, templateId, stages);
  console.log('[ensure-taskflow-template] Stages:');
  for (const s of repaired) {
    console.log(`  ${s.position}. ${s.name}${s.is_terminal ? ' (terminal)' : ''}`);
  }
  if (!stagesLookGood(repaired)) {
    throw new Error('Template still does not have positions 1–5 after repair');
  }

  const smoke = await smokeCreateWorkflow(cfg, templateId, repaired);

  console.log('[ensure-taskflow-template] OK — template ready for packing auto-create');
  console.log(JSON.stringify({
    ok: true,
    templateId,
    stageCount: repaired.length,
    smokeWorkflowId: smoke?.id || null,
    smokeTrackingNumber: smoke?.tracking_number || null,
  }));
}

main().catch((error) => {
  console.error('[ensure-taskflow-template] FAILED:', error.message);
  process.exit(1);
});
