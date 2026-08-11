# GitHub Actions — Cloud Run Deployment

This repo deploys to **Google Cloud Run** via `.github/workflows/deploy.yml`.

On every push to `main` (or manual **Run workflow**), the pipeline:

1. Builds the Docker image (frontend + backend)
2. Deploys to Cloud Run with **normal environment variables** from GitHub Secrets (no GCP Secret Manager)
3. Verifies `/api/health` and `/api/auth/status`

Public app URL target: **`https://consignment.youthnic.shop`**

---

## PR → continuous deploy (recommended flow)

1. Create a **feature branch** and open a **Pull Request** into `main`
2. PR events run **`Lint · Build · Test · Audit` only** (no Cloud Run deploy)
3. Review / merge the PR after the quality-gate check is green
4. Merge to `main` triggers **Deploy to Cloud Run** automatically
5. Pipeline builds, deploys with env vars from GitHub Secrets, then checks `/api/health` for **`database: connected`**

Configure required status checks manually: see **`docs/BRANCH_PROTECTION.md`**.

**Do not** enable Cloud Run “deploy from repository” — that path has **no** `DATABASE_URL` / JWT secrets and will break the DB.

### Database rules for every deploy (prevent 503)

| Rule | Why |
|------|-----|
| GitHub secret `DATABASE_URL` must be a **public** host (Cockroach Cloud / Neon / public IP) | Cloud Run cannot reach LAN IPs like `192.168.1.40` |
| Current production DB: **CockroachDB Cloud** (`*.cockroachlabs.cloud:26257`) with `?sslmode=verify-full` | Europe region near Cloud Run |
| Repo variable `DB_SSL` must be **`true`** for Cockroach / Neon / Supabase | Deploy sets this on Cloud Run |
| Deploy probes the **URL port** (Cockroach `26257`, Postgres `5432`) | Old hard-coded `5432` probe fails on Cockroach |
| Free Basic tier ≈ **50M RUs + 10 GiB** storage/month (org credit) | Watch Cluster Overview → Usage this month |

---

## Important: one deploy path only

Cloud Run console **“Deploy from repository” / continuous deployment** builds without your GitHub Secrets (no `JWT_SECRET`, `DATABASE_URL`, etc.) and will crash the container with **503**.

- Keep **GitHub Actions** (`Deploy to Cloud Run`) as the only deployer  
- In Cloud Run → service **`consignment-youthnic-git`** → **Edit repo settings** → **disconnect / disable** continuous deployment  
- Do not leave Max instances at **20** in the console — Actions sets **max=3**, min=0  

---

## Cost profile (Cloud Run)

Deploy uses a **low-cost** profile so idle time is nearly free:

| Setting | Value | Why |
|---------|-------|-----|
| `min-instances` | `0` | Scale to zero when idle (biggest savings vs always-on) |
| `max-instances` | `3` | Caps burst spend |
| CPU / memory | `1` vCPU / `1Gi` | Enough for packing + uploads without 2× resources |
| CPU throttling | on | Bill CPU mainly while handling requests |
| Services deployed | **one** primary (`consignment-youthnic-git`) | Avoid paying for a second duplicate app |
| `max-instances` | `3` (not 20) | Caps burst spend — lower than Cloud Run console defaults |

**Tradeoff:** first request after idle can be a few seconds (cold start). Tue/Fri Org Head email runs in-process, so it only fires while an instance is warm — use [Cloud Scheduler](https://cloud.google.com/scheduler) to hit `/api/workflow/org-head/send-weekly-report` if you need that email even when the app is idle.

To delete a leftover duplicate service entirely (optional):  
`gcloud run services delete consignment-packing --region=europe-west1`

---

## Critical rules

- **Never commit** `backend/.env`, `frontend/.env`, `frontend/.env.production`, or `serviceAccountKey.json`
- **Do not store app secrets in Supabase** — Supabase is Realtime-only on free tier; use **GitHub Secrets → Cloud Run env vars**
- **Do not put only 3 secrets in GitHub** — Cloud Run needs the full list below
- **Do not use GCP Secret Manager for these app secrets** — it adds cost; GitHub Secrets + Cloud Run env vars are enough for this deployment

---

## One-time setup

### 1. GCP service account for GitHub Actions

In [Google Cloud Console](https://console.cloud.google.com/) → **IAM & Admin** → **Service Accounts**:

1. Create a service account (e.g. `github-actions-deploy`)
2. Grant roles:
   - `Cloud Run Admin`
   - `Service Account User`
   - `Storage Admin` (to push to `gcr.io`)
   - `Cloud Build Editor` (optional)
3. Create a JSON key and save the full JSON as GitHub secret **`GCP_SA_KEY`**

> Secret Manager Admin is **not** required. Deploy writes values as Cloud Run environment variables.

### 2. Cloud Run + custom domain

Custom domain **`consignment.youthnic.shop`** should map to Cloud Run service **`consignment-youthnic-git`**. The workflow deploys that primary service only and cost-caps any legacy `consignment-pack` / `consignment-packing` duplicates.

Repository **Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Example | Purpose |
|----------|---------|---------|
| `CLOUD_RUN_SERVICE` | `consignment-youthnic-git` | Optional override |
| `CLOUD_RUN_REGION` | `europe-west1` | Deployment region |
| `CUSTOM_DOMAIN` | `https://consignment.youthnic.shop` | Public app URL |
| `DB_SSL` | `true` | Required for Cockroach Cloud / Neon / Supabase. Use `false` only for lease-line Postgres without TLS |

### 3. GitHub Secrets (required)

| Secret | Description |
|--------|-------------|
| `GCP_PROJECT_ID` | GCP project ID |
| `GCP_SA_KEY` | Full JSON key for the deploy service account |
| `JWT_SECRET` | Strong random string (32+ chars) for app JWT signing |
| `DATABASE_URL` | **Public** Postgres-compatible URL. Prefer Cockroach Cloud (`…cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full`). LAN IPs crash Cloud Run with **503**. |
| `RESEND_API_KEY` | Resend API key |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full Firebase Admin SDK JSON |
| `VITE_FIREBASE_API_KEY` | Firebase web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `consignment-packing-app.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | e.g. `consignment-packing-app` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | From Firebase web config |
| `VITE_FIREBASE_APP_ID` | From Firebase web config |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 S3 access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret access key |
| `R2_BUCKET` | Optional (workflow defaults to `consigmentapp`) |

### 4. GitHub Secrets (recommended — live sync + share links)

| Secret | Description |
|--------|-------------|
| `VITE_SUPABASE_URL` | `https://fakrpqlqcnctmiliqxjl.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase **anon** / publishable key |
| `SUPABASE_JWT_SECRET` | Supabase **JWT Secret** (Project Settings → API → JWT Secret). **Not** the service_role key, **not** a JWT token |
| `SHARE_LINK_SECRET` | Optional dedicated HMAC for durable video share links (defaults to `JWT_SECRET`) |
| `BOOTSTRAP_SECRET` | Optional admin resync protect |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | Full Google service-account JSON for Inventory Planning (Sheet AutoFetch). Share the spreadsheet with the SA `client_email` (Editor). Deployed as a Cloud Run env var from this GitHub secret. |
| `VITE_FIREBASE_MEASUREMENT_ID` | Optional analytics |
| `VITE_POSTHOG_KEY` | Optional |

### What you do **not** need in GitHub for this app

| Secret | Why skip |
|--------|----------|
| `SUPABASE_ACCESS_TOKEN` | Management API / MCP / CLI only — **not** used by Cloud Run app |
| `SUPABASE_DB_PASSWORD` | App data is on `DATABASE_URL` (Cloud SQL/local). Free-tier Supabase is **Realtime only** — do not migrate the app DB there |

---

## R2 custom domain (recommended for production)

In Cloudflare R2 → bucket `consigmentapp` → **Settings** → **Custom Domains** → **Add**:

1. Suggested hostname: `media.consignment.youthnic.shop` (or `media.youthnic.shop`)
2. Complete DNS as Cloudflare prompts
3. Optionally set Cloud Run env `R2_PUBLIC_BASE_URL=https://media.consignment.youthnic.shop`
4. Keep CORS allowing `https://consignment.youthnic.shop` (see `r2-cors.json`)
5. Prefer custom domain over the rate-limited `*.r2.dev` public URL for production

Playback still works via authenticated `/api/uploads/stream/...` and durable `/api/uploads/s/...` even without a public R2 domain.

---

## How secrets reach Cloud Run

Deploy reads GitHub Actions secrets and sets them as **normal Cloud Run environment variables** via `scripts/gcloud-deploy.sh` (`--env-vars-file`). GCP Secret Manager is **not** used (avoids Secret Manager cost).

Values set on every deploy when present in GitHub Secrets:

- `JWT_SECRET`, `RESEND_API_KEY`, `DATABASE_URL`
- `SUPABASE_JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `BOOTSTRAP_SECRET`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SHARE_LINK_SECRET`
- `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` (Inventory Planning → Google Sheet AutoFetch)

Empty GitHub secrets are skipped. Legacy Secret Manager mounts are cleared on deploy (`--clear-secrets`).

`scripts/sync-secrets-to-gcp.sh` is **deprecated** and unused by CI.

---

## Post-deploy checklist

- [ ] `https://consignment.youthnic.shop/api/health` returns OK
- [ ] Firebase Auth authorized domains includes `consignment.youthnic.shop`
- [ ] Login works
- [ ] Packing video upload → preview → share link → download
- [ ] R2 CORS includes production origin
- [ ] Live sync connected (Supabase Realtime Broadcast)

```bash
curl -s https://consignment.youthnic.shop/api/health
bash scripts/verify-live-deployment.sh https://consignment.youthnic.shop
```

---

## Manual redeploy

**Actions → Deploy to Cloud Run → Run workflow**

- Skip build = false: full build + push + deploy
- Skip build = true: redeploy existing `:latest` after secret-only changes
