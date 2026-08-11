# 🚀 Deployment Guide — Youthnic Packing Station
## Google Cloud Run → consignment.youthnic.shop

---

## Architecture Overview

```
Internet
   │
   ▼
consignment.youthnic-studio.shop  (Cloud Run custom domain)
   │
   ▼
Google Cloud Run  (europe-west1)
   │  Single container — Express serves:
   │    • React frontend (static files from /frontend/dist)
   │    • REST API (/api/*)
   │
   ▼
Firebase Auth + Storage | PostgreSQL (Cloud SQL)
```

> **Region:** `europe-west1` (Belgium) supports Cloud Run custom domain mappings.  
> Do not deploy to `asia-south1` — domain mapping is not available there.

---

## Prerequisites

Install these on your machine:
```cmd
# Google Cloud SDK
https://cloud.google.com/sdk/docs/install

# Docker Desktop (for local testing)
https://www.docker.com/products/docker-desktop/

# Verify installs
gcloud --version
docker --version
```

---

## Step 1 — One-time GCP Setup

```cmd
# Log in and set your project
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

---

## Step 2 — Configure secrets as Cloud Run env vars (via GitHub Actions)

Do **not** use GCP Secret Manager for this app (extra cost). Keep values in **GitHub Actions Secrets**, and the deploy workflow writes them as normal Cloud Run environment variables.

Required GitHub Secrets include: `JWT_SECRET`, `DATABASE_URL`, `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, R2 keys, etc. See `GITHUB_ACTIONS.md`.

Manual one-off (optional):

```cmd
gcloud run services update consignment-youthnic-git --region=europe-west1 --update-env-vars="JWT_SECRET=your-secret,DATABASE_URL=postgres://..."
```

---

## Step 3 — Grant Cloud Run Service Account Firebase Permissions

Cloud Run uses Application Default Credentials (ADC) when available; this app also accepts `FIREBASE_SERVICE_ACCOUNT_JSON` as an env var.
Grant the Cloud Run default service account access to Firebase:

```cmd
# Get your project number
gcloud projects describe YOUR_GCP_PROJECT_ID --format="value(projectNumber)"

# Grant Firestore access (replace PROJECT_NUMBER)
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"

# Grant Firebase Admin access (Auth). App media uses Cloudflare R2 — Storage Object Admin is not required.
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/firebase.sdkAdminServiceAgent"
```

---

## Step 4 — Build & Push Docker Image

```cmd
cd C:\Users\shukl\Desktop\consignment-packing-master

# Build
docker build -t gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest .

# Authenticate Docker with GCR
gcloud auth configure-docker

# Push
docker push gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest
```

---

## Step 5 — Deploy to Cloud Run

```cmd
gcloud run deploy consignment-packing ^
  --image=gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest ^
  --platform=managed ^
  --region=europe-west1 ^
  --allow-unauthenticated ^
  --port=8080 ^
  --memory=2Gi ^
  --cpu=2 ^
  --concurrency=60 ^
  --timeout=300 ^
  --min-instances=1 ^
  --max-instances=10 ^
  --cpu-boost ^
  --set-env-vars=NODE_ENV=production ^
  --set-env-vars=FIREBASE_PROJECT_ID=consignment-packing-app ^
  --set-env-vars=R2_BUCKET=consigmentapp ^
  --set-env-vars=MAIL_FROM_EMAIL=consignment@youthnic.shop ^
  --set-env-vars=MAIL_FROM_NAME="Youthnic Packing Station" ^
  --set-env-vars=MAIL_USER_DOMAIN=youthnic.shop ^
  --set-env-vars=APP_URL=https://consignment.youthnic.shop ^
  --update-secrets=JWT_SECRET=JWT_SECRET:latest ^
  --update-secrets=MAILERSEND_API_KEY=MAILERSEND_API_KEY:latest
```

> Note: On Windows CMD use `^` for line continuation. On PowerShell use `` ` ``.

> **Cost profile (default in GitHub Actions):** `1Gi` memory, `1` vCPU, `min-instances=0` (scale to zero), `max-instances=3`, CPU throttling on. First request after idle may cold-start. Do **not** set `min-instances=1` unless you accept always-on billing.

After deployment, note the Cloud Run URL: `https://consignment-packing-XXXXXXXX-el.a.run.app`

---

## Step 6 — Map Custom Domain (Cloud Run domain mapping)

`europe-west1` supports Cloud Run domain mappings directly.

### 6a. Add domain to Cloud Run

```cmd
gcloud run domain-mappings create ^
  --service=consignment-packing ^
  --domain=consignment.youthnic-studio.shop ^
  --region=europe-west1
```

This shows DNS records to add at your DNS provider. Copy them.

### 6b. Add DNS records

Go to your DNS provider (where `youthnic-studio.shop` is managed) and add the records shown by the command above. Typically:

| Type  | Name        | Value                |
|-------|-------------|----------------------|
| CNAME | consignment | ghs.googlehosted.com |

> Wait 5–30 minutes for DNS propagation. SSL is provisioned automatically.

### 6c. Verify mapping

```cmd
gcloud run domain-mappings describe ^
  --domain=consignment.youthnic-studio.shop ^
  --region=europe-west1
```

Status should show `READY`.

### 6d. Update Cloud Run env vars

```cmd
gcloud run services update consignment-packing ^
  --region=europe-west1 ^
  --update-env-vars="APP_URL=https://consignment.youthnic-studio.shop,ALLOWED_ORIGINS=https://consignment.youthnic-studio.shop"
```

---

## Step 7 — Configure Cloudflare R2 (media storage)

Videos, weight images, and documents are stored in Cloudflare R2 (bucket `consigmentapp`). Firebase is Auth-only.

1. In Cloudflare Dashboard → **R2** → **Manage R2 API Tokens**, create a token with **Object Read & Write** scoped to `consigmentapp`.
2. Copy **Access Key ID**, **Secret Access Key**, and your **Account ID**.
3. Set Cloud Run / local secrets (never commit real values):

```text
R2_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=consigmentapp
```

4. Apply CORS for browser direct uploads:

```cmd
cd backend
node scripts/apply-cors.js
```

If credentials are set, the script applies CORS via the S3 API. Otherwise it prints the policy JSON to paste under **R2 → consigmentapp → Settings → CORS**.

5. Smoke-test:

```cmd
node scripts/r2-smoke-test.js
```

Playback remains authenticated via `/api/uploads/stream/:fileId` (no public bucket required).
---

## Step 8 — Update Firebase Authorized Domains

In Firebase Console → Authentication → Settings → Authorized domains, add **every URL users sign in from**:

- `consignment.youthnic-studio.shop` (or your custom domain)
- `consignment-packing-XXXXXXXX.europe-west1.run.app` (Cloud Run direct URL)

---

## Step 9 — Verify Everything Works

```cmd
# Health check
curl https://consignment.youthnic.shop/api/health

# Expected response:
# {"status":"ok","timestamp":"2025-..."}
```

Then open https://consignment.youthnic.shop in your browser and login.

---

## Step 10 — Set Up Auto-Deploy with Cloud Build (Optional)

Connect your GitHub repo to Cloud Build for automatic deployments on push:

```cmd
# The cloudbuild.yaml file is already in the repo.
# Just connect Cloud Build to your GitHub repo in GCP Console:
# Cloud Build → Triggers → Connect Repository
```

---

## Environment Variables Reference

| Variable | Value in Production | Source |
|---|---|---|
| `NODE_ENV` | `production` | Cloud Run env var |
| `PORT` | `8080` | Cloud Run (auto-injected) |
| `FIREBASE_PROJECT_ID` | `consignment-packing-app` | Cloud Run env var |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Cloud Run env / Secret Manager |
| `R2_ACCESS_KEY_ID` | R2 S3 access key | Secret Manager |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret | Secret Manager |
| `R2_BUCKET` | `consigmentapp` | Cloud Run env var |
| `JWT_SECRET` | (strong random string) | Secret Manager |
| `RESEND_API_KEY` | (your API key) | Cloud Run env var (GitHub Secret) |
| `MAIL_FROM_EMAIL` | `consignment@youthnic.shop` | Cloud Run env var |
| `APP_URL` | `https://consignment.youthnic.shop` | Cloud Run env var |
| `ALLOWED_ORIGINS` | not needed (same-origin) | — |

> **Note:** `GOOGLE_APPLICATION_CREDENTIALS` is NOT needed on Cloud Run.  
> The backend automatically uses Application Default Credentials (ADC).

---

## Pre-Deployment Checklist

- [ ] `docker build -t test .` succeeds locally
- [ ] `gcloud auth login` done
- [ ] GCP project set correctly
- [ ] Firebase Auth enabled (Storage not required for app media)
- [ ] R2 bucket `consigmentapp` created; API token + CORS configured (Step 7)
- [ ] JWT_SECRET stored in Secret Manager
- [ ] RESEND_API_KEY stored as a GitHub Actions secret
- [ ] Cloud Run service account has IAM roles (Step 3)
- [ ] Domain `consignment.youthnic.shop` DNS configured
- [ ] Firebase Authorized Domains includes `consignment.youthnic.shop`
- [ ] R2 smoke test passes (`node backend/scripts/r2-smoke-test.js`)
- [ ] `/api/health` returns 200 after deploy

---

## Updating the App After Changes

```cmd
# Rebuild and redeploy (run from project root)
docker build -t gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest . && ^
docker push gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest && ^
gcloud run deploy consignment-packing ^
  --image=gcr.io/YOUR_GCP_PROJECT_ID/consignment-packing:latest ^
  --region=europe-west1
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `[Firebase] No valid credentials` | Cloud Run service account missing IAM roles (Step 3) |
| CORS errors in browser | Verify `ALLOWED_ORIGINS` or same-origin setup |
| Videos won't upload | Configure R2 API token + CORS (Step 7); run `node backend/scripts/r2-smoke-test.js` |
| Domain shows 404 | Wait for DNS propagation (up to 30 min) after domain mapping |
| "Domain mappings not available in region" | Redeploy to `europe-west1`, not `asia-south1` |
| Domain shows "no SSL" | Wait for Google to provision cert (up to 24h) |
| `Secret not found` | Check secret names match exactly in Step 2 |
| Container crash on start | Check Cloud Run logs: `gcloud run services logs read consignment-packing --region=europe-west1` |

---

## View Logs

```cmd
# Live logs
gcloud run services logs tail consignment-packing --region=europe-west1

# Last 100 lines
gcloud run services logs read consignment-packing --region=europe-west1 --limit=100
```
