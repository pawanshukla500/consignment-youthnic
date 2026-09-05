# Youthnic Packing Station 0.2.0 — validation and handoff

Date: 2026-09-05. Windows x64 build, Electron 37.10.3.

## Follow-up: station assignment 404 (0.2.1 prepared, not deployed)

The operator's screenshot identified the missing end-to-end deployment gate.
Live `/api/health` returned HTTP 200 with `database: connected`. GitHub main and
the latest successful deploy still pointed to `7c6ec03b1efcf4bfe6bdbe11bf40f53382ceb75c`
(September 1); that source contains neither `/packing/lease/claim` nor desktop
box operation IDs. The desktop changes remained local. An unauthenticated
request returns 401 from the parent packing router, so that response does NOT
prove that the lease handler exists.

Prepared changes now add the desktop tables during normal backend schema
initialization using the existing configured database, a public read-only
desktop protocol/schema readiness probe, a client preflight before shipment
load/assignment, and release gates for the service and custom domain. The
readiness probe checks actual required columns and the unique active-station
index, not just database connectivity. Schema errors do not enable memory
fallback. Unknown API routes return JSON 404 instead of hanging in SPA routing.

UI feedback retains the entered ID and explicitly says when the server update
is required, following the UI/UX error-recovery guidance. No ownership check is
bypassed. The new live gate correctly fails against the current production
deployment with `DESKTOP_SERVER_UPGRADE_REQUIRED`.

The desktop schema is deliberately additive against the canonical
`documents`-based consignment store. It does not require the optional
normalized `consignments` table to exist; each lease and box operation is
instead validated and locked transactionally by the packing route. A
previously downloaded, operator-owned consignment continues to load when the
desktop server contract is missing, with an explicit warning that new box data
and video remain safely local until the server update is deployed. A new
consignment remains blocked because it cannot safely acquire a cloud station
lease from an outdated server.

Validation: 28 desktop tests, 66 frontend tests, the backend regression chain,
the current unpacked Windows build and its end-to-end smoke test, and lint (0
errors, 31 existing warnings) pass. Production database table
contents/permissions are not directly verified from this workstation: there is
no configured backend connection here. Publishing/deploying the reviewed
changes requires live deployment approval. Installing 0.2.1 alone cannot
provide the missing server functionality. NSIS installer creation is currently
blocked by Windows locking Electron Builder's disposable 7-Zip extraction cache,
so the existing installer must not be treated as this revised build.

## Login failure identified

Axios rejected the absolute `app://youthnic/api` URL with `Unsupported protocol
app:` before reaching the application service. The desktop renderer now uses
relative `/api` URLs through the main-process proxy. The packaged smoke test
reproduces the old failure and verifies both GET and JSON POST with the actual
bundled Axios instance. This identifies a client transport defect, not evidence
that the operator entered an incorrect password.

## Delivered

- Backend-verified identity and session encrypted using the OS credential store.
  Offline restart restores that identity; server-confirmed revoked access does
  not receive an offline bypass. Online provider refresh and explicit sign-out
  remain available. Desktop social popup buttons are hidden because that flow
  is not supported by the packaged custom origin.
- Automatic first-launch storage folders, SQLite WAL with FULL durability,
  local video/proof files, and an immutable scan audit. Every repeated physical
  barcode is independently counted; replay of an event ID is idempotent.
- Closed boxes reject further scans, stale UI snapshots cannot overwrite the
  durable items, and Undo is persisted before the UI updates.
- Background sequence: box data, its verified video, then the next box.
  Transport failures stay queued. Restart recovers interrupted jobs; expired
  multipart uploads and lost completion acknowledgements are handled using the
  existing authenticated list-parts/object-head endpoints.
- One main-process worker, one active video upload, 8 MiB part reads, direct
  camera recording without transcoding, disk-space guards and recording write
  backpressure. Accepted scan logging avoids a redundant synchronous log write.
- Consignments / Sync center / Station settings home, using existing Youthnic
  styles and the web three-zone packing screen. UI/UX review guidance informed
  explicit offline, pending, success and recovery feedback rather than a static
  “all systems operational” label.
- Main-frame IPC, role/permission checks and operator-owned local snapshots.
  Backend station checks guard packing routes and transactional box commits.

## Verification performed

| Check | Result |
| --- | --- |
| Desktop tests | 28 passed |
| Frontend tests | 66 passed across 10 files |
| Backend regression/security script chain | Passed, isolated from live credentials |
| Frontend lint | 0 errors, 31 warnings |
| Normal web production build | Passed; large-chunk warning remains |
| Windows unpacked build | Passed; current executable smoke-tested |
| Windows NSIS installer | Blocked only by an EPERM lock while Electron Builder extracts its disposable 7-Zip cache; no new installer is claimed |
| Packaged Axios GET and login POST | Passed against loopback fixture |
| Protected session + queued work after offline restart | Passed |
| Actual packing screen + simulated camera | Offline load, scan, weight, video finalization and Next Box passed |
| Synthetic 250 repeated scans | 250 durable records after restart; p50 3.73 ms, p95 4.95 ms, p99 10.01 ms on this machine |
| Public production health endpoint | HTTP 200, status ok; no authenticated production write performed |

The scan timings measure local SQLite calls, not scanner-to-screen latency or
performance on the target 2-core/4 GB computer. The simulated camera produced
a finalized media container; it is not a physical camera acceptance test.

## Installer

Current smoke-tested executable: `desktop/release/win-unpacked/Youthnic Packing Station.exe`

The existing `desktop/release/Youthnic-Packing-Station-Setup.exe` predates the
latest cache-fallback change. Do not distribute it as 0.2.1 until NSIS
packaging completes and its checksum is regenerated.

The installer is **not digitally signed**. A trusted release requires the
organization's code-signing process; no security settings were disabled.

## Remaining release gates

1. Roll out/review the backend changes and desktop lease/idempotency schema
   using the configured deployment pipeline. This task did not deploy or apply
   a production migration. The installer alone does not upgrade the server.
2. Verify real Firebase login, account expiry/revocation, authenticated box
   replay and R2 object verification in staging with an authorized operator.
3. Run a physical scanner/camera shift on the target low-spec hardware,
   including unplugged internet, restart, slow disk and disk-full scenarios.
4. Build and exercise Ubuntu packages with a working OS secret store. Packaging
   configuration exists; no Ubuntu artifact or Linux acceptance is claimed.
5. Review interrupted `.part` evidence before operational acceptance. Partial
   recordings remain on disk and are surfaced for review, but automatic repair,
   concatenation and complete footage recovery are not implemented. Finalized
   files are preserved even if a crash occurs before box metadata commits; they
   may require manual association/review. Do not delete the recovery directory.
6. Keep the app open to upload. Pending jobs resume on its next launch; there is
   no always-running service when the application is closed. Automatic local
   evidence deletion is disabled, so capacity needs operational monitoring.
7. Full cross-route concurrency acceptance (including administrative edits and
   browser draft ownership during station assignment) remains a staging gate.

## Reproduce

From repository root:

```powershell
npm run desktop:test
npm run test
npm run lint
npm run build
npm run desktop:package
node desktop/scripts/smoke-packaged.cjs
```

The smoke test uses a temporary data directory, a loopback API fixture and a
simulated camera. It never reads the operator's real session or signs in to
production. Its screenshot is `desktop/release/smoke-offline-sync.png`.
