# Youthnic Packing Station Desktop — Architecture & Release Guide

**TaskFlow Pro Project ID:** `9513898a-8338-4e3d-9f97-bfdc389f0466`  
**Repository:** [pawanshukla500/consignment-youthnic](https://github.com/pawanshukla500/consignment-youthnic)  
**Releases URL:** [GitHub Releases](https://github.com/pawanshukla500/consignment-youthnic/releases)

---

## 1. Overview & Objectives

The **Youthnic Packing Station Desktop Application** (`desktop/`) is a dedicated Electron desktop app tailored for rugged warehouse packing environments where network connectivity may fluctuate or drop completely.

Key operational requirements:
1. **Zero Data Loss**: Scans, box contents, weights, and video evidence are written synchronously to local disk before cloud transmission.
2. **Offline-First Packing**: Packers can complete entire boxes and consignments offline. Changes queue locally in SQLite and stream to Supabase/PostgreSQL when the connection restores.
3. **Resilient Video Streaming**: Box packing videos recorded via webcam are buffered and persisted to local files in real-time, preventing lost recordings if the app crashes or network fails.
4. **Dual Runtime Compatibility**: The same React Packing Station (`frontend/src/pages/PackingStation.jsx`) serves both modern web browsers (via IndexedDB queues) and the Electron desktop app (via `window.youthnicDesktop` IPC).
5. **Continuous Distribution**: Packaged installers (NSIS `.exe` for Windows, AppImage/deb for Linux) are automatically built and published to GitHub Releases for one-click warehouse distribution.

---

## 2. Desktop Architecture

```
desktop/
├── package.json               # Electron 37+ and electron-builder 26+
├── main.cjs                   # Main process: window management, SQLite lifecycle, IPC handlers
├── preload.cjs                # Context-isolated secure bridge exposing window.youthnicDesktop
├── scripts/
│   ├── build-frontend.mjs     # Builds frontend/dist with production base paths
│   ├── copy-frontend.mjs      # Staging built assets into desktop renderer
│   └── smoke-packaged.cjs     # Automated package verification
├── src/
│   ├── database.cjs           # SQLite driver (WAL mode, foreign keys, schema migrations)
│   ├── files.cjs              # Local filesystem manager for evidence & video chunks
│   ├── logger.cjs             # Rotating log file manager
│   ├── stateMachine.cjs       # Local box lifecycle (DRAFT -> PACKED -> SYNCED)
│   ├── syncEngine.cjs         # Background upload & reconciliation engine
│   ├── backendClient.cjs      # Authenticated API client (mirrors frontend API)
│   └── ipc.cjs                # IPC protocol definitions between main and renderer
├── test/
│   ├── database.test.cjs      # SQLite schema and transaction durability tests
│   ├── files.test.cjs         # Chunk assembly and slugging tests
│   ├── offlineWorkflow.test.cjs # End-to-end offline packing and sync tests
│   └── stateMachine.test.cjs  # Box lifecycle transition tests
└── release/                   # Build output folder for NSIS and AppImage
```

---

## 3. Packing Station Logic & Safety Invariants

The packing station UI in `frontend/src/pages/PackingStation.jsx` contains strict safeguards to ensure warehouse reliability:

### 3.1 Double-Submission & Concurrency Guards
- `boxSaving` state flag: Disables all save/close buttons while an asynchronous box save is in-flight.
- `submittedRef`: Ref-based synchronous guard that rejects duplicate enter/click events within the same event loop tick.
- `scannerGuardRef`: Hardware barcode scanner deduplication guard to ignore barcode reader bounce or double-triggering within 150ms.

### 3.2 MediaRecorder & Video Streaming Watchdog
- **Single-Flight Initialization**: Camera and recorder initialization runs through a single-flight mutex to avoid double stream allocation when toggling boxes.
- **Evidence Continuity Watchdog**: Chromium can pause MediaRecorder streams under high system load or backgrounding. A 30-second watchdog detects stalled chunk generation and auto-resumes recording.
- **In-flight Stop Coordination**: Closing a box awaits the final `recorder.stop()` event and flushes all pending byte chunks before initiating the box save call.

### 3.3 Box Label Generation
- Integrated PDF generator (`doDL`) outputs standardized 4x6 inch thermal labels containing:
  - Consignment ID & Box Number
  - SKU breakdown and quantities
  - Barcode and QR code for conveyor/carrier scanning
  - Total packed quantity and timestamp

### 3.4 Dual-Mode Storage Selection
- When running in browser: Employs `scanQueue.js`, `packingSyncQueue.js`, and `videoQueue.js` (IndexedDB).
- When running in Electron: Automatically detected via `isDesktopApp()`; delegates to `window.youthnicDesktop` which interacts with SQLite and local disk files.

---

## 4. GitHub Releases & CI/CD Pipeline

The GitHub Actions workflow at `.github/workflows/desktop-release.yml` automates testing, packaging, and publishing:

### 4.1 Trigger Modes
1. **Push to tags**: Tagging a release (e.g. `git tag v0.2.1 && git push origin v0.2.1`) triggers the full build and release.
2. **Post-Deployment**: Runs automatically following a successful Cloud Run deployment of the backend.
3. **Manual (`workflow_dispatch`)**: Can be manually triggered from the GitHub Actions tab with optional `publish_release` toggle.

### 4.2 Packaging Matrix
- **Windows (`windows-latest`)**: Builds `Youthnic-Packing-Station-Setup.exe` (NSIS installer with desktop shortcut and custom directory selection).
- **Linux (`ubuntu-latest`)**: Builds `Youthnic-Packing-Station-${version}.AppImage` and `.deb`.

### 4.3 Automated GitHub Release Publication
The `publish-release` job:
- Downloads all artifacts from the matrix build.
- Determines the release tag from git ref or `desktop/package.json`.
- Publishes or updates the release at `https://github.com/pawanshukla500/consignment-youthnic/releases` using `gh release create` / `gh release upload --clobber`.

---

## 5. Local Development & Verification

### Running the Desktop App in Development
```bash
# 1. Install dependencies
npm run install:all
cd desktop && npm install

# 2. Start dev server in desktop mode
cd desktop && npm run dev
```

### Running Durability Test Suites
```bash
# Run desktop SQLite & offline tests (34 tests)
cd desktop && npm test

# Run frontend Vitest test suite (104 tests)
cd frontend && npm test

# Run backend security & integrity tests (28 test suites)
npm run test:security
```

### Building the Production Installer
```bash
cd desktop && npm run package
# Output will be located in desktop/release/Youthnic-Packing-Station-Setup.exe
```
