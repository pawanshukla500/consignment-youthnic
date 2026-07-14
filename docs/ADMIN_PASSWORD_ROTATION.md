# Admin password rotation

Firebase Authentication is the source of truth for passwords. The app must never store password hashes in Postgres `documents` or commit passwords to git.

## Immediate action after C2

If any environment previously used a shared/default admin password from older documentation:

1. Open Firebase Console → Authentication → Users.
2. Select the admin account (`ADMIN_EMAIL`).
3. Reset the password to a unique strong secret (16+ characters, password manager).
4. Optionally call `POST /api/users/:id/logout-all` as admin to revoke Firebase refresh tokens.
5. Remove any `ADMIN_PASSWORD` from Cloud Run env once the Firebase account exists (bootstrap only needs it for first create).
6. Confirm login with the new password on the production URL.

## First-time bootstrap (new environment)

1. Set `JWT_SECRET` (required always).
2. For production first boot only, set `ADMIN_PASSWORD` to a strong one-time secret **or** create the admin user manually in Firebase Console with the same email as `ADMIN_EMAIL`.
3. Start the server once so bootstrap can create the Firebase user (when `ADMIN_PASSWORD` is set and the user is missing).
4. Remove `ADMIN_PASSWORD` from the runtime environment after the account exists.
5. Use forgot-password / Firebase Console for later changes — do not rely on env vars for ongoing password management.

## Explicit resync (rare)

`POST /api/auth/resync-admin` with header `X-Bootstrap-Secret: <BOOTSTRAP_SECRET>` pushes the current `ADMIN_PASSWORD` into Firebase. Use only when intentionally rotating via env, then clear the env var.

## Development

- No hardcoded fallback password exists in source.
- Without `ADMIN_PASSWORD`, development can still start if the Firebase admin already exists.
- Missing admin + missing `ADMIN_PASSWORD` in production exits the process.
