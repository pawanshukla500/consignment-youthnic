# Route & permission matrix (post-H1)

Legend: Auth = JWT required. Admin = `requireRole('admin')`. Perm = named permission. Any = `requireAnyPermission`.

| Method | Path | Gate |
|--------|------|------|
| GET | /api/health | Public |
| GET | /api/auth/status | Public |
| POST | /api/auth/firebase-login | Public (rate-limited) |
| POST | /api/auth/forgot-password | Public (rate-limited) |
| POST | /api/auth/resync-admin | Bootstrap secret |
| GET | /api/auth/me | Manual JWT |
| GET | /api/auth/realtime-token | Auth + Any(consignments\|packing) |
| POST | /api/auth/logout | Auth |
| POST | /api/auth/send-password-link | Auth + Admin |
| GET | /api/consignments | Auth + consignments |
| GET | /api/consignments/:id | Auth + Any(consignments\|packing) |
| GET | /api/consignments/:id/packing-report | Auth + Any(consignments\|packing) |
| POST/PUT | /api/consignments… | Auth + consignments |
| DELETE | /api/consignments/:id | Auth + deleteConsignments |
| POST | /api/consignments/…/pack\|boxes | Auth + packing |
| * | /api/packing/* | Auth + packing (router-level) |
| GET | /api/marketplaces | Auth + Any(marketplaces\|consignments) |
| POST/PUT/DELETE | /api/marketplaces | Auth + marketplaces |
| GET | /api/docket-companies | Auth + consignments (admin bypass) |
| POST/PUT/DELETE | /api/docket-companies | Auth + Admin |
| GET | /api/productivity/dashboard-summary | Auth + Any(consignments\|packing\|productivity) |
| GET | /api/productivity | Auth + productivity |
| GET | /api/productivity/planning | Auth + productivity |
| GET | /api/productivity/audit | Auth + auditLogs |
| GET | /api/sync/changes\|events | Auth + Any(consignments\|packing) |
| GET/POST | /api/uploads/* | Auth + packing or Any(consignments\|packing) for reads |
| DELETE | /api/uploads/:fileId | Auth + deleteVideos / consignments (in-handler) |
| GET | /api/settings/packing | Auth + Any(packing\|consignments) |
| * | /api/settings (other) | Auth + Admin |
| * | /api/users (admin list/CRUD) | Auth + Admin |
| GET/PUT | /api/users/me | Auth |
| * | /api/audit-logs | Auth + Admin (my-activity: Auth) |
| GET | /api/templates/consignment | Auth + consignments |
| POST | /api/email/send\|welcome | Auth + Admin |
| POST | /api/email/notify-consignment | Auth + Any(consignments\|packing) |

## Not yet enforced (remaining H1 concern)

Per-warehouse / per-department row scoping is not modeled as hard filters on every query. Realtime RLS still allows any authenticated app user with a realtime token to read packing-related tables (users collection excluded after C1). Full multi-tenant row scoping is a follow-up.
