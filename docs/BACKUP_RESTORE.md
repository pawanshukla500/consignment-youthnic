# PostgreSQL Backup & Restore (Local / Office Server)

This app is designed to run against a **locally hosted PostgreSQL** server with
daily encrypted backups stored in Google Drive. You do **not** need Cloud SQL
for a reliable setup if you follow this checklist.

## Goals

- Daily encrypted dumps of `consignment_db`
- Encryption key never stored in Google Drive
- Retention + prune of old local archives
- Email alert when a backup fails
- Periodic restore test into a **separate** database

## One-time setup

1. Install PostgreSQL client tools so `pg_dump` / `pg_restore` are on `PATH`
   (or set `PG_DUMP_PATH` / `PG_RESTORE_PATH`).
2. Create a long random encryption secret (32+ characters) and store it offline
   / in a password manager — **not** in Drive:

```bat
setx BACKUP_ENCRYPTION_KEY "replace-with-a-long-random-secret-at-least-32-chars"
```

3. Optional alert recipient (uses Mailgun):

```bat
setx BACKUP_ALERT_TO "admin@yourdomain.com"
```

4. Ensure the DB host is on a **private LAN** (e.g. `192.168.x.x`) and **not**
   open to the public internet. Prefer Windows Firewall allowlist for office IPs only.

## Daily backup (Task Scheduler)

From `backend/`:

```bat
node scripts/backup-postgres.js
```

Successful run writes one of:

- `backend/backups/consignment_db-<timestamp>.dump.enc` (when `pg_dump` is installed)
- `backend/backups/consignment_db-<timestamp>.json.enc` (automatic fallback using node-pg)

Plus a matching `.sha256` checksum file.

Then copy the `.dump.enc` (+ `.sha256`) into your Google Drive backup folder
(manual, rclone, or Drive desktop sync of the `backups/` folder).

Recommended Task Scheduler settings:

- Trigger: daily after packing hours
- Action: `node C:\...\backend\scripts\backup-postgres.js`
- Start in: `C:\...\backend`
- Environment: `BACKUP_ENCRYPTION_KEY`, `DATABASE_URL` (or rely on `backend/.env`)

Env knobs:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BACKUP_DIR` | `backend/backups` | Local archive directory |
| `BACKUP_RETENTION_DAYS` | `30` | Auto-delete older local `.dump.enc` |
| `BACKUP_ALERT_TO` | unset | Mailgun failure alert recipient |
| `BACKUP_ENCRYPTION_KEY` | required | AES-256-GCM key material |

## Restore test (monthly)

1. Create an empty test database on the same server, e.g. `consignment_db_restore_test`.
2. Run:

```bat
set TEST_DATABASE_URL=postgresql://USER:PASS@192.168.56.40:5432/consignment_db_restore_test
node scripts/restore-postgres-test.js backups\consignment_db-....dump.enc
```

The script refuses to restore into a database named exactly `consignment_db`
unless `ALLOW_RESTORE_TO_PRIMARY=true` (emergency only).

## Disaster recovery (production)

1. Stop the API (`Ctrl+C` / stop the Windows service / Cloud Run revision).
2. Restore the latest known-good encrypted dump into a **new** database first and verify.
3. Only then cut over `DATABASE_URL` / swap database names during a maintenance window.
4. Rotate DB password + `JWT_SECRET` if the outage involved a possible compromise.

## What this does **not** cover

- Cloudflare R2 videos/documents — keep a second R2 bucket or scheduled rclone sync for backups and
  export critical media separately if required for legal retention.
- Point-in-time recovery (WAL archiving) — optional later upgrade for the office server.

## Security notes

- Never commit `backend/.env`, `BACKUP_ENCRYPTION_KEY`, or unencrypted `.dump` files.
- Prefer keeping Postgres bound to the LAN (`listen_addresses` + firewall).
- SSL is optional on a trusted private LAN; require `DB_SSL=true` if the DB is
  reachable across untrusted networks.
