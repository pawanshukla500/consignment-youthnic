/**
 * Behavioral tests for the inward-dispute workflow:
 *  - dispute open/resolve pure logic (utils/inwardDisputes.js)
 *  - consignmentWorkflow.js gating (archive blocked while a dispute is open)
 *  - routes/workflow.js processInwardDisputeReminders() 3-day consolidation
 *
 * Mocks firestoreHelpers (in-memory) and the Resend transport so this runs
 * with no live Postgres / email provider, matching this repo's other
 * scripts/test-*.js conventions.
 *
 * Run: node scripts/test-inward-disputes.js
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ---- In-memory firestoreHelpers mock, installed into the require cache before
// routes/workflow.js (and everything it requires) picks up the real module. ----
const store = { consignments: new Map() };

const fakeHelpers = {
  generateId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
  now: () => new Date().toISOString(),
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getCollection(collection) {
      if (collection !== 'consignments') return [];
      return [...store.consignments.values()];
    },
    async getDocument(collection, id) {
      if (collection !== 'consignments') return null;
      return store.consignments.get(id) || null;
    },
    async setDocument(collection, id, data) {
      if (collection !== 'consignments') return data;
      const merged = { ...(store.consignments.get(id) || { id }), ...data };
      store.consignments.set(id, merged);
      return merged;
    },
    async queryCollection(collection, field, op, value) {
      if (collection !== 'consignments' || op !== '==') return [];
      return [...store.consignments.values()].filter((c) => c[field] === value);
    },
  },
};

const sentEmails = [];
const fakeResend = {
  isResendConfigured: () => true,
  sendViaResend: async (payload) => {
    sentEmails.push(payload);
    return { ok: true };
  },
};

function installMock(relativePath, exportsObj) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].exports = exportsObj;
  require.cache[resolved].loaded = true;
}

const helpersPath = path.join(__dirname, '..', 'utils', 'helpers.js');
const resendPath = path.join(__dirname, '..', 'utils', 'resend.js');
installMock(helpersPath, fakeHelpers);
installMock(resendPath, fakeResend);

const { processInwardDisputeReminders } = require('../routes/workflow');
const { buildOpenDispute } = require('../utils/inwardDisputes');

function seedConsignment(id, { groundTeamEmail, disputes = [] }) {
  store.consignments.set(id, {
    id,
    internalShipmentNo: id,
    groundTeamEmail,
    groundTeamName: groundTeamEmail,
    stageConfirmations: {
      inward_completed: { confirmedAt: new Date().toISOString() },
    },
    inwardDisputes: disputes,
  });
}

async function run() {
  // --- Scenario A: single open dispute past 3 days -> single (non-consolidated) email ---
  store.consignments.clear();
  sentEmails.length = 0;
  const oldDispute = buildOpenDispute({ shippedQty: 100, inwardQty: 99, reason: 'short', user: {} });
  oldDispute.raisedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  seedConsignment('c1', { groundTeamEmail: 'inward@example.com', disputes: [oldDispute] });

  let result = await processInwardDisputeReminders();
  assert.strictEqual(result.sent, 1, `expected 1 email sent, got ${JSON.stringify(result)}`);
  assert.strictEqual(sentEmails.length, 1, 'exactly one email dispatched');
  assert.ok(sentEmails[0].subject.toLowerCase().includes('reminder'), 'single-dispute email uses reminder subject');
  const storedDispute = store.consignments.get('c1').inwardDisputes[0];
  assert.ok(storedDispute.lastReminderSentAt, 'lastReminderSentAt stamped after send');
  assert.strictEqual(storedDispute.reminderCount, 1, 'reminderCount incremented');
  console.log('Scenario A (single dispute, 3-day due -> single email) OK');

  // --- Scenario B: same recipient now has 2 open disputes -> ONE consolidated email ---
  store.consignments.clear();
  sentEmails.length = 0;
  const d1 = buildOpenDispute({ shippedQty: 100, inwardQty: 99, reason: 'short', user: {} });
  d1.raisedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const d2 = buildOpenDispute({ shippedQty: 50, inwardQty: 52, reason: 'excess', user: {} });
  d2.raisedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  seedConsignment('c1', { groundTeamEmail: 'inward@example.com', disputes: [d1] });
  seedConsignment('c2', { groundTeamEmail: 'inward@example.com', disputes: [d2] });

  result = await processInwardDisputeReminders();
  assert.strictEqual(result.sent, 1, `expected exactly one consolidated send, got ${JSON.stringify(result)}`);
  assert.strictEqual(sentEmails.length, 1, 'consolidation sends a single email, not two');
  assert.ok(sentEmails[0].subject.includes('2 inward disputes'), `consolidated subject: ${sentEmails[0].subject}`);
  assert.ok(sentEmails[0].html.includes('c1') && sentEmails[0].html.includes('c2'), 'consolidated email lists both consignments');
  console.log('Scenario B (2 disputes, same recipient -> 1 consolidated email) OK');

  // --- Scenario C: dispute younger than 3 days -> no email yet ---
  store.consignments.clear();
  sentEmails.length = 0;
  const freshDispute = buildOpenDispute({ shippedQty: 10, inwardQty: 9, reason: 'short', user: {} });
  seedConsignment('c1', { groundTeamEmail: 'inward@example.com', disputes: [freshDispute] });

  result = await processInwardDisputeReminders();
  assert.strictEqual(result.sent, 0, `fresh dispute must not remind yet: ${JSON.stringify(result)}`);
  assert.strictEqual(sentEmails.length, 0, 'no email for a dispute under 3 days old');
  console.log('Scenario C (fresh dispute, under 3 days -> no email) OK');

  // --- Scenario D: resolved disputes are never reminded ---
  store.consignments.clear();
  sentEmails.length = 0;
  const resolved = buildOpenDispute({ shippedQty: 10, inwardQty: 9, reason: 'short', user: {} });
  resolved.raisedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  resolved.status = 'resolved';
  resolved.resolution = { type: 'other', remark: 'closed', resolvedAt: new Date().toISOString() };
  seedConsignment('c1', { groundTeamEmail: 'inward@example.com', disputes: [resolved] });

  result = await processInwardDisputeReminders();
  assert.strictEqual(result.sent, 0, 'resolved disputes must never trigger a reminder');
  console.log('Scenario D (resolved dispute -> no reminder) OK');

  console.log('Inward dispute reminder tests passed.');
}

function testWorkflowGating() {
  const {
    applyStageConfirmation,
    canArchiveConsignment,
    getListPriorityBucket,
  } = require('../utils/consignmentWorkflow');
  const { resolveDispute } = require('../utils/inwardDisputes');

  const now = new Date().toISOString();
  const conf = () => ({ confirmedAt: now, confirmedByUserId: 'u1', confirmedByName: 'Tester', note: null, details: {} });
  const consignment = {
    id: 'c1',
    totalRequiredQty: 100,
    totalPackedQty: 100,
    dispatchDetails: { dispatchedQty: 100 },
    stageConfirmations: {
      packing_completed: conf(),
      ready_for_invoice: conf(),
      invoice_created: conf(),
      ready_for_dispatch: conf(),
      dispatched: conf(),
      inward_completed: { confirmedAt: null, confirmedByUserId: null, confirmedByName: null, note: null, details: null },
    },
  };

  // Matched inward archives immediately, no dispute.
  const matched = applyStageConfirmation(consignment, 'inward_completed', { id: 'u2' }, null, { inwardQty: 100, dispatchedQty: 100 });
  assert.strictEqual(matched.updates.operationalStatus, 'archived', 'matched inward must archive');
  assert.ok(!matched.disputeOpened, 'matched inward must not open a dispute');

  // Short inward without a variance reason is blocked before it ever reaches archive/dispute logic.
  const blocked = applyStageConfirmation(consignment, 'inward_completed', { id: 'u2' }, null, { inwardQty: 90, dispatchedQty: 100 });
  assert.strictEqual(blocked.ok, false, 'short inward without a reason must be blocked');
  assert.strictEqual(blocked.code, 'INWARD_VARIANCE_REASON_REQUIRED');

  // Short inward WITH a reason opens a dispute and does NOT archive.
  const short = applyStageConfirmation(consignment, 'inward_completed', { id: 'u2', name: 'Ops' }, null, {
    inwardQty: 99, dispatchedQty: 100, inwardVarianceReason: 'Marketplace short-received',
  });
  assert.strictEqual(short.ok, true, 'short inward with a reason must succeed');
  assert.strictEqual(short.updates.operationalStatus, 'disputed', 'short inward must open a dispute, not archive');
  assert.ok(!short.updates.isArchived, 'must not be archived while disputed');
  assert.ok(short.disputeOpened && short.disputeOpened.disputedQty === 1, 'dispute must record disputedQty');

  const disputed = { ...consignment, ...short.updates };
  assert.strictEqual(getListPriorityBucket(disputed), 'disputed', 'list bucket must be disputed');
  const gate = canArchiveConsignment(disputed);
  assert.strictEqual(gate.ok, false, 'archive must be blocked while a dispute is open');
  assert.strictEqual(gate.code, 'DISPUTE_OPEN');

  // Resolving the only open dispute unblocks archiving.
  const resolved = resolveDispute(disputed, short.disputeOpened.id, {
    resolutionType: 'reimbursement_received',
    remark: 'Marketplace credited the missing unit',
    user: { id: 'u3', name: 'Manager' },
  });
  assert.strictEqual(resolved.ok, true, 'resolve must succeed with a valid type + remark');
  assert.strictEqual(resolved.allResolved, true, 'no more open disputes after resolving the only one');
  const afterResolve = { ...disputed, inwardDisputes: resolved.disputes };
  assert.strictEqual(canArchiveConsignment(afterResolve).ok, true, 'archive must be allowed once resolved');
  assert.strictEqual(getListPriorityBucket(afterResolve), 'inwarded', 'bucket returns to inwarded once resolved');

  console.log('Workflow gating tests (archive blocked while disputed) passed.');
}

function testServerSchedulerWiring() {
  const fs = require('fs');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('processInwardDisputeReminders'), 'server.js must schedule the dispute reminder sweep');
  console.log('Server scheduler wiring check passed.');
}

testWorkflowGating();
testServerSchedulerWiring();

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
