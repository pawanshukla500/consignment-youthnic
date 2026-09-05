# Youthnic Packing Station Desktop Plan

## Phase 0 findings

The current web Packing Station is a React/Vite page at `frontend/src/pages/PackingStation.jsx`.
It already provides several pieces that are worth preserving:

- Firebase Auth exchanges an ID token for the existing backend application JWT.
- `packingAPI.load` returns the SKU view, saved box contents, shipment metadata, and packing totals.
- `videoQueue.js` writes one-second MediaRecorder chunks to IndexedDB, recovers interrupted recordings, and only removes local evidence after the backend returns `verified: true`.
- `videoUpload.worker.js` supports signed R2 uploads, same-origin proxy fallback, multipart uploads, resume state, retries, and server verification.
- `packingSyncQueue.js` stores immutable box item snapshots, weight data, and retry state for box-level replay.
- `backend/routes/packing.js` serializes packing mutations and the scan ledger uses a durable `scan_id` replay guard.
- `backend/routes/uploads.js` already exposes authenticated signed-upload, multipart, object-head, and verified metadata endpoints.

The important gaps are equally specific:

- The browser does not persist a complete packing snapshot in a local relational database.
- The current web scan handler updates React state; the removed scan queue means accepted scans are not independently durable before a box save.
- The browser save path uses multiple IndexedDB transactions and React state rather than one SQLite transaction spanning the final box, proof/video references, and outbox jobs.
- There is no Electron shell, local filesystem video store, station identity, station lease, or desktop sync center.
- `/api/packing/save-box` has transactional quantity protection but no immutable box operation idempotency key.
- Finish is guarded by the browser upload queue, but there is no desktop-local readiness gate that distinguishes local safety from cloud completeness.
- The current browser worker defaults to two concurrent video uploads; the desktop client will use one.

## Reuse boundary

The desktop app will reuse the existing React Packing Station UI, Firebase login, Axios API contract, barcode normalization helpers, camera/MediaRecorder behavior, and R2 multipart protocol. It will not embed PostgreSQL, Supabase service credentials, R2 secrets, or a second backend.

The desktop-only storage adapter will be selected through `window.youthnicDesktop`. The web path remains the current IndexedDB/API implementation. The desktop path writes SQLite and local files in Electron's user-data directory, then lets a main-process sync engine call the same authenticated backend APIs.

## Proposed files

```text
desktop/
  package.json
  main.cjs
  preload.cjs
  scripts/copy-frontend.mjs
  src/
    database.cjs
    files.cjs
    logger.cjs
    stateMachine.cjs
    syncEngine.cjs
    backendClient.cjs
    ipc.cjs
  test/
    database.test.cjs
    stateMachine.test.cjs
  renderer/                 # generated from frontend/dist; ignored
```

Backend changes are limited to `packing_box_operations` idempotency records, `packing_station_leases`, lease routes, and the `operation_id` field on save-box requests. Existing web clients may omit the new fields and continue using their current behavior.

## SQLite design

SQLite is local-only and opened by the Electron main process with foreign keys, `busy_timeout`, WAL journaling, and `synchronous=FULL`. Video/image bytes never enter SQLite.

```text
desktop_station
local_consignments
local_skus
local_boxes
local_box_items
local_scan_events
local_weight_proofs
local_videos
sync_outbox
sync_attempts
app_settings
schema_migrations
```

Important constraints and indexes:

- `local_consignments.consignment_id` and `(consignment_id, sku_id)` are primary keys.
- `local_boxes` has a unique `(consignment_id, box_no)` and a state/operation id.
- `local_box_items` has a unique `(box_id, sku_id)`.
- `local_scan_events.id` is the immutable local scan idempotency key.
- `sync_outbox.id` is a deterministic job id (`box:<operation-id>` or `video:<video-id>`), preventing duplicate local jobs.
- lookup indexes cover local barcode aliases, outbox readiness, and per-consignment status.

## Local file layout

```text
<Electron userData>/YouthnicPacking/
  database/packing.sqlite
  database/packing.sqlite-wal
  consignments/<consignment-id>/videos/<video-id>.webm
  consignments/<consignment-id>/videos/recovery/<video-id>.part
  consignments/<consignment-id>/proofs/<proof-id>.jpg
  logs/packing-station.log
```

Only bounded MediaRecorder chunks cross IPC. The main process appends and datasyncs every chunk to a `.part` file, fsyncs on finalization, computes metadata, and renames the file. Renderer backpressure pauses recording/scanning when pending chunks reach 8 MiB. Unfinished `.part` files remain available for recovery inspection; they are not automatically concatenated with a new MediaRecorder stream.

## Local state machine

```text
OPEN
  -> CLOSED_LOCAL -> QUEUED -> DATA_SYNCING -> DATA_SYNCED
                                      |               |
                                      v               v
                                  RETRY/FAILED   VIDEO_QUEUED
                                                      -> VIDEO_UPLOADING
                                                      -> VIDEO_VERIFYING
                                                      -> SYNCED
```

`CLOSED_LOCAL` is the operator-facing safety boundary. `SYNCED` is only set after the box response is idempotently accepted and every required video has returned verified metadata. Retry transitions retain all local files and payloads.

## Backend/API changes

1. Add `operation_id` to `/api/packing/save-box`. PostgreSQL stores the request fingerprint and the committed result. Replaying the same operation returns the original result; reusing the operation id with a different payload returns `409`.
2. Add authenticated lease endpoints under `/api/packing/lease` for claim, renew, inspect, and release. A different station cannot claim an active consignment; an elevated user can force-release a stale lease.
3. Reuse the existing upload endpoints for weight proof and R2 multipart video upload. No production database migration is needed for the desktop client beyond the idempotency/lease tables.

## Risks and controls

- SQLite runtime availability differs by Electron/Node version. The desktop layer uses Node's built-in `node:sqlite` API, and release CI builds Windows and Ubuntu separately against Node 22.
- Firebase application JWTs expire. The desktop restores its OS-encrypted backend-verified identity while offline and refreshes an expired application token through the existing Firebase session when online. Explicit revocation, logout or lost provider/OS credentials requires signing in again. Insecure Linux `basic_text` credential storage is rejected.
- Local disk exhaustion is handled before starting recording and before finalizing a box. Unsynced evidence is never deleted automatically.
- An offline station lease cannot be renewed while disconnected. V1 therefore permits only one claimed station per consignment and requires explicit admin recovery after a stale lease.
- Existing browser packing remains on its current code path. Desktop-specific behavior is guarded by `window.youthnicDesktop`, and the existing web build is run as a separate CI check.

## Performance target

The desktop client uses one BrowserWindow, one main-process sync loop, one video upload at a time, bounded file reads (8 MiB multipart parts), short SQLite transactions, throttled status events, and lazy local snapshot queries. Camera defaults remain 1280x720 at approximately 15–20 FPS without transcoding.

## Acceptance sequence

Desktop tests cover snapshot persistence, scan durability, local box close, restart recovery, deterministic outbox ids, duplicate save-box replay, state transitions, lease conflicts, retry preservation, and disk thresholds. Full acceptance still requires a Firebase-authenticated staging session, a reachable TLS PostgreSQL database, R2 verification, and Windows/Ubuntu package smoke tests.
