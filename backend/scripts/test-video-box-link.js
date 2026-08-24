/**
 * Regression test for POST /api/uploads/metadata linking a video to its box.
 *
 * Reproduces the Greptile finding on PR #49: asserting the fix by matching text
 * in uploads.js still passes when the write is unreachable, targets the wrong
 * box, or throws before persisting. This boots the real uploads router (auth,
 * permissions, storage and Postgres mocked — none are available here) and
 * inspects the box document that actually gets stored.
 *
 * The bug: setDocument upserts, so a video recorded before the box contents are
 * saved CREATED a box document carrying only video fields — no consignmentId,
 * no boxNo. That row is invisible to the consignmentId lookup and is rejected
 * by the documents→boxes sync trigger (boxes.consignment_id is NOT NULL and a
 * foreign key, so its 'UNKNOWN' fallback aborts the write).
 *
 * Run: node scripts/test-video-box-link.js
 */
const assert = require('assert');
const express = require('express');
const Module = require('module');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const CONSIGNMENT_ID = 'TEST12345';
const BOX_NO = 7;

const store = {
  consignments: { [CONSIGNMENT_ID]: { id: CONSIGNMENT_ID, internalShipmentNo: CONSIGNMENT_ID } },
  boxes: {},
  videos: {},
};

function installMock(relativePath, exportsObj) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = new Module(resolved, null);
  require.cache[resolved].exports = exportsObj;
  require.cache[resolved].loaded = true;
}

const here = (...p) => path.join(__dirname, '..', ...p);

installMock(here('utils', 'helpers.js'), {
  generateId: () => 'generated-file-id',
  now: () => '2026-08-22T10:00:00.000Z',
  addAuditLog: async () => {},
  firestoreHelpers: {
    async getDocument(collection, id) {
      return store[collection]?.[id] || null;
    },
    async setDocument(collection, id, data) {
      store[collection] = store[collection] || {};
      // Mirrors the real shallow-merge semantics.
      store[collection][id] = { ...(store[collection][id] || {}), ...data, id };
      return store[collection][id];
    },
    async queryCollection(collection, field, _op, value) {
      return Object.values(store[collection] || {}).filter((doc) => doc[field] === value);
    },
    async batchGetDocuments(collection, ids) {
      return ids.map((id) => store[collection]?.[id] || null);
    },
    async getCollection(collection) {
      return Object.values(store[collection] || {});
    },
    async deleteDocument(collection, id) {
      delete store[collection]?.[id];
    },
  },
});

installMock(here('middleware', 'auth.js'), {
  authenticateToken: (req, res, next) => {
    req.user = { id: 'test-admin', name: 'Test Admin', role: 'admin', permissions: {} };
    next();
  },
  requireRole: () => (req, res, next) => next(),
  loadFreshUserRecord: async () => null,
  currentTokenVersion: () => 0,
  DEFAULT_USER: {},
  JWT_SECRET: 'test-only',
});

installMock(here('utils', 'permissions.js'), {
  DELETE_VIDEOS: 'deleteVideos',
  requestUserHasPermission: async () => true,
  requirePermission: () => (req, res, next) => next(),
  requireAnyPermission: () => (req, res, next) => next(),
});

installMock(here('config', 'database.js'), { getPool: () => null, pgEnabled: () => false });
installMock(here('utils', 'storagePathValidation.js'), { isStoragePathForConsignment: () => true });
installMock(here('utils', 'videoHealthCheck.js'), { checkConsignmentVideos: async () => ({ ok: true }) });
installMock(here('utils', 'shareLinks.js'), {
  buildDurableShareUrl: () => null,
  verifyShareToken: () => null,
  getPublicApiBase: () => '',
});

const storageStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'enrichFileRecord') return async (record) => record;
    if (prop === 'finalizeClientStorageUpload') {
      return async (storagePath) => ({
        storageUrl: `https://r2.example/${storagePath}`,
        storagePath,
        verification: { ok: true, size: 1024 },
      });
    }
    if (prop === 'resolveStoragePath' || prop === 'resolveVideoStoragePath' || prop === 'getStoragePath') {
      return () => `consignments/${CONSIGNMENT_ID}/video.webm`;
    }
    if (prop === 'verifyStorageObject') return async () => ({ ok: true, size: 1024 });
    if (prop === 'getStorageFileMeta') return async () => ({ size: 1024 });
    return async () => null;
  },
});
installMock(here('utils', 'storage.js'), storageStub);

const uploadsRouter = require('../routes/uploads');

const app = express();
app.use(express.json());
app.use('/api/uploads', uploadsRouter);

const post = (body) => new Promise((resolve, reject) => {
  const server = app.listen(0, async () => {
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/uploads/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      server.close(() => resolve({ status: res.status, body: json }));
    } catch (err) {
      server.close(() => reject(err));
    }
  });
});

const run = async () => {
  const res = await post({
    consignmentId: CONSIGNMENT_ID,
    type: 'video',
    boxNo: BOX_NO,
    originalName: 'box_7.webm',
    storageUrl: 'https://r2.example/consignments/TEST12345/video.webm',
    storagePath: `consignments/${CONSIGNMENT_ID}/video.webm`,
    size: 1024,
    mimeType: 'video/webm',
  });

  assert.ok(res.status < 400, `metadata upload should succeed, got ${res.status}: ${JSON.stringify(res.body)}`);

  // ── The box document must actually have been written, at the right id ──────
  const expectedBoxId = `${CONSIGNMENT_ID}_box_${BOX_NO}`;
  const boxIds = Object.keys(store.boxes);
  assert.deepStrictEqual(
    boxIds,
    [expectedBoxId],
    `exactly one box document, keyed by box number — got ${JSON.stringify(boxIds)}`
  );

  const box = store.boxes[expectedBoxId];

  // ── The identity fields the bug omitted ───────────────────────────────────
  assert.strictEqual(
    box.consignmentId,
    CONSIGNMENT_ID,
    'box document must carry consignmentId, or it is invisible to the consignmentId lookup and rejected by the sync trigger'
  );
  assert.strictEqual(
    box.boxNo,
    String(BOX_NO),
    'box document must carry its box number, or the packing report and sheet push have nothing to key on'
  );
  assert.strictEqual(box.videoStatus, 'metadata_saved');
  assert.ok(box.videoId, 'the video is linked to the box');

  // ── The status update after the box write must still run ──────────────────
  const consignment = store.consignments[CONSIGNMENT_ID];
  assert.ok(
    consignment.boxVideoStatuses?.[String(BOX_NO)],
    'boxVideoStatuses must be recorded — it used to share a try/catch with the box write and was skipped whenever that failed'
  );
  assert.strictEqual(consignment.boxVideoStatuses[String(BOX_NO)].status, 'metadata_saved');

  console.log('✅ video → box link tests passed');
};

run().catch((err) => {
  console.error('❌ video → box link tests failed:', err.message);
  process.exit(1);
});
