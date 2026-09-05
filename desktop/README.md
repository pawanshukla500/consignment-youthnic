# Youthnic Packing Station Desktop

The desktop client wraps the existing React Packing Station in Electron and
adds local-first storage for packing work. The Electron main process owns
SQLite, local evidence files, authenticated API calls, and the retrying sync
outbox. The renderer receives only the narrow APIs exposed by `preload.cjs`.

## Development

From the repository root:

```bash
npm run desktop:install
npm run desktop:test
npm run desktop:package
```

`desktop:package` first builds `frontend/dist`, copies it into the desktop
bundle, and produces the platform-native artifact in `desktop/release/`:

- Windows: `Youthnic-Packing-Station-Setup.exe`
- Ubuntu/Linux: `Youthnic-Packing-Station-<version>.AppImage` and `.deb`

For local development with the Vite server, set
`YOUTHNIC_PACKING_DEV_URL=http://localhost:5173` before running
`npm --prefix desktop run dev`. The packaged client defaults to
`https://consignment.youthnic.shop/api`; override it at process startup with
`YOUTHNIC_PACKING_API_URL` when using another backend.

The packaged renderer runs on the secure local `app://youthnic` origin. API
requests are proxied by Electron's main process to the configured backend, so
login and sync are not blocked by browser CORS rules.

## Local data and recovery

Electron creates and stores data under its OS user-data directory in
`YouthnicPacking/`:

- `database/packing.sqlite` and its WAL files
- `consignments/<id>/videos/` and `videos/recovery/*.part`
- `consignments/<id>/proofs/`
- `logs/packing-station.log`

On Windows this is normally `%APPDATA%\youthnic-packing-station-desktop\YouthnicPacking`
(the exact parent folder can vary by Electron packaging metadata).
The folders are created automatically on the first app start; no manual path
configuration is needed. Outbox jobs remain local while offline and retry
until box data and its verified video reach the backend.

Accepted scans, closed-box snapshots, evidence metadata, and sync jobs are
committed locally before the UI reports success. `.part` recordings are
retained and detected on restart for review. A fresh recorder must not append
a second WebM container to a partial file. Interrupted camera evidence needs
operator review; it is not claimed to be automatically repaired or continuous.
Completed recordings are flushed, renamed and hashed. Local evidence is never
deleted by the sync engine.

Sign in online once. The backend-verified identity and application session are
encrypted with the operating system credential store. Download and claim a
consignment online before using it offline. Explicit logout, revoked access,
or an unrecoverable credential-store change can require signing in again.

The desktop home contains Consignments, Sync center and Station settings.
The packing screen reuses the web three-zone workflow. Box close waits for
accepted scans and video writes, then queues box data followed by video. Only
verified cloud uploads permit Finish. Keep the application open to sync;
closed applications resume their queues at the next launch.

## Packaged smoke test

After packaging on Windows, run `node desktop/scripts/smoke-packaged.cjs` from
the repository root. It launches only the specified build with a temporary
data directory, local mock API and simulated camera. It does not sign in to
production or access a real operator's data. Test output identifies the
retained fixture directory and a screenshot under `desktop/release/`.

The backend remains the source of truth. Desktop sync uses the existing
authenticated API and R2 signed/multipart upload endpoints; no PostgreSQL,
Supabase service-role, Firebase service-account, or R2 secret is bundled in the
desktop application.
