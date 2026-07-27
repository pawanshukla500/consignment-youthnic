# Consignment Packing App — Agent Guide

This document is written for AI coding agents. It assumes zero prior knowledge of the project.

---

## Project Overview

The **Consignment Packing App** (also branded **Youthnic Packing Station**) is a full-stack web application for managing consignment packing operations. It is built for VB Exports internal use and is private/proprietary software.

**Core capabilities:**
- Secure sign-in via **Firebase Auth**, with an application-level JWT for API access
- Role- and permission-based access control (`admin`, `packer`, plus per-feature permissions)
- Consignment CRUD with SKU-level tracking, boxes, box items, and scan events
- Barcode-driven packing station with offline-resilient IndexedDB queues
- File uploads (videos and documents) to **Cloudflare R2**, metadata in **Supabase PostgreSQL**
- Real-time consignment sync across clients via **Supabase Realtime**, with SSE and polling fallbacks
- Productivity dashboard, audit logging, production planning, and CSV/Excel exports
- Marketplace and docket-company management, plus a master SKU catalog
- Admin-configurable data retention and manual cleanup
- Password reset emails via **Resend** + Firebase Auth link generation

**Tech stack summary:**

| Layer | Technology |
|-------|------------|
| Frontend | React 19.2.6, Vite 8.0.12, Tailwind CSS v4.3.0, React Router v7.16.0 |
| Backend | Node.js 20+, Express 4.18.2 |
| Primary database | Supabase PostgreSQL 15 (`pg` driver) |
| Realtime | Supabase Realtime → SSE `/api/sync/events` → polling `/api/sync/changes` |
| Auth | Firebase Auth (primary) + application JWT (`jsonwebtoken`) |
| File storage | Cloudflare R2 (S3 API) |
| Email | Resend API |
| Hosting / runtime | Google Cloud Run single-container (Dockerfile) or Firebase Hosting (frontend only) |

> **Important architectural rule:** Supabase PostgreSQL is the single source of truth for operational/business data. Firebase Firestore is **disabled by default** for operational data (`ALLOW_FIRESTORE_DATA=false`). Firebase is limited to **Authentication**. File media uses **Cloudflare R2**.

---

## Repository Structure

```
consignment-packing-master/
├── backend/                     # Node.js + Express API
│   ├── server.js                # Express entry point, middleware, route mounting, SPA catch-all
│   ├── config/
│   │   ├── database.js          # Supabase/PostgreSQL pool + schema init
│   │   ├── firebase.js          # Firebase Admin SDK init (Auth + Storage)
│   │   └── supabase.js          # Stub (not used for storage)
│   ├── middleware/
│   │   ├── auth.js              # JWT verification, DEFAULT_USER, requireRole
│   │   └── ...
│   ├── routes/                  # Express route modules (one per domain)
│   │   ├── auth.js
│   │   ├── consignments.js
│   │   ├── uploads.js
│   │   ├── packing.js
│   │   ├── productivity.js
│   │   ├── settings.js
│   │   ├── users.js
│   │   ├── auditLogs.js
│   │   ├── marketplaces.js
│   │   ├── docketCompanies.js
│   │   ├── skuCatalog.js
│   │   ├── sync.js
│   │   ├── email.js
│   │   └── templates.js
│   ├── utils/                   # Helpers: datastore abstraction, storage, auth mirror, etc.
│   │   ├── helpers.js           # Unified datastore abstraction (Postgres → Firestore → memory)
│   │   ├── pgHelpers.js         # PostgreSQL/JSONB implementations
│   │   ├── defaultAdmin.js      # Bootstraps the default admin user
│   │   ├── firebaseAuthMirror.js# Syncs local users to Firebase Auth
│   │   ├── storage.js           # Cloudflare R2 upload/delete/stream helpers
│   │   ├── passwordReset.js     # Resend + Firebase password-reset flow
│   │   ├── resend.js            # Resend client
│   │   ├── syncBus.js           # In-process event bus for SSE
│   │   ├── dispatchPlanning.js  # Transit-day / required-dispatch calculations
│   │   ├── criticality.js       # Priority/criticality scoring
│   │   ├── shipmentStatus.js    # Auto status transitions
│   │   └── packingDraft.js      # Persist in-progress packing sessions
│   ├── scripts/                 # Admin, migration, cleanup, and smoke-test scripts
│   │   ├── retentionCleanup.js
│   │   ├── migrate-to-supabase.js
│   │   ├── apply-supabase-schema.js
│   │   ├── bootstrap-auth.js
│   │   ├── smoke-test.js
│   │   ├── test-db.js
│   │   └── ...
│   ├── uploads/                 # Temporary multer destination
│   ├── .env                     # Backend environment variables (sensitive, never commit)
│   ├── .env.example             # Template for backend env
│   ├── package.json
│   └── serviceAccountKey.json   # Firebase service account (REPLACE in production, gitignored)
│
├── frontend/                    # React + Vite SPA
│   ├── index.html
│   ├── vite.config.js           # Vite + Tailwind plugin; dev proxy /api → localhost:5000
│   ├── eslint.config.js         # Flat ESLint config
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx              # BrowserRouter, route guards, lazy-loaded pages
│   │   ├── index.css            # Tailwind v4 import + custom theme + animations
│   │   ├── config/
│   │   │   ├── firebase.js      # Frontend Firebase SDK init
│   │   │   └── supabase.js      # Frontend Supabase client (realtime only)
│   │   ├── context/
│   │   │   ├── AuthContext.jsx  # Firebase login, JWT, session validation
│   │   │   ├── ToastContext.jsx # Global toast notifications
│   │   │   └── ConsignmentSyncContext.jsx # Supabase realtime / SSE / polling
│   │   ├── components/          # Layout, Sidebar, Modal, Skeleton, etc.
│   │   ├── pages/               # Login, Dashboard, Consignments, PackingStation, Settings, ...
│   │   ├── services/
│   │   │   ├── api.js           # Axios instance + API modules
│   │   │   └── videoUploadService.js
│   │   ├── hooks/
│   │   │   ├── useDebounce.js
│   │   │   └── useStorageUpload.js  # Cloudflare R2 direct upload hook
│   │   └── utils/               # IndexedDB queues, Excel export, criticality UI, etc.
│   ├── .env                     # Frontend env vars (VITE_*)
│   ├── .env.example             # Template
│   ├── .env.production          # Production frontend env (gitignored)
│   └── package.json
│
├── supabase/                    # Supabase project config and Postgres migrations
│   ├── config.toml
│   └── migrations/
│       ├── 20250613000000_initial_schema.sql
│       └── 20260614000000_operational_reporting_schema.sql
│
├── firebase.json                # Firebase Hosting config
├── .firebaserc                  # Firebase project selector
├── Dockerfile                   # Two-stage Cloud Run Dockerfile
├── cloudbuild.yaml              # Google Cloud Build → Cloud Run
├── run.bat                      # Windows dev helper (opens backend + frontend terminals)
├── package.json                 # Root orchestrator scripts
├── README.md                    # Human-facing quick start
├── DEPLOYMENT.md                # Detailed Cloud Run / Firebase deployment guide
└── AGENTS.md                    # This file
```

---

## Build and Run Commands

### Prerequisites
- Node.js 20+
- npm
- A Supabase project (PostgreSQL + Realtime enabled)
- A Firebase project (Auth + Storage enabled)

### Install all dependencies
```bash
npm run install:all
```
This runs `npm install` in root, then `backend/`, then `frontend/`.

### Development (both backend + frontend)
```bash
npm run dev
```
- Backend runs on `http://localhost:5000`
- Frontend runs on `http://localhost:5173`
- Vite dev proxy forwards `/api` calls to port 5000 automatically.

Or use the Windows helper:
```cmd
run.bat
```

### Frontend only
```bash
npm run dev:frontend    # cd frontend && npm run dev
```

### Backend only
```bash
npm run dev:backend     # cd backend && npm run dev (nodemon)
```

### Production build (frontend)
```bash
npm run build           # cd frontend && vite build → outputs to frontend/dist
```

### Production start (backend serves static frontend)
```bash
npm start               # cd backend && node server.js (requires frontend/dist)
```

### Deploy
```bash
npm run deploy          # npm run build + firebase deploy --only hosting (frontend only)
npm run deploy:backend  # gcloud run deploy consignment-packing --region=europe-west1 --allow-unauthenticated
```

See `DEPLOYMENT.md` for full Cloud Run setup (domain mapping, env vars from GitHub Secrets, Storage CORS).

---

## Environment Variables

### Backend (`backend/.env`)
Copy from `backend/.env.example` and fill in real values.

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default: 5000) |
| `NODE_ENV` | `development` or `production` |
| `JWT_SECRET` | Strong random string for signing app JWTs |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Bootstrap admin identity; `ADMIN_PASSWORD` only for first-time Firebase create |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_DB_URL` | PostgreSQL connection string (Transaction pooler recommended) |
| `SUPABASE_JWT_SECRET` | Used to sign realtime tokens for Supabase Realtime |
| `DB_USE_POSTGRES` | Set `true` to enable PostgreSQL |
| `DB_SSL` | Set `true` for Supabase connections |
| `ALLOW_MEMORY_FALLBACK` | `true` to allow in-memory store if Postgres is unavailable |
| `ALLOW_FIRESTORE_DATA` | `true` only for legacy migration/dev use |
| `ALLOW_LEGACY_PASSWORD_LOGIN` | `true` to enable bcrypt `/api/auth/login` fallback |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Firebase service account JSON (optional) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Inline service account JSON (optional, preferred for Cloud Run) |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare R2 object storage for videos/documents |
| `RESEND_API_KEY` | Resend API key for password-reset emails |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` / `MAIL_USER_DOMAIN` | Email sender config |
| `APP_URL` | Public app URL (e.g. `http://localhost:5173`) |
| `ALLOWED_ORIGINS` | Comma-separated production CORS origins |

### Frontend (`frontend/.env`)
Only `VITE_*` variables are exposed to the browser.

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Backend base URL (dev: `http://localhost:5000`; prod: often empty for same-origin) |
| `VITE_FIREBASE_API_KEY` / `AUTH_DOMAIN` / `PROJECT_ID` / `STORAGE_BUCKET` / `MESSAGING_SENDER_ID` / `APP_ID` / `MEASUREMENT_ID` | Firebase web app config |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase realtime only (never use service-role key) |
| `VITE_SESSION_TIMEOUT_MINUTES` | Optional idle session timeout (default 120) |

> **Security:** `backend/.env`, `backend/serviceAccountKey.json`, `frontend/.env`, and `frontend/.env.production` are gitignored. Never commit credentials.

---

## Architecture Details

### Backend Design

**Entry point:** `backend/server.js`
- Initializes Express with `helmet`, `compression`, and CORS **only on `/api/*` routes**.
- JSON body parser with a 50 MB limit.
- Serves static `/uploads` and, in production, the built frontend from `frontend/dist` with an SPA catch-all.
- Applies rate limiting: 10 login attempts per 15 minutes per IP, 300 general API requests per minute per IP.
- Health check at `GET /api/health`.
- On startup: initializes the Postgres schema if enabled, ensures the default admin user exists, and syncs it to Firebase Auth if Firebase is configured.

**Database layer:**
- `backend/config/database.js` creates a `pg` Pool from `SUPABASE_DB_URL` or `DATABASE_URL` when `DB_USE_POSTGRES=true`.
- On startup it creates/ensures:
  - `documents(collection, id, data JSONB, created_at, updated_at)` — JSONB bridge for legacy/document-style access
  - `users(id, firebase_uid, email, name, role, permissions JSONB, ...)`
  - Row-level security policies and `supabase_realtime` publication entries for both tables
- Operational migrations live in `supabase/migrations/` and add normalized tables:
  - `consignments`, `skus`, `boxes`, `box_items`, `videos`, `shipment_documents`, `marketplaces`, `audit_logs`, `productivity_events`, `packing_sync_jobs`, `scan_events`
- `backend/utils/helpers.js` is the unified datastore abstraction. The precedence is:
  1. Supabase PostgreSQL if `pgEnabled()`
  2. Firestore if `ALLOW_FIRESTORE_DATA=true` and Firebase is initialized
  3. In-memory fallback only if `ALLOW_MEMORY_FALLBACK=true`; otherwise it throws a 503 `DATASTORE_UNAVAILABLE` error
- `backend/utils/pgHelpers.js` implements the Postgres/JSONB operations and optimized normalized queries.

**Firebase initialization (`backend/config/firebase.js`):**
- Loads credentials in this priority:
  1. `FIREBASE_SERVICE_ACCOUNT_JSON` env var
  2. `GOOGLE_APPLICATION_CREDENTIALS` env var
  3. `backend/serviceAccountKey.json`
  4. GCP environment (`K_SERVICE`, `GOOGLE_CLOUD_PROJECT`)
  5. Firestore emulator (`FIRESTORE_EMULATOR_HOST`)
- Always initializes Auth and Storage when credentials are valid.
- Firestore (`db`) is only exposed when `ALLOW_FIRESTORE_DATA=true`.
- Exports: `{ admin, db, bucket, firebaseInitialized, getFirebaseStatus }`.

**Authentication (`backend/middleware/auth.js`):**
- `DEFAULT_USER` (the bootstrap admin):
  - id: `default-admin`
  - email: `ADMIN_EMAIL` or `returnorders@vbexports.co.in`
  - password: never stored in app DB; Firebase Auth only. `ADMIN_PASSWORD` is one-time bootstrap for first Firebase create (see `docs/ADMIN_PASSWORD_ROTATION.md`)
  - name: `ADMIN_NAME` or `Pawan Shukla`
  - role: `admin`
- `authenticateToken` verifies `Authorization: Bearer <token>` JWT. For SSE (`/api/sync/events`) it also accepts a `?token=` query parameter because browsers cannot set headers on native `EventSource`.
- `requireRole(...roles)` allows `admin` always; otherwise checks the user's role.
- JWT expiry: 24 hours.
- Production fails startup if `JWT_SECRET` is missing, or if Firebase admin is missing and `ADMIN_PASSWORD` is not set for one-time bootstrap.

**Auth flow (`backend/routes/auth.js`):**
1. Frontend signs in with Firebase Auth (email/password).
2. Frontend calls `POST /api/auth/firebase-login` with the Firebase ID token.
3. Backend verifies the token with `admin.auth().verifyIdToken`, finds/creates the app user, and returns an app JWT.
4. All subsequent API calls use the app JWT.
5. `GET /api/auth/realtime-token` issues a short-lived Supabase realtime token signed with `SUPABASE_JWT_SECRET`.

**Route modules:**

| Route File | Base Path | Key Features |
|------------|-----------|--------------|
| `auth.js` | `/api/auth` | Firebase login, legacy login (gated), forgot password, `/me`, realtime token |
| `consignments.js` | `/api/consignments` | CRUD, packing report, pack SKU, save box, archive |
| `uploads.js` | `/api/uploads` | Metadata after direct upload; legacy multipart upload; list; delete; share |
| `packing.js` | `/api/packing` | Load, increment/decrement, check duplicate box, save box, generate label, finish, resume session, sync status, productivity |
| `productivity.js` | `/api/productivity` | Log events, stats, audit logs, production planning |
| `settings.js` | `/api/settings` | Retention config, cleanup trigger, DB info, system health, reconcile, legacy import |
| `users.js` | `/api/users` | CRUD, change password, invite link, sync secure access, secure-access status |
| `auditLogs.js` | `/api/audit-logs` | Filterable audit logs (admin), `/my-activity` |
| `marketplaces.js` | `/api/marketplaces` | Marketplace CRUD |
| `docketCompanies.js` | `/api/docket-companies` | Courier/logistics partner CRUD |
| `skuCatalog.js` | `/api/sku-catalog` | Master SKU CRUD + bulk import |
| `sync.js` | `/api/sync` | Polling changes + SSE events |
| `email.js` | `/api/email` | Send, welcome, notify-consignment, resolve-address |
| `templates.js` | `/api/templates` | Download CSV templates |

**File uploads:**
- **Preferred path:** Frontend uploads directly to Cloudflare R2 via a backend-issued presigned PUT URL, then calls `POST /api/uploads/metadata` to persist metadata in Postgres.
- Playback uses authenticated `GET /api/uploads/stream/:fileId` (Range-capable) from R2.
- Allowed MIMEs: video, image, PDF, Office docs, CSV, TXT.
- **1 video per box** is enforced: a new video for the same `consignmentId` + `boxNo` replaces the previous one.
- `GET /api/uploads/share/:fileId` returns an authenticated stream path (not a public object URL).

**Packing station:**
- `backend/routes/packing.js` holds active in-memory sessions per consignment.
- `backend/utils/packingDraft.js` persists in-progress sessions to Postgres (`packing_drafts`) so scans survive server restarts.
- Frontend uses IndexedDB queues (`scanQueue`, `packingSyncQueue`, `videoQueue`) to survive offline/crashes.

### Frontend Design

**Entry point:** `frontend/src/main.jsx` renders `<App />` in `React.StrictMode`.

**Routing (`frontend/src/App.jsx`):**
- `BrowserRouter` with route guards: `PrivateRoute`, `PublicRoute`, `AdminRoute`, `PermissionRoute`.
- Public pages: `/login`, `/reset-password`, `/terms`, `/privacy`, `/contact`, `/copyright`.
- Private full-page: `/packing` (requires `packing` permission).
- Private layout pages: `/`, `/consignments`, `/consignments/:id`, `/sku-catalog`, `/productivity`, `/marketplaces`, `/docket-companies`, `/users`, `/audit-logs`, `/settings`, `/profile`.
- All pages are lazy-loaded (including Login); the initial bundle only loads the routing shell and auth context.

**State management:**
- No Redux/Zustand. Global state uses React Context:
  - `AuthContext` — Firebase sign-in, app JWT, session validation, idle timeout, stored in `sessionStorage`
  - `ToastContext` — global toast notifications
  - `ConsignmentSyncContext` — real-time updates across tabs/pages

**Real-time sync (`ConsignmentSyncContext.jsx`):**
1. Primary: Supabase Realtime `postgres_changes` on `consignments`, `skus`, `boxes`, `box_items`, `scan_events`, `videos`, `packing_sync_jobs`
2. Fallback: Server-Sent Events at `/api/sync/events`
3. Final fallback: Polling `/api/sync/changes` every 8 seconds

**API layer (`frontend/src/services/api.js`):**
- Single Axios instance; base URL from `VITE_API_URL + '/api'`.
- Request interceptor injects `Authorization: Bearer <token>` from `sessionStorage`/`localStorage`.
- Response interceptor catches 401, clears the session, and redirects to `/login`.
- Named API modules: `authAPI`, `consignmentsAPI`, `uploadsAPI`, `packingAPI`, `productivityAPI`, `usersAPI`, `auditLogsAPI`, `settingsAPI`, `marketplacesAPI`, `docketCompaniesAPI`, `skuCatalogAPI`, `emailAPI`, `templatesAPI`.

**Styling:**
- Tailwind CSS v4 with `@import "tailwindcss"` in `frontend/src/index.css`.
- Custom theme under `@theme`: primary palette, surfaces, sidebar colors, fonts (Inter + Plus Jakarta Sans).
- Custom animations and global scrollbar styles in `index.css`.
- Tailwind utility classes directly on elements.

**Icons:** `lucide-react` exclusively.

**Offline resilience:**
- `scanQueue` — durable barcode scan queue
- `packingSyncQueue` — durable save-box job queue
- `videoQueue` — durable finalized-video upload queue
- `videoUploadService.js` drains the queues every 12 seconds and on `online`/`visibilitychange` events, with retries.

---

## Code Style Guidelines

- **Language:** All code, comments, and documentation are in English.
- **Backend (Node.js):**
  - Use semicolons.
  - `const` / `let` (no `var`).
  - `async/await` for asynchronous code.
  - `try/catch` blocks in route handlers with `console.error` logging.
  - Error responses: `res.status(XXX).json({ error: 'message' })`.
  - Export routers with `module.exports = router;`.
- **Frontend (React):**
  - Functional components with hooks.
  - No semicolons in frontend source (follow existing style).
  - Single quotes for JS strings; double quotes inside JSX attributes where needed.
  - PascalCase for components; camelCase for hooks, functions, variables.
  - Tailwind utility classes directly on elements.
  - Use `lucide-react` icons only.
- **Formatting:** No Prettier config found. Follow existing indentation (2 spaces).

---

## Testing Strategy

**There is currently no formal test suite in this project.**

No unit tests, integration tests, or end-to-end tests exist in `package.json` or the source tree.

If you add tests, prefer:
- **Backend:** Jest + Supertest for API route testing
- **Frontend:** Vitest (already bundled with Vite) + React Testing Library

Current manual verification tools:
- `backend/scripts/test-db.js` — Postgres connectivity and schema check
- `backend/scripts/smoke-test.js` — Infrastructure + authenticated API smoke test

---

## Data Retention

The app includes an **admin-configurable retention policy** (`Settings` page):

| Data Type | Default Retention | Rule |
|-----------|------------------|------|
| Consignments + SKUs + Boxes + Documents | 450 days from `createdAt` | Deleted by manual cleanup |
| Videos | 60 days from `dateOfInward` | Deleted by manual cleanup |
| Videos (protected) | Infinite | **Never deleted** if consignment `marketplaceTicketId` is set |

- Cleanup script: `backend/scripts/retentionCleanup.js`
- API trigger: `POST /api/settings/cleanup` (admin only)
- Settings stored in the `settings` collection/document in Postgres/JSONB.

---

## Security Considerations

- **Default admin credentials:** Bootstrap uses Firebase Auth. `ADMIN_PASSWORD` is only for first-time account creation and must never be hardcoded. Rotate any previously shared default password immediately (`docs/ADMIN_PASSWORD_ROTATION.md`). Production startup fails if the Firebase admin is missing and no bootstrap password is configured.
- **JWT secret:** `backend/.env` must contain a strong, unique `JWT_SECRET`. Production startup throws if it is missing.
- **Service account key:** `backend/serviceAccountKey.json` contains sensitive credentials. It is gitignored. For Cloud Run, use `FIREBASE_SERVICE_ACCOUNT_JSON` or GCP Application Default Credentials instead.
- **CORS:** Applied only to `/api/*`. Static frontend files intentionally bypass CORS so that Vite-built bundles load correctly.
- **Rate limiting:** Login endpoints are strictly limited. General API is limited to 300 requests/minute per IP.
- **Helmet CSP:** Configured to allow Firebase, Supabase, Google APIs, Google Fonts, and inline styles/scripts in development.
- **File uploads:** Browser PUTs directly to Cloudflare R2 using a short-lived signed URL. MIME types are allowlisted. Playback is authenticated via `/api/uploads/stream`.
- **Role-based access:** `requireRole(...)` guards sensitive endpoints. Admins bypass permission checks.
- **Permission-based UI:** The frontend sidebar and `PermissionRoute` filter navigation items based on `user.permissions`.
- **Supabase RLS:** All operational tables have `ENABLE ROW LEVEL SECURITY`. Anonymous/authenticated clients are denied by default; realtime reads require a valid `app_user_id` claim.
- **Realtime tokens:** Supabase Realtime auth tokens are short-lived (1 hour) and signed with `SUPABASE_JWT_SECRET` on the backend.
- **Password reset:** Uses Firebase Auth to generate a secure reset link and Resend to deliver a branded email.

---

## Deployment Notes

See `DEPLOYMENT.md` for step-by-step instructions. High-level:

1. **Single-container Cloud Run (primary target):**
   - `Dockerfile` builds the frontend, installs backend production dependencies, copies both into a `node:20-slim` image.
   - `cloudbuild.yaml` builds, tags, pushes, and deploys to Cloud Run `consignment-packing` in `europe-west1`.
   - Attach `JWT_SECRET` and mail API keys as Cloud Run env vars from GitHub Secrets (deploy workflow; Secret Manager not required).
   - Custom domain target: `consignment.youthnic.shop`.
2. **Firebase Hosting (frontend-only):**
   - `firebase.json` serves `frontend/dist` with SPA rewrite.
   - `npm run deploy` builds and deploys the frontend.
3. **Post-deployment:**
   - Update `ALLOWED_ORIGINS` in backend env.
   - Update `VITE_API_URL` in `frontend/.env.production` (often empty for same-origin on Cloud Run).
   - Configure CORS on the Cloudflare R2 bucket (see `backend/scripts/apply-cors.js`).
   - Add the production domain to Firebase Auth authorized domains.

---

## Common Pitfalls for Agents

1. **Supabase is required for operational data.** If `SUPABASE_DB_URL` is missing and `ALLOW_MEMORY_FALLBACK=false`, operational API writes will fail with `DATASTORE_UNAVAILABLE`. Firestore is disabled by default (`ALLOW_FIRESTORE_DATA=false`).
2. **Firebase Auth is required for login.** Unless `ALLOW_LEGACY_PASSWORD_LOGIN=true`, the legacy `/api/auth/login` endpoint is unavailable.
3. **Frontend proxy only works in dev.** In production, the backend serves `frontend/dist` or the frontend must call the backend directly via `VITE_API_URL`.
4. **Packing sessions:** Active in-memory sessions are lost on server restart, but `packing_drafts` and the frontend IndexedDB queues preserve work.
5. **File uploads have two paths:** Prefer the frontend-direct-to-Firebase path plus `POST /api/uploads/metadata`. The legacy multipart path still works but uploads through the backend.
6. **Realtime tokens expire in 1 hour.** The frontend should refresh them before expiry; `AuthContext` handles this via `/api/auth/realtime-token`.
7. **Production startup will fail** if `JWT_SECRET` is missing, or if the Firebase admin account is missing and `ADMIN_PASSWORD` is not set for one-time bootstrap.
8. **Missing batch files:** The repo only contains `run.bat`. `setup.bat`, `build.bat`, and `start.bat` referenced in older docs are not present; use the `package.json` scripts instead.
