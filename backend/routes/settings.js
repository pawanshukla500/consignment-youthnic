const express = require('express');
const router = express.Router();
const path = require('path');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requireAnyPermission } = require('../utils/permissions');
const { now, firestoreHelpers, addAuditLog, generateId } = require('../utils/helpers');
const { firebaseInitialized, admin, getFirebaseStatus } = require('../config/firebase');
const { getR2Status } = require('../config/r2');
const { pgEnabled, getPool, initSchema, testConnection, getDatabaseDiagnostics, validateDatabaseUrl, resolveDatabaseUrl } = require('../config/database');
const { checkStorageReachable } = require('../utils/storage');
const pgHelpers = require('../utils/pgHelpers');
const logBuffer = require('../utils/logBuffer');
const { getPosthogDashboardUrl, getBetterStackDashboardUrl } = require('../utils/posthogDashboard');

// Firestore operational data is disabled; legacy migrate route checks this.
const db = null;

const pkg = require(path.join(__dirname, '..', 'package.json'));
const APP_START_TIME = Date.now();

const DEFAULT_SETTINGS = {
  consignmentRetentionDays: 450,
  videoRetentionDays: 60,
  weightImageRetentionDays: 90,
  auditLogRetentionDays: 400,
  lastCleanupRun: null,
  cleanupEnabled: true,
  packingAllowPaste: true,
};

// Packing-station config readable by any signed-in user (admin toggles in Settings).
router.get('/packing', authenticateToken, requireAnyPermission(['packing', 'consignments'], 'view packing settings'), async (req, res) => {
  try {
    const settings = await firestoreHelpers.getDocument('settings', 'retention');
    res.json({
      packingAllowPaste: settings?.packingAllowPaste ?? true,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get settings (admin only)
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const settings = await firestoreHelpers.getDocument('settings', 'retention');
    if (!settings) {
      return res.json({ settings: DEFAULT_SETTINGS });
    }
    const { id, ...data } = settings;
    res.json({ settings: { ...DEFAULT_SETTINGS, ...data } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update settings (admin only)
router.put('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { consignmentRetentionDays, videoRetentionDays, weightImageRetentionDays, auditLogRetentionDays, cleanupEnabled, packingAllowPaste } = req.body;
    const update = {
      updatedAt: now(),
      updatedBy: req.user.id
    };
    if (consignmentRetentionDays !== undefined) {
      const days = parseInt(consignmentRetentionDays);
      if (isNaN(days) || days < 1 || days > 3650) {
        return res.status(400).json({ error: 'Consignment retention days must be between 1 and 3650' });
      }
      update.consignmentRetentionDays = days;
    }
    if (videoRetentionDays !== undefined) {
      const days = parseInt(videoRetentionDays);
      if (isNaN(days) || days < 1 || days > 3650) {
        return res.status(400).json({ error: 'Video retention days must be between 1 and 3650' });
      }
      update.videoRetentionDays = days;
    }
    if (weightImageRetentionDays !== undefined) {
      const days = parseInt(weightImageRetentionDays);
      if (isNaN(days) || days < 1 || days > 3650) {
        return res.status(400).json({ error: 'Weight image retention days must be between 1 and 3650' });
      }
      update.weightImageRetentionDays = days;
    }
    if (auditLogRetentionDays !== undefined) {
      const days = parseInt(auditLogRetentionDays);
      if (isNaN(days) || days < 400 || days > 3650) {
        return res.status(400).json({ error: 'Audit log retention days must be between 400 and 3650' });
      }
      update.auditLogRetentionDays = days;
    }
    if (cleanupEnabled !== undefined) update.cleanupEnabled = Boolean(cleanupEnabled);
    if (packingAllowPaste !== undefined) update.packingAllowPaste = Boolean(packingAllowPaste);

    await firestoreHelpers.setDocument('settings', 'retention', update);
    await addAuditLog('update', 'settings', 'retention', req.user.id, update);
    const saved = await firestoreHelpers.getDocument('settings', 'retention');
    const { id: _id, ...savedData } = saved || {};
    res.json({ settings: { ...DEFAULT_SETTINGS, ...savedData } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run cleanup manually (admin only)
router.post('/cleanup', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { runRetentionCleanup } = require('../scripts/retentionCleanup');
    const result = await runRetentionCleanup();
    await addAuditLog('cleanup', 'settings', 'retention', req.user.id, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Database info + health (admin only) — shows the live datastore connection
// ─────────────────────────────────────────────────────────────────────────────
router.get('/db-info', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const usingPg = pgEnabled();
    const dbDiag = getDatabaseDiagnostics();
    const validation = dbDiag.validation || validateDatabaseUrl(resolveDatabaseUrl());

    const info = {
      datastore: usingPg
        ? 'PostgreSQL (primary live store)'
        : (validation.valid === false && validation.code !== 'MISSING_URL'
          ? 'PostgreSQL misconfigured'
          : (process.env.ALLOW_MEMORY_FALLBACK === 'true' ? 'Development memory store' : 'No operational datastore configured')),
      enabled: usingPg || process.env.ALLOW_MEMORY_FALLBACK === 'true',
      connected: false,
      provider: dbDiag.provider || (usingPg ? 'postgresql' : 'none'),
      endpointConfigured: dbDiag.configured,
      database: dbDiag.database || (usingPg ? 'Ready' : 'Not configured'),
      host: dbDiag.host || null,
      user: usingPg ? 'Service role' : 'Not configured',
      ssl: dbDiag.ssl,
      redactedUrl: dbDiag.redactedUrl,
      sourceEnvVar: dbDiag.sourceEnvVar,
      validation: {
        valid: validation.valid,
        code: validation.code || null,
        error: validation.valid ? null : validation.error,
        hint: validation.hint || null,
      },
      pool: dbDiag.pool,
      lastSuccessfulConnectionAt: dbDiag.lastSuccessfulConnectionAt,
      lastConnectionError: dbDiag.lastConnectionError,
      failedQueryCount: dbDiag.failedQueryCount,
      totalQueryCount: dbDiag.totalQueryCount,
      storageProvider: 'cloudflare-r2',
      legacyImportEnabled: process.env.ALLOW_FIRESTORE_DATA === 'true',
      betterStackLogsEnabled: Boolean(process.env.LOGTAIL_SOURCE_TOKEN),
      posthogDashboardUrl: getPosthogDashboardUrl(),
      betterStackDashboardUrl: getBetterStackDashboardUrl(),
      counts: {},
      totalDocuments: 0,
      latencyMs: null,
      postgresVersion: null,
    };

    if (usingPg) {
      const probe = await testConnection();
      info.connected = probe.ok;
      info.latencyMs = probe.latencyMs ?? null;
      info.postgresVersion = probe.version || null;
      if (!probe.ok) {
        info.error = probe.error || 'Connection failed.';
        info.lastConnectionError = probe.error;
      } else {
        try {
          const counts = await getPool().query(
            'SELECT collection, COUNT(*)::int AS n FROM documents GROUP BY collection ORDER BY collection'
          );
          counts.rows.forEach(r => { info.counts[r.collection] = r.n; });
          info.totalDocuments = counts.rows.reduce((s, r) => s + r.n, 0);
          info.serverTime = probe.serverTime;
        } catch (e) {
          info.error = 'Connected but document query failed.';
          if (process.env.NODE_ENV !== 'production') info.debugError = e.message;
        }
      }
    } else if (dbDiag.configured && !validation.valid) {
      info.error = validation.error;
      info.connected = false;
    } else if (!dbDiag.configured) {
      info.error = 'DATABASE_URL / SUPABASE_DB_URL is not set.';
    } else {
      info.connected = firebaseInitialized && Boolean(db);
      for (const col of ['consignments', 'skus', 'boxes', 'videos', 'documents', 'users', 'marketplaces', 'docketCompanies', 'auditLogs', 'productivity']) {
        try { info.counts[col] = (await firestoreHelpers.getCollection(col)).length; } catch { info.counts[col] = 0; }
      }
      info.totalDocuments = Object.values(info.counts).reduce((s, n) => s + n, 0);
    }

    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get live logs (admin only)
router.get('/live-logs', authenticateToken, requireRole('admin'), (req, res) => {
  res.json({ logs: logBuffer.getLogs() });
});

// System health dashboard (admin only)
router.get('/system-health', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const dbDiag = getDatabaseDiagnostics();
    const validation = dbDiag.validation || validateDatabaseUrl(resolveDatabaseUrl());
    const usingPg = pgEnabled();

    const dataService = {
      enabled: usingPg || dbDiag.configured,
      connected: false,
      endpointConfigured: dbDiag.configured,
      provider: dbDiag.provider,
      host: dbDiag.host,
      database: dbDiag.database,
      redactedUrl: dbDiag.redactedUrl,
      sourceEnvVar: dbDiag.sourceEnvVar,
      validation: {
        valid: validation.valid,
        code: validation.code || null,
        error: validation.valid ? null : validation.error,
        hint: validation.hint || null,
      },
      pool: dbDiag.pool,
      latencyMs: null,
      postgresVersion: null,
      lastSuccessfulConnectionAt: dbDiag.lastSuccessfulConnectionAt,
      lastConnectionError: dbDiag.lastConnectionError,
      failedQueryCount: dbDiag.failedQueryCount,
      documentCounts: {},
      totalDocuments: 0,
    };

    if (usingPg) {
      const probe = await testConnection();
      dataService.connected = probe.ok;
      dataService.latencyMs = probe.latencyMs ?? null;
      dataService.postgresVersion = probe.version || null;
      if (probe.ok) {
        try {
          const counts = await getPool().query(
            'SELECT collection, COUNT(*)::int AS n FROM documents GROUP BY collection ORDER BY collection'
          );
          counts.rows.forEach((r) => { dataService.documentCounts[r.collection] = r.n; });
          dataService.totalDocuments = counts.rows.reduce((sum, r) => sum + r.n, 0);
        } catch (e) {
          dataService.error = 'Document count query failed.';
          if (process.env.NODE_ENV !== 'production') dataService.debugError = e.message;
        }
      } else {
        dataService.error = probe.error || 'Connection failed.';
      }
    } else if (dbDiag.configured && !validation.valid) {
      dataService.error = validation.error;
    } else if (!dbDiag.configured) {
      dataService.error = 'DATABASE_URL / SUPABASE_DB_URL is not configured.';
    }

    const fbStatus = getFirebaseStatus();
    const accessService = {
      configured: fbStatus.initialized,
      available: false,
      setupRequired: !fbStatus.initialized,
      projectId: process.env.FIREBASE_PROJECT_ID || fbStatus.projectId || null,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
    };
    if (fbStatus.initialized && admin?.auth) {
      try {
        await admin.auth().listUsers(1);
        accessService.available = true;
      } catch (e) {
        accessService.error = 'Secure access check failed.';
        if (process.env.NODE_ENV !== 'production') accessService.debugError = e.message;
      }
    }

    const r2Status = getR2Status();
    const checkedAt = new Date().toISOString();
    const fileService = {
      configured: Boolean(r2Status.configured),
      reachable: false,
      primary: r2Status.configured ? 'cloudflare-r2' : 'unconfigured',
      provider: 'Cloudflare R2',
      providerId: 'r2',
      bucket: r2Status.bucket || null,
      health: 'unconfigured',
      uploadMode: 'signed-put-direct',
      fileAccess: 'authenticated-stream',
      checkedAt,
    };
    if (r2Status.configured) {
      const storageCheck = await checkStorageReachable();
      fileService.reachable = storageCheck.reachable;
      fileService.health = storageCheck.reachable ? 'healthy' : 'unreachable';
      fileService.checkedAt = new Date().toISOString();
      if (storageCheck.error) fileService.error = 'File service check failed.';
      if (storageCheck.error && process.env.NODE_ENV !== 'production') fileService.debugError = storageCheck.error;
    } else if (r2Status.setupHint) {
      fileService.error = 'Cloudflare R2 is not fully configured.';
      if (process.env.NODE_ENV !== 'production') fileService.debugError = r2Status.setupHint;
    }

    const { getRealtimeStatus } = require('../utils/supabaseRealtime');
    const liveSyncService = {
      ...getRealtimeStatus(),
      jwtConfigured: Boolean(String(process.env.SUPABASE_JWT_SECRET || '').trim()),
    };

    const uptimeSeconds = Math.floor((Date.now() - APP_START_TIME) / 1000);
    const databaseHealthy = dataService.connected;
    const allHealthy = databaseHealthy && accessService.available && fileService.reachable;

    res.json({
      application: {
        name: pkg.name,
        version: pkg.version,
        nodeEnv: process.env.NODE_ENV || 'development',
        uptimeSeconds,
        uptimeHuman: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
      },
      api: {
        status: databaseHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
      },
      healthy: allHealthy,
      dataService,
      accessService,
      fileService,
      liveSyncService,
      alerts: [
        !validation.valid ? { level: 'critical', message: validation.error, hint: validation.hint } : null,
        !dataService.connected && dbDiag.configured ? { level: 'critical', message: dataService.error || 'PostgreSQL connection failed.' } : null,
        !accessService.available ? { level: 'warning', message: 'Firebase Authentication is not available.' } : null,
        !fileService.reachable && fileService.configured ? { level: 'warning', message: 'Cloudflare R2 storage is not reachable.' } : null,
        !fileService.configured ? { level: 'warning', message: 'Cloudflare R2 is not configured.' } : null,
        !liveSyncService.configured ? { level: 'warning', message: 'Supabase Realtime live sync is not configured (SSE/polling fallback remains).' } : null,
      ].filter(Boolean),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile data integrity (admin only)
// Recomputes every consignment's packed totals, SKU packedQty/boxQuantities/status
// and consignment status DIRECTLY from the physical boxes (single source of truth).
// Guarantees packing-station data == SKU data == consignment totals == report.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reconcile', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const consignments = await firestoreHelpers.getCollection('consignments');
    let fixedConsignments = 0, fixedSkus = 0, scanned = 0;
    const issues = [];

    for (const c of consignments) {
      scanned++;
      const [skus, boxes] = await Promise.all([
        Promise.all((c.skuIds || []).map(id => firestoreHelpers.getDocument('skus', id))),
        Promise.all((c.boxIds || []).map(id => firestoreHelpers.getDocument('boxes', id)))
      ]);
      const validSkus = skus.filter(Boolean);
      const validBoxes = boxes.filter(Boolean);

      // Sum each SKU's qty across all boxes (physical truth), keyed by skuId
      const packedBySku = {};
      for (const box of validBoxes) {
        for (const item of (box.items || [])) {
          if (!item.skuId) continue;
          if (!packedBySku[item.skuId]) packedBySku[item.skuId] = {};
          packedBySku[item.skuId][box.boxNo] = (packedBySku[item.skuId][box.boxNo] || 0) + (item.qty || 0);
        }
      }

      const skuWrites = [];
      for (const s of validSkus) {
        const bq = packedBySku[s.id] || {};
        const packed = Object.values(bq).reduce((a, b) => a + b, 0);
        const status = (s.requiredQty || 0) > 0 && packed >= s.requiredQty ? 'completed' : 'pending';
        const drift = (s.packedQty || 0) !== packed
          || JSON.stringify(s.boxQuantities || {}) !== JSON.stringify(bq)
          || s.status !== status;
        if (drift) {
          if (issues.length < 100) issues.push(`${c.internalShipmentNo || c.id} · ${s.internalSku || s.marketplaceSku}: packed ${s.packedQty || 0} → ${packed}`);
          skuWrites.push(['skus', s.id, { packedQty: packed, boxQuantities: bq, status, updatedAt: now() }]);
          fixedSkus++;
        }
        s.packedQty = packed; s.status = status;
      }
      if (skuWrites.length) await firestoreHelpers.batchSetMulti(skuWrites);

      const totalPacked = validSkus.reduce((sum, s) => sum + (s.packedQty || 0), 0);
      const totalReq = validSkus.reduce((sum, s) => sum + (s.requiredQty || 0), 0);
      const allDone = validSkus.length > 0 && validSkus.every(s => s.status === 'completed');
      const newStatus = totalPacked === 0 ? 'pending' : (allDone ? 'completed' : 'in_progress');

      if ((c.totalPackedQty || 0) !== totalPacked || (c.totalRequiredQty || 0) !== totalReq || c.status !== newStatus) {
        await firestoreHelpers.setDocument('consignments', c.id, {
          totalPackedQty: totalPacked, totalRequiredQty: totalReq, status: newStatus, updatedAt: now()
        });
        fixedConsignments++;
      }
    }

    await addAuditLog('reconcile', 'settings', 'data-integrity', req.user.id, { fixedConsignments, fixedSkus, scanned });
    res.json({ ok: true, scanned, fixedConsignments, fixedSkus, issues });
  } catch (error) {
    console.error('Reconcile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Migrate Firestore to PostgreSQL (admin only)
router.post(['/import-legacy-data', '/migrate-to-postgres'], authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    if (process.env.ALLOW_FIRESTORE_DATA !== 'true') {
      return res.status(410).json({
        error: 'Firestore operational migration is disabled. Firebase SQL (Cloud SQL) is the single source of truth; set ALLOW_FIRESTORE_DATA=true only for a one-time legacy migration.',
      });
    }
    if (!pgEnabled()) {
      return res.status(400).json({ error: 'PostgreSQL is not enabled or configured' });
    }
    if (!firebaseInitialized || !db) {
      return res.status(400).json({ error: 'Firebase Firestore is not initialized' });
    }

    const COLLECTIONS = [
      'settings',
      'users',
      'marketplaces',
      'docketCompanies',
      'consignments',
      'skus',
      'boxes',
      'videos',
      'documents',
      'auditLogs',
      'productivity'
    ];

    const results = {};
    let totalMigrated = 0;

    for (const col of COLLECTIONS) {
      const snapshot = await db.collection(col).get();
      if (!snapshot.empty) {
        const items = snapshot.docs.map(doc => [doc.id, doc.data()]);
        await pgHelpers.batchSet(col, items);
        results[col] = items.length;
        totalMigrated += items.length;
      } else {
        results[col] = 0;
      }
    }

    await addAuditLog('migrate', 'settings', 'firestore-to-postgres', req.user.id, {
      totalCollections: COLLECTIONS.length,
      totalMigrated,
      details: results
    });

    res.json({
      ok: true,
      migrated: results,
      total: totalMigrated
    });
  } catch (error) {
    console.error('Migration to Postgres failed:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
