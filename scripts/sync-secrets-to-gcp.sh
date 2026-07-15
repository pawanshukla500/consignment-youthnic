#!/usr/bin/env bash
# Sync GitHub Actions secrets (passed as env vars) into GCP Secret Manager
# and grant the Cloud Run default service account secretAccessor.
#
# Used by .github/workflows/deploy.yml — can also run manually in Cloud Shell:
#   export GCP_PROJECT_ID=your-project
#   export JWT_SECRET=...
#   export MAILGUN_API_KEY=...
#   export MAILGUN_DOMAIN=...
#   bash scripts/sync-secrets-to-gcp.sh
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')}"
SA="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

sync_secret() {
  local name="$1"
  local value="${2:-}"

  if [ -z "$value" ]; then
    echo "  ⏭  $name — skipped (empty)"
    return 0
  fi

  if gcloud secrets describe "$name" --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" \
      --project="$GCP_PROJECT_ID" --data-file=-
    echo "  ✅ $name — new version added"
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --project="$GCP_PROJECT_ID" --data-file=-
    echo "  ✅ $name — created"
  fi

  gcloud secrets add-iam-policy-binding "$name" \
    --project="$GCP_PROJECT_ID" \
    --member="$SA" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null 2>&1 || true
}

echo "Syncing secrets to GCP Secret Manager (project: $GCP_PROJECT_ID)..."
gcloud config set project "$GCP_PROJECT_ID" >/dev/null

sync_secret "JWT_SECRET" "${JWT_SECRET:-}"
sync_secret "MAILGUN_API_KEY" "${MAILGUN_API_KEY:-}"
sync_secret "MAILGUN_DOMAIN" "${MAILGUN_DOMAIN:-}"
sync_secret "DATABASE_URL" "${DATABASE_URL:-}"
sync_secret "SUPABASE_JWT_SECRET" "${SUPABASE_JWT_SECRET:-}"
sync_secret "FIREBASE_SERVICE_ACCOUNT_JSON" "${FIREBASE_SERVICE_ACCOUNT_JSON:-}"
sync_secret "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON" "${GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON:-}"
sync_secret "BOOTSTRAP_SECRET" "${BOOTSTRAP_SECRET:-}"
sync_secret "R2_ACCOUNT_ID" "${R2_ACCOUNT_ID:-}"
sync_secret "R2_ACCESS_KEY_ID" "${R2_ACCESS_KEY_ID:-}"
sync_secret "R2_SECRET_ACCESS_KEY" "${R2_SECRET_ACCESS_KEY:-}"
sync_secret "SHARE_LINK_SECRET" "${SHARE_LINK_SECRET:-}"

echo "Done."
