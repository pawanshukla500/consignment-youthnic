# Security Fix Implementation Report

## Issue checklist

| ID | Status | Notes |
|----|--------|-------|
| C1 | Fixed | Password hashes stripped; Realtime lockdown migration |
| C2 | Fixed | Hardcoded admin password removed; production bootstrap hardened |
| H1 | Fixed | Server-side permission gates on reads + realtime-token |
| H2 | Fixed | Increment uses advisory lock + same-client txn; respond after commit |
| H3 | Fixed | Live scans no longer write authoritative packedQty |
| H4 | Fixed | Legacy `/skus/:skuId/pack` returns 410; client method removed |
| H5 | Fixed | DELETE mirror trigger + orphan cleanup migration |
| M1 | Fixed | `isActive` + `tokenVersion` checked on every authenticated request |
| M2 | Fixed | Welcome email imports `FROM_EMAIL` from Mailgun util |
| M3 | Fixed | Exact CORS allowlist; no `*.run.app` wildcard |
| M4 | Fixed | Decrement / finish revert Ready→Under Packing when incomplete |
| M5 | Fixed | Safer video replace order; active flag; index migration |
| M6 | Fixed | Postgres LISTEN/NOTIFY for cross-instance SSE |
| L1 | Fixed | `GET /consignments/:id/labels` CSV download |
| L2 | Partially fixed | Removed dead login/multipart/packSku clients; more cleanup in L5 |
| L3 | Partially fixed | Not fully paginated yet — remaining limitation |
| L4 | Fixed | Trusted `storageVerifiedAt` cache (24h) on finish checks |
| L5 | Partially fixed | Report + rotation docs + matrix; AGENTS still needs full rewrite |

## Database architecture confirmation (runtime)

- **Primary store:** `documents(collection, id, data JSONB)` via `pgHelpers`
- **Normalized tables:** Trigger mirrors for Realtime (INSERT/UPDATE + DELETE after H5)
- **Auth credentials:** Firebase Authentication only
- **Email:** Resend
- **Sync:** Supabase Realtime → SSE (LISTEN/NOTIFY) → polling

## Migrations added

1. `supabase/migrations/20260713000000_strip_user_secrets_and_realtime_lockdown.sql`
2. `supabase/migrations/20260713000001_sync_documents_delete_trigger.sql`
3. `supabase/migrations/20260713000002_one_active_video_per_box.sql`

**Deploy:** apply these to the production Supabase/Postgres project before relying on Realtime lockdown / delete mirroring.

## Environment variable changes

| Variable | Change |
|----------|--------|
| `FIREBASE_WEB_API_KEY` | Optional; verifies self password change |
| `ADMIN_PASSWORD` | One-time bootstrap only; never hardcoded |
| `ALLOWED_ORIGINS` | Exact origins required for Cloud Run URLs (no wildcard) |
| JWT lifetime | Reduced to 8h |

## Validation performed

```
node scripts/test-sanitize-user.js → passed
node scripts/test-env-validation.js → passed
node scripts/test-permissions.js → passed
node scripts/test-cors-allowlist.js → passed
node scripts/test-auth-active.js → passed
node scripts/test-shipment-status.js → passed
node scripts/test-packing-increment-integrity.js → passed
node scripts/packing-quantity-scenario-test.js → passed
```

## Remaining known limitations

1. Apply DB migrations to live database (not auto-applied via MCP — wrong Supabase project connected).
2. Rotate any historically shared admin password in Firebase Console now (`docs/ADMIN_PASSWORD_ROTATION.md`).
3. L3 full-collection scan optimizations incomplete (audit/retention/reconcile).
4. Per-warehouse row-level API scoping not implemented.
5. Video metadata multi-document writes still not one Postgres transaction (replace order improved).
6. Set exact Cloud Run URL in `ALLOWED_ORIGINS` after deploy.

## Deployment / rollback

1. Deploy backend with new code.
2. Apply the three SQL migrations.
3. Set `ALLOWED_ORIGINS` to exact production URLs.
4. Set `FIREBASE_WEB_API_KEY` for self password change.
5. Rotate admin password if previously shared.
6. Rollback: redeploy previous image; reverse publication/RLS changes per migration comments (password hashes cannot be restored).
