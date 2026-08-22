# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Consignment Packing App (branded "Youthnic Packing Station") — a private full-stack app for VB Exports that manages consignment inward → packing → invoice → dispatch → inward-completion, with barcode packing stations, video/document evidence, productivity analytics, and inventory planning.

`AGENTS.md` is the long-form guide (env vars, route table, deployment, security notes). It is mostly accurate but predates the current test suite and the Postgres-only datastore — trust this file and the source where they disagree.

## Commands

Run from the repo root unless noted. Node 22+ (`engines`), npm workspaces are *not* used — each of `/`, `backend/`, `frontend/` has its own `package.json` and lockfile.

```bash
npm run install:all      # install root + backend + frontend
npm run dev              # concurrently: backend :5000 + frontend :5173 (Vite proxies /api → :5000)
npm run dev:backend      # nodemon backend/server.js
npm run dev:frontend     # vite
npm run build            # vite build → frontend/dist
npm start                # backend serves API + frontend/dist
npm run lint             # frontend ESLint (backend `npm run lint` is a no-op stub — no ESLint config there)
npm test                 # backend tests then frontend tests
```

### Tests

Backend "tests" are standalone Node scripts in `backend/scripts/test-*.js`, chained by `backend/package.json`'s `test:security` script (which `npm test` aliases). They require `JWT_SECRET` and `NODE_ENV=test`; the root scripts inject test defaults for you.

```bash
npm run test:backend                              # whole backend chain, env pre-set
cd backend && JWT_SECRET=test-only NODE_ENV=test npm run test:permissions   # one backend test
cd frontend && npm test                           # vitest run
cd frontend && npx vitest run src/utils/__tests__/printHtml.test.js         # one frontend test
cd frontend && npm run test:watch
npm run test:security                             # backend chain + the frontend security subset
```

When you add a backend test script, register it in `backend/package.json` **and** append it to the `test:security` chain, or CI will not run it.

CI (`.github/workflows/deploy.yml`, `quality-gates` job) runs: backend lint, frontend lint, frontend build, backend tests, frontend tests, security tests, and `npm audit --omit=dev --audit-level=high` in both packages. It deploys to Cloud Run only on push to `main`.

Operational (non-CI) scripts also live in `backend/scripts/`: `test-db.js`, `smoke-test.js`, `db-health-check.js`, `retentionCleanup.js`, `apply-supabase-schema.js`, `backup-postgres.js`, `apply-cors.js`.

## Architecture

### Datastore

Everything operational is PostgreSQL (Supabase, Neon, Cloud SQL, or CockroachDB Cloud — see `backend/utils/dbConnection.js` for URL resolution/validation from `SUPABASE_DB_URL` || `DATABASE_URL`).

- `backend/utils/helpers.js` exports `firestoreHelpers`, which is now **just `pgHelpers`** — the name is a legacy alias kept because every route imports it. There is no Firestore or in-memory fallback path any more.
- `backend/utils/pgHelpers.js` holds both the JSONB document API (`getDocument`/`setDocument`/`queryCollection` over the `documents(collection, id, data JSONB)` table) and optimized queries against the normalized tables. New reads should prefer the normalized tables; the JSONB `documents` bridge remains the write path for many collections, so a change often has to touch both.
- `backend/utils/dbDialect.js` abstracts Postgres vs CockroachDB differences. Notably `acquireTxSerializationLock` uses `pg_advisory_xact_lock` on Postgres and a `SELECT … FOR UPDATE` on the consignment row on Cockroach. Any new transaction that serializes on a logical key must go through it rather than calling advisory locks directly.
- Schema: bootstrap DDL in `backend/config/database.js`; normalized operational tables (consignments, skus, boxes, box_items, videos, shipment_documents, audit_logs, productivity_events, scan_events, …) in `supabase/migrations/`.

### Backend

`backend/server.js` mounts one router per domain under `/api/*` (`routes/`), applies helmet/compression, CORS **only on `/api`** (static frontend bypasses it deliberately), and tiered rate limiters (login, `/api/uploads/stream`, `/api/packing` scans, general). Note `routes/workflow.js` exports `{ router, … }` — it is mounted as `require('./routes/workflow').router` and also re-required at the bottom of `server.js` for background jobs.

Auth is two-layer: the browser signs in with Firebase Auth, posts the ID token to `POST /api/auth/firebase-login`, and gets a 24h app JWT that every other endpoint checks (`middleware/auth.js`). SSE (`/api/sync/events`) additionally accepts `?token=` because `EventSource` cannot set headers.

Authorization has three tiers, all centralized in `backend/utils/permissions.js`: role (`admin` and `organization_head` are "elevated" and bypass all checks), per-feature booleans on `user.permissions`, and sensitive-action flags (`deleteConsignments`, `deleteVideos`, `editBoxQuantities`) that are never granted implicitly to non-elevated roles. `docs/ROUTE_PERMISSION_MATRIX.md` maps routes to required permissions.

Consignment lifecycle logic is not in the routes: `backend/utils/consignmentWorkflow.js` owns the stage gate machine (`packing_completed → ready_for_invoice → invoice_created → ready_for_dispatch → dispatched → inward_completed`), TAT/escalation, and department auto-assignment; `shipmentStatus.js`, `dispatchPlanning.js`, `criticality.js`, and `inwardDisputes.js` feed it. Add lifecycle rules there, not in `routes/consignments.js`.

Uploads go browser → Cloudflare R2 via a backend-issued presigned PUT, then `POST /api/uploads/metadata` persists the record; playback is the authenticated Range-capable `GET /api/uploads/stream/:fileId`. One video per (consignmentId, boxNo) — a new one replaces the old.

Packing keeps live sessions in memory in `routes/packing.js`, mirrored to Postgres by `utils/packingDraft.js` / `packingPersistence.js` so a restart does not lose scans.

### Frontend

React 19 + Vite + Tailwind v4 (`@import "tailwindcss"` and a `@theme` block in `src/index.css`; no tailwind.config). All pages in `src/App.jsx` are lazy-loaded behind `PrivateRoute` / `AdminRoute` / `PermissionRoute` guards.

Global state is three contexts, no store library: `AuthContext` (Firebase sign-in, app JWT in sessionStorage, idle timeout, realtime-token refresh), `ToastContext`, and `ConsignmentSyncContext`.

`ConsignmentSyncContext` degrades in three steps and code touching live updates must keep all three working: Supabase Realtime `postgres_changes` → SSE `/api/sync/events` → polling `/api/sync/changes` every 8s.

Offline resilience is IndexedDB-backed queues in `src/utils/` — `scanQueue`, `packingSyncQueue`, `videoQueue` — drained by `src/services/videoUploadService.js` on a timer and on `online`/`visibilitychange`. Barcode scanning and box saves must enqueue rather than assume connectivity.

All HTTP goes through the single Axios instance in `src/services/api.js` (named modules `consignmentsAPI`, `packingAPI`, …); its interceptors attach the JWT and redirect to `/login` on 401.

## Conventions

- Backend: CommonJS, semicolons, `async/await`, `try/catch` + `console.error` in handlers, errors as `res.status(n).json({ error })`, `module.exports = router`.
- Frontend: ESM, functional components, **no semicolons**, single quotes, `lucide-react` icons only, Tailwind utilities inline. 2-space indent everywhere; no Prettier config.
- Never commit `backend/serviceAccountKey.json`, `.env`, or `frontend/.env.production`.
