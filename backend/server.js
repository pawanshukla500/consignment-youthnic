require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

// CENTRAL LOG INTERCEPTION (Better Stack + In-memory Log Buffer)
const logBuffer = require('./utils/logBuffer');
const LOGTAIL_TOKEN = process.env.LOGTAIL_SOURCE_TOKEN;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const formatArgs = (args) => {
  return args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
  }).join(' ');
};

const sendLogToBetterStack = (level, message) => {
  if (!LOGTAIL_TOKEN) return;
  const data = JSON.stringify({
    dt: new Date().toISOString(),
    message,
    level,
    metadata: {
      service: 'consignment-packing-api',
      env: process.env.NODE_ENV || 'development'
    }
  });

  const req = require('https').request({
    hostname: process.env.LOGTAIL_INGEST_HOST || 'in.logs.betterstack.com',
    port: 443,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LOGTAIL_TOKEN}`
    }
  }, (res) => {
    res.resume();
  });
  
  req.on('error', () => {});
  req.write(data);
  req.end();
};

console.log = (...args) => {
  originalLog(...args);
  const message = formatArgs(args);
  logBuffer.addLog('info', message);
  sendLogToBetterStack('info', message);
};

console.error = (...args) => {
  originalError(...args);
  const message = formatArgs(args);
  logBuffer.addLog('error', message);
  sendLogToBetterStack('error', message);
};

console.warn = (...args) => {
  originalWarn(...args);
  const message = formatArgs(args);
  logBuffer.addLog('warn', message);
  sendLogToBetterStack('warn', message);
};

if (LOGTAIL_TOKEN) {
  originalLog('[Better Stack] Log streaming active.');
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { pgEnabled, initSchema, testConnection, validateDatabaseUrl, resolveDatabaseUrl } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          "https://*.googleapis.com",
          "https://*.firebaseapp.com",
          "https://*.firebaseio.com",
          "https://identitytoolkit.googleapis.com",
          "https://securetoken.googleapis.com",
          "https://*.supabase.co",
          "https://*.posthog.com",
          "https://*.r2.cloudflarestorage.com",
          "https://*.r2.dev"
        ],
        frameSrc: [
          "'self'",
          "https://*.posthog.com",
          "https://*.betterstack.com",
          "https://*.betterstackdata.com"
        ],
        scriptSrc: isProduction
          ? ["'self'", "https://apis.google.com"]
          : ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://apis.google.com"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.googleapis.com",
          "https://*.googleusercontent.com",
          "https://*.supabase.co",
          "https://*.r2.cloudflarestorage.com",
          "https://*.r2.dev"
        ],
        mediaSrc: [
          "'self'",
          "blob:",
          "https://*.r2.cloudflarestorage.com",
          "https://*.r2.dev"
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api/uploads/stream/')) return false;
    return compression.filter(req, res);
  },
}));
const { createCorsOriginDelegate, parseAllowedOrigins, buildDevOrigins } = require('./utils/corsAllowlist');

const allowedOrigins = [
  ...parseAllowedOrigins(),
  // Production defaults only when ALLOWED_ORIGINS is unset (exact hosts, no wildcards)
  ...(process.env.ALLOWED_ORIGINS
    ? []
    : (isProduction
      ? [
          'https://consignment.youthnic.shop',
          'https://consignment.youthnic-studio.shop',
          'https://consignment-packing-app.web.app',
          'https://consignment-packing-app.firebaseapp.com',
        ]
      : buildDevOrigins())),
];

// CORS applied ONLY to /api/* routes — NOT to static frontend files.
// Exact origin matching only — no *.run.app suffix trust.
const corsMiddleware = cors({
  origin: createCorsOriginDelegate(allowedOrigins),
  credentials: true
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Cloud Run runs behind a proxy — trust it so rate-limit sees real client IPs
app.set('trust proxy', 1);

// Apply CORS only to API routes — static files (JS/CSS bundles) must NOT go through CORS
app.use('/api', corsMiddleware);

// ── Rate limiting (brute-force / abuse protection) ──
const rateLimit = require('express-rate-limit');
// Dedicated limiter for video/file streaming — 200 stream requests per minute per IP
const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream requests. Please slow down.' },
});
app.use('/api/uploads/stream', streamLimiter);
// Strict limiter for auth (login / token exchange / password reset) — 10 / 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});
// Stricter limiter for outbound email (admin + password-reset adjacent) — 20 / 15 min per IP
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many email requests. Please try again later.' },
});
// General API limiter — 300 requests / minute per IP (packing scans use a dedicated limiter)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => (
    /^\/packing\//.test(req.path)
    || /^\/uploads\/stream\//.test(req.path)
    || /^\/uploads\/multipart\/proxy-part/.test(req.path)
    || /^\/uploads\/proxy-object/.test(req.path)
  ),
});
// High-throughput packing scans — up to ~20/sec per station (60–70/min per user with headroom)
const packingScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Scan rate limit exceeded. Please wait a moment.' },
});
app.use(['/api/auth/login', '/api/auth/firebase-login', '/api/auth/forgot-password'], authLimiter);
app.use(['/api/auth/send-password-link', '/api/email'], emailLimiter);
app.use('/api/packing', packingScanLimiter);
app.use('/api', apiLimiter);

// Local disk uploads are legacy — do not expose them anonymously in production.
if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_LOCAL_UPLOAD_STATIC === 'true') {
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
}

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/consignments', require('./routes/consignments'));

app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/productivity', require('./routes/productivity'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/packing', require('./routes/packing'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/marketplaces', require('./routes/marketplaces'));
app.use('/api/users', require('./routes/users'));
app.use('/api/audit-logs', require('./routes/auditLogs'));
app.use('/api/docket-companies', require('./routes/docketCompanies'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/email',   require('./routes/email'));
app.use('/api/workflow', require('./routes/workflow').router);
app.use('/api/inventory-planning', require('./routes/inventoryPlanning'));

// Public brand logo for transactional emails (always available, even in API-only mode)
app.get('/brand-logo.png', (req, res) => {
  const logoPath = path.join(__dirname, 'assets', 'email-logo.png');
  if (!require('fs').existsSync(logoPath)) {
    return res.status(404).send('Logo not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('png');
  return res.sendFile(logoPath);
});

// Health check — includes database status for load balancers / monitoring
app.get('/api/health', async (req, res) => {
  let database = 'not_configured';
  let databaseError = null;

  const connectionString = resolveDatabaseUrl();
  if (process.env.DB_USE_POSTGRES === 'true' || connectionString) {
    const validation = validateDatabaseUrl(connectionString);
    if (!validation.valid) {
      database = 'misconfigured';
      databaseError = validation.error;
    } else if (pgEnabled()) {
      const probe = await testConnection();
      database = probe.ok ? 'connected' : 'unavailable';
      databaseError = probe.ok ? null : probe.error;
    } else {
      database = 'unavailable';
      databaseError = 'PostgreSQL pool failed to initialize.';
    }
  }

  const ok = database === 'connected' || database === 'not_configured';
  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  let activePackingSessions = 0;
  try {
    const packingRouter = require('./routes/packing');
    if (typeof packingRouter.getSessionCount === 'function') {
      activePackingSessions = packingRouter.getSessionCount();
    }
  } catch (_) {}

  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    database,
    databaseError: databaseError && process.env.NODE_ENV !== 'production'
      ? databaseError
      : (databaseError ? 'Database unavailable' : null),
    email: (() => {
      try {
        const { isResendConfigured } = require('./utils/resend');
        return isResendConfigured() ? 'configured' : 'not_configured';
      } catch {
        return 'unknown';
      }
    })(),
    memoryRssMb: memMb,
    activePackingSessions,
    timestamp: new Date().toISOString(),
  });
});

// In development, port 5000 is API-only — redirect root to Vite frontend
if (process.env.NODE_ENV !== 'production') {
  app.get('/', (req, res) => {
    res.redirect(302, process.env.APP_URL || 'http://localhost:5173');
  });
}

// Serve frontend static files in production
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));
  
  // Catch-all for React Router
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    }
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  const connectionString = resolveDatabaseUrl();
  const dbRequired = process.env.DB_USE_POSTGRES === 'true' || Boolean(connectionString);
  if (dbRequired) {
    const validation = validateDatabaseUrl(connectionString);
    if (!validation.valid) {
      console.error('[Postgres] FATAL — invalid database URL:', validation.error);
      if (validation.hint) console.error('[Postgres] Hint:', validation.hint);
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MEMORY_FALLBACK !== 'true') {
        console.error('[Postgres] Refusing to start in production without a valid DATABASE_URL.');
        process.exit(1);
      }
    } else if (pgEnabled()) {
      await initSchema();
      const probe = await testConnection();
      if (probe.ok) {
        console.log(`[Postgres] Connected (${probe.latencyMs}ms) → ${probe.database}`);
      } else {
        console.error('[Postgres] FATAL — connection test failed:', probe.error);
        if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MEMORY_FALLBACK !== 'true') {
          process.exit(1);
        }
      }
    } else {
      console.error('[Postgres] FATAL — DB_USE_POSTGRES=true but pool did not initialize.');
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MEMORY_FALLBACK !== 'true') {
        process.exit(1);
      }
    }
  } else if (pgEnabled()) {
    await initSchema();
  }
  // Ensure default admin exists and Firebase Auth stays in sync on every start
  try {
    const { bootstrapDefaultAdmin } = require('./utils/adminBootstrap');
    const { validateAdminBootstrapConfig, logStartupEmailStatus } = require('./utils/envValidation');
    try {
      logStartupEmailStatus();
    } catch (emailBootError) {
      console.error('[Email] FATAL —', emailBootError.message);
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }

    // Browser packing videos need R2 CORS for signed PUT; refresh on every boot.
    try {
      const { ensureR2Cors } = require('./utils/r2Cors');
      const corsResult = await ensureR2Cors();
      if (corsResult.ok) {
        console.log('[R2] CORS ready for origins:', (corsResult.origins || []).join(', '));
      } else if (corsResult.skipped) {
        console.warn('[R2] CORS skipped — R2 not configured');
      } else {
        console.error('[R2] CORS apply failed — browser PUTs may fail until fixed:', corsResult.error);
        console.error('[R2] Fallback: client will use same-origin /api/uploads proxy endpoints');
      }
    } catch (corsError) {
      console.error('[R2] CORS startup error:', corsError.message);
    }

    const { adminUser, dbError, firebase } = await bootstrapDefaultAdmin();
    if (dbError) {
      console.warn('[Auth] Database bootstrap failed — Firebase admin sync still attempted.');
    }
    if (firebase.synced) {
      console.log('[Auth] Default admin in Firebase:', firebase.email, firebase.created ? '(created)' : '(exists — password unchanged)');
    } else {
      console.error('[Auth] Default admin Firebase sync failed:', firebase.reason || 'unknown');
      const validation = validateAdminBootstrapConfig({
        firebaseAdminExists: firebase.reason === 'admin_missing_no_bootstrap_password' ? false : null,
      });
      for (const warning of validation.warnings) console.warn('[Auth]', warning);
      if (firebase.fatal || (process.env.NODE_ENV === 'production' && firebase.reason === 'admin_missing_no_bootstrap_password')) {
        console.error('[Auth] FATAL — cannot start without a Firebase admin account. Set ADMIN_PASSWORD for one-time bootstrap or create the admin in Firebase Console.');
        process.exit(1);
      }
      if (process.env.NODE_ENV === 'production') {
        console.error('[Auth] Login will fail until Firebase admin sync succeeds. Check FIREBASE_SERVICE_ACCOUNT_JSON and redeploy.');
      }
    }
    if (adminUser) {
      console.log('[Auth] Default admin email:', adminUser.email);
    }
  } catch (e) {
    console.error('[Auth] Startup bootstrap failed:', e.message);
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }

  // Workflow: TAT reminders hourly + Org Head email (Tue & Fri 08:00 UTC)
  try {
    const {
      processTatRemindersAndEscalations,
      processInwardDisputeReminders,
      sendWeeklyOrgHeadReport,
    } = require('./routes/workflow');
    const { isResendConfigured } = require('./utils/resend');
    const HOUR = 60 * 60 * 1000;
    const DISPUTE_SWEEP_INTERVAL = 6 * HOUR; // fine enough resolution for a 3-day reminder cadence

    if (!isResendConfigured()) {
      console.warn('[Workflow] Resend not configured — automatic workflow emails are DISABLED until RESEND_API_KEY is set');
    } else {
      console.log('[Workflow] Resend ready — assignment, TAT, escalation, dispute, and Org Head emails will send automatically');
    }

    // First TAT sweep shortly after boot (don't wait a full hour)
    setTimeout(() => {
      processTatRemindersAndEscalations()
        .then((r) => console.log('[Workflow] Startup TAT check', r))
        .catch((err) => console.warn('[Workflow] Startup TAT check failed:', err.message));
    }, 45 * 1000);

    setInterval(() => {
      processTatRemindersAndEscalations()
        .then((r) => {
          if (r.reminded || r.escalated || r.emailFailures) console.log('[Workflow] TAT check', r);
        })
        .catch((err) => console.warn('[Workflow] TAT check failed:', err.message));
    }, HOUR);

    // Inward disputes: every-3-days follow-up (consolidated per recipient). First
    // pass shortly after boot so a dispute opened just before a restart isn't
    // stuck waiting a full sweep interval.
    setTimeout(() => {
      processInwardDisputeReminders()
        .then((r) => console.log('[Workflow] Startup dispute reminder check', r))
        .catch((err) => console.warn('[Workflow] Startup dispute reminder check failed:', err.message));
    }, 60 * 1000);

    setInterval(() => {
      processInwardDisputeReminders()
        .then((r) => {
          if (r.sent || r.failures) console.log('[Workflow] Dispute reminder check', r);
        })
        .catch((err) => console.warn('[Workflow] Dispute reminder check failed:', err.message));
    }, DISPUTE_SWEEP_INTERVAL);

    setInterval(() => {
      const d = new Date();
      // Tuesday (2) and Friday (5) at 08:00–08:59 UTC
      const day = d.getUTCDay();
      if ((day === 2 || day === 5) && d.getUTCHours() === 8) {
        sendWeeklyOrgHeadReport([], { force: false })
          .then((r) => console.log('[Workflow] Org Head email report', r.ok ? r.recipients : (r.reason || r)))
          .catch((err) => console.warn('[Workflow] Org Head report failed:', err.message));
      }
    }, HOUR);
    console.log('[Workflow] TAT reminder + inward-dispute reminder + Org Head email (Tue/Fri) schedulers started');
  } catch (err) {
    console.warn('[Workflow] Could not start schedulers:', err.message);
  }

  // Inventory Planning: daily Google Sheet sync @ 10:30 Asia/Kolkata, then full team report email
  try {
    const {
      getInventorySettings,
      isDailySyncSlot,
      getZonedDateParts,
    } = require('./utils/inventorySettings');
    const { runInventorySync, isSyncRunning } = require('./utils/inventorySyncService');
    const { sendInventoryPlanningNotification } = require('./utils/inventoryNotify');
    const { buildInventoryPlanningReport } = require('./utils/inventoryReportBuilder');
    let lastSyncSlot = '';
    setInterval(async () => {
      try {
        const settings = await getInventorySettings();
        if (!settings.enabled || !settings.syncEnabled) return;
        if (isSyncRunning()) return;
        if (!isDailySyncSlot(settings)) return;

        const parts = getZonedDateParts(new Date(), settings.syncTimezone || 'Asia/Kolkata');
        const slot = `${parts.dateKey}-morning-sync`;
        if (slot === lastSyncSlot) return;
        lastSyncSlot = slot;

        console.log(
          `[InventoryPlanning] Starting daily Google Sheet sync (${parts.hour}:${String(parts.minute).padStart(2, '0')} ${settings.syncTimezone || 'Asia/Kolkata'})`
        );

        let result = null;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await runInventorySync({ triggerType: 'scheduled', triggeredBy: 'scheduler' });
            if (result.ok) break;
            lastError = result.error || result.reason || 'sync_failed';
            console.warn(`[InventoryPlanning] Daily sync attempt ${attempt}/3 failed:`, lastError);
          } catch (err) {
            lastError = err.message;
            console.warn(`[InventoryPlanning] Daily sync attempt ${attempt}/3 threw:`, err.message);
          }
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 60 * 1000 * attempt));
          }
        }

        if (!result?.ok) {
          console.error('[InventoryPlanning] Daily sync failed after retries:', lastError);
          return;
        }

        console.log(
          `[InventoryPlanning] Daily sync ok — ${result.skusUpdated} SKUs from "${result.sheetMeta?.sheetName}" ` +
            `(batches=${result.sheetMeta?.batchCount || '?'})`
        );

        if (settings.emailDailyReport !== false && settings.emailAfterDailySync !== false) {
          try {
            const report = await buildInventoryPlanningReport({
              triggerReason: 'daily_report',
              persist: true,
            });
            const mail = await sendInventoryPlanningNotification({
              triggerReason: 'daily_report',
              force: true,
              report,
            });
            console.log(
              '[InventoryPlanning] Daily report email',
              mail.ok ? `sent → ${(mail.to || []).join(',')}` : (mail.reason || mail.error)
            );
          } catch (err) {
            console.warn('[InventoryPlanning] Daily report email failed:', err.message);
            // One email retry after short pause
            try {
              await new Promise((r) => setTimeout(r, 15000));
              const mail = await sendInventoryPlanningNotification({
                triggerReason: 'daily_report',
                force: true,
              });
              console.log('[InventoryPlanning] Daily report email retry', mail.ok ? 'sent' : mail.reason || mail.error);
            } catch (retryErr) {
              console.error('[InventoryPlanning] Daily report email retry failed:', retryErr.message);
            }
          }
        }
      } catch (err) {
        console.warn('[InventoryPlanning] scheduler tick failed:', err.message);
      }
    }, 30 * 1000);
    console.log('[InventoryPlanning] Daily sync+email scheduler started (default 10:30 Asia/Kolkata)');
  } catch (err) {
    console.warn('[InventoryPlanning] Could not start schedulers:', err.message);
  }

});
