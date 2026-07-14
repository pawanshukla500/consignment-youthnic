#!/usr/bin/env bash
# Store DATABASE_URL in GCP Secret Manager and attach to Cloud Run.
# Run in Google Cloud Shell after you have your Neon/PostgreSQL connection string.
#
# Usage:
#   export DATABASE_URL='postgresql://user:pass@host/db?sslmode=require'
#   bash scripts/setup-database-secret-cloudshell.sh
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-robust-solution-425310-t9}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-consignment-packing}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: Set DATABASE_URL before running this script."
  echo ""
  echo "Example (Neon pooler):"
  echo "  export DATABASE_URL='postgresql://user:PASSWORD@ep-xxx.neon.tech/neondb?sslmode=require'"
  echo ""
  echo "URL-encode special characters in passwords:"
  echo "  \$ → %24    @ → %40    # → %23    & → %26"
  exit 1
fi

if ! [[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
  echo "ERROR: DATABASE_URL must start with postgresql:// or postgres://"
  exit 1
fi

gcloud config set project "$GCP_PROJECT_ID"

echo "Creating/updating Secret Manager secret DATABASE_URL..."
if gcloud secrets describe DATABASE_URL >/dev/null 2>&1; then
  printf '%s' "$DATABASE_URL" | gcloud secrets versions add DATABASE_URL --data-file=-
else
  printf '%s' "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=-
fi

echo "Granting Cloud Run service account access to secret..."
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding DATABASE_URL \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet >/dev/null 2>&1 || true

echo "Attaching DATABASE_URL secret to Cloud Run service..."
gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --update-secrets="DATABASE_URL=DATABASE_URL:latest" \
  --quiet

echo ""
echo "✅ DATABASE_URL secret configured on Cloud Run."
echo "Verify:"
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')
curl -sS "${SERVICE_URL}/api/health" | jq .
