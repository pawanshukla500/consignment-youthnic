/**
 * Live probe: create a TaskFlow workflow using the same client as packing create.
 * Run in deploy with TASKFLOW_* secrets.
 */
const {
  isTaskflowEnabled,
  getConfig,
  createWorkflowFromTemplate,
  getWorkflow,
} = require('../utils/taskflowClient');

async function main() {
  const cfg = getConfig();
  console.log('[probe-taskflow-create] enabled=', cfg.enabled, 'configured=', cfg.configured);
  console.log('[probe-taskflow-create] templateId=', cfg.templateId || '(empty)');
  console.log('[probe-taskflow-create] url=', cfg.url || '(empty)');
  console.log('[probe-taskflow-create] raisedBy=', cfg.raisedBy ? `${cfg.raisedBy.slice(0, 8)}…` : '(empty)');
  console.log('[probe-taskflow-create] enabledFlagRaw=', JSON.stringify(cfg.enabledFlagRaw));

  if (!isTaskflowEnabled()) {
    console.error('[probe-taskflow-create] FAIL — TaskFlow not enabled/configured');
    process.exit(1);
  }

  const stamp = new Date().toISOString();
  const consignmentNo = `PROBE-${stamp.slice(0, 19).replace(/[-:T]/g, '')}`;
  const wf = await createWorkflowFromTemplate({
    title: `Consignment ${consignmentNo} — live probe`,
    description: `Live probe from packing deploy at ${stamp}`,
    consignmentId: consignmentNo,
    consignmentNo,
    priority: 'low',
  });

  if (!wf?.id) {
    console.error('[probe-taskflow-create] FAIL — no workflow id returned');
    process.exit(1);
  }

  const refreshed = await getWorkflow(wf.id);
  console.log('[probe-taskflow-create] OK');
  console.log(JSON.stringify({
    ok: true,
    workflowId: refreshed?.id || wf.id,
    trackingNumber: refreshed?.tracking_number || wf.tracking_number || null,
    status: refreshed?.status || wf.status || null,
    stageCount: (refreshed?.stages || []).length,
    currentStage: refreshed?.current_stage_position || null,
    consignmentNo,
  }));
}

main().catch((error) => {
  console.error('[probe-taskflow-create] FAIL:', error.message);
  process.exit(1);
});
