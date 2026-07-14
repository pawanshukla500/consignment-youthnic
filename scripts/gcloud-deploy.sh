#!/usr/bin/env bash
# Deploy consignment-youthnic-git to Cloud Run (called from GitHub Actions).
set -euo pipefail

: "${PROJECT_ID:?}"
: "${IMAGE_NAME:?}"
: "${REGION:?}"
: "${SERVICE_NAME:?}"
: "${CUSTOM_DOMAIN:?}"

IMAGE_REF="${IMAGE_REF:-}"
if [ -z "$IMAGE_REF" ]; then
  echo "IMAGE_REF is required" >&2
  exit 1
fi

DOMAIN_MAPPED_SERVICE="${DOMAIN_MAPPED_SERVICE:-$SERVICE_NAME}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-$SERVICE_NAME}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-}"
FIREBASE_AUTH_DOMAIN="${FIREBASE_AUTH_DOMAIN:-}"
POSTHOG_DASHBOARD_URL="${POSTHOG_DASHBOARD_URL:-https://us.posthog.com/embedded/aUBKw6XLlFMPLf2WJbRbmEzbfSpIyQ}"
BETTERSTACK_DASHBOARD_URL="${BETTERSTACK_DASHBOARD_URL:-}"
LOGTAIL_SOURCE_TOKEN="${LOGTAIL_SOURCE_TOKEN:-}"
# Lease-line / local Postgres default: no TLS. Set GitHub variable DB_SSL=true after enabling server SSL.
DB_SSL="${DB_SSL:-false}"

echo "Image: $IMAGE_REF"
echo "DB_SSL=${DB_SSL}"

if ! gcloud secrets describe DATABASE_URL >/dev/null 2>&1; then
  echo "::error::Secret DATABASE_URL missing in Secret Manager"
  exit 1
fi

DB_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL)"
DB_HOST="$(DB_URL="$DB_URL" python3 -c 'import os,urllib.parse; print(urllib.parse.urlparse(os.environ["DB_URL"]).hostname or "")')"

echo "DATABASE_URL host: ${DB_HOST:-unknown}"

case "$DB_HOST" in
  localhost|127.0.0.1|::1|0.0.0.0|"")
    echo "::error::DATABASE_URL host is local/empty ($DB_HOST). Use public IP (e.g. 117.x.x.x) in GitHub secret DATABASE_URL."
    exit 1
    ;;
esac

if echo "$DB_HOST" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'; then
  echo "::error::DATABASE_URL points at private LAN IP ($DB_HOST). Cloud Run cannot reach it. Use your public IP."
  exit 1
fi

echo "Probing TCP ${DB_HOST}:5432 from this runner..."
if ! DB_HOST="$DB_HOST" python3 -c 'import os,socket,sys
h=os.environ["DB_HOST"]
try:
  socket.create_connection((h,5432),timeout=15).close()
  print("OK", h)
except Exception as e:
  print("FAIL", h, e, file=sys.stderr); sys.exit(1)'; then
  echo "::error::Cannot open TCP ${DB_HOST}:5432 from the internet. Check port forward / BSNL firewall."
  exit 1
fi
echo "TCP ${DB_HOST}:5432 reachable"

SECRET_CSV=""
for pair in \
  "JWT_SECRET=JWT_SECRET:latest" \
  "MAILGUN_API_KEY=MAILGUN_API_KEY:latest" \
  "MAILGUN_DOMAIN=MAILGUN_DOMAIN:latest" \
  "DATABASE_URL=DATABASE_URL:latest" \
  "SUPABASE_JWT_SECRET=SUPABASE_JWT_SECRET:latest" \
  "FIREBASE_SERVICE_ACCOUNT_JSON=FIREBASE_SERVICE_ACCOUNT_JSON:latest" \
  "R2_ACCOUNT_ID=R2_ACCOUNT_ID:latest" \
  "R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID:latest" \
  "R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY:latest" \
  "SHARE_LINK_SECRET=SHARE_LINK_SECRET:latest" \
  "BOOTSTRAP_SECRET=BOOTSTRAP_SECRET:latest"; do
  name="${pair%%=*}"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    if [ -n "$SECRET_CSV" ]; then SECRET_CSV="${SECRET_CSV},"; fi
    SECRET_CSV="${SECRET_CSV}${pair}"
    echo "Mounting secret: $name"
  else
    echo "Skipping secret (not in Secret Manager): $name"
  fi
done

DEPLOY_TARGETS="$DOMAIN_MAPPED_SERVICE $DEPLOY_SERVICES $SERVICE_NAME"
DEPLOYED_SVCS=""
ALL_ORIGINS="${CUSTOM_DOMAIN}"
for candidate in $DEPLOY_TARGETS; do
  [ -n "$candidate" ] || continue
  if gcloud run services describe "$candidate" --region="$REGION" >/dev/null 2>&1; then
    url="$(gcloud run services describe "$candidate" --region="$REGION" --format='value(status.url)')"
    if [ -n "$url" ] && ! echo ",$ALL_ORIGINS," | grep -q ",$url,"; then
      ALL_ORIGINS="${ALL_ORIGINS},${url}"
    fi
  fi
done
echo "ALLOWED_ORIGINS: $ALL_ORIGINS"

PRIMARY_SERVICE=""
PRIMARY_URL=""

for svc in $DEPLOY_TARGETS; do
  [ -n "$svc" ] || continue
  if echo " $DEPLOYED_SVCS " | grep -q " ${svc} "; then
    continue
  fi
  echo "Deploying: $svc ($REGION)"

  ENV_CSV="NODE_ENV=production"
  ENV_CSV="${ENV_CSV}##ADMIN_EMAIL=returnorders@vbexports.co.in"
  ENV_CSV="${ENV_CSV}##FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}"
  ENV_CSV="${ENV_CSV}##FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN}"
  ENV_CSV="${ENV_CSV}##R2_BUCKET=consigmentapp"
  ENV_CSV="${ENV_CSV}##DB_USE_POSTGRES=true"
  ENV_CSV="${ENV_CSV}##DB_SSL=${DB_SSL}"
  ENV_CSV="${ENV_CSV}##DB_POOL_MAX=10"
  ENV_CSV="${ENV_CSV}##SUPABASE_URL=${SUPABASE_URL}"
  ENV_CSV="${ENV_CSV}##SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}"
  ENV_CSV="${ENV_CSV}##MAIL_FROM_EMAIL=consignment@youthnic.shop"
  ENV_CSV="${ENV_CSV}##MAIL_FROM_NAME=Youthnic Packing Station"
  ENV_CSV="${ENV_CSV}##MAIL_USER_DOMAIN=youthnic.shop"
  ENV_CSV="${ENV_CSV}##APP_URL=${CUSTOM_DOMAIN}"
  ENV_CSV="${ENV_CSV}##ALLOWED_ORIGINS=${ALL_ORIGINS}"
  ENV_CSV="${ENV_CSV}##LOGTAIL_INGEST_HOST=s2531760.eu-fsn-3.betterstackdata.com"
  ENV_CSV="${ENV_CSV}##POSTHOG_DASHBOARD_URL=${POSTHOG_DASHBOARD_URL}"
  if [ -n "$BETTERSTACK_DASHBOARD_URL" ]; then
    ENV_CSV="${ENV_CSV}##BETTERSTACK_DASHBOARD_URL=${BETTERSTACK_DASHBOARD_URL}"
  fi
  if [ -n "$LOGTAIL_SOURCE_TOKEN" ]; then
    ENV_CSV="${ENV_CSV}##LOGTAIL_SOURCE_TOKEN=${LOGTAIL_SOURCE_TOKEN}"
  fi

  gcloud run deploy "$svc" \
    --image="$IMAGE_REF" \
    --platform=managed \
    --region="$REGION" \
    --allow-unauthenticated \
    --port=8080 \
    --memory=1Gi \
    --cpu=1 \
    --concurrency=80 \
    --timeout=300 \
    --min-instances=0 \
    --max-instances=3 \
    --cpu-throttling \
    --execution-environment=gen2 \
    --quiet \
    --update-env-vars="^##^${ENV_CSV}" \
    --update-secrets="$SECRET_CSV"

  gcloud run services update "$svc" \
    --region="$REGION" \
    --remove-env-vars="ADMIN_PASSWORD" \
    --quiet || true

  gcloud run services update-traffic "$svc" \
    --region="$REGION" \
    --to-latest \
    --quiet || true

  DEPLOYED_URL="$(gcloud run services describe "$svc" --region="$REGION" --format='value(status.url)')"
  echo "Deployed $svc → $DEPLOYED_URL"
  DEPLOYED_SVCS="${DEPLOYED_SVCS} ${svc}"
  PRIMARY_SERVICE="$svc"
  PRIMARY_URL="$DEPLOYED_URL"
done

if [ -z "$PRIMARY_SERVICE" ]; then
  echo "::error::No Cloud Run service was deployed."
  exit 1
fi

echo "PRIMARY_SERVICE=$PRIMARY_SERVICE" >> "$GITHUB_ENV"
echo "PRIMARY_URL=$PRIMARY_URL" >> "$GITHUB_ENV"

for extra in consignment-pack consignment-packing; do
  if echo " $DEPLOYED_SVCS " | grep -q " ${extra} "; then
    continue
  fi
  if gcloud run services describe "$extra" --region="$REGION" >/dev/null 2>&1; then
    echo "Cost-cap legacy $extra"
    gcloud run services update "$extra" \
      --region="$REGION" \
      --min-instances=0 \
      --max-instances=1 \
      --cpu=1 \
      --memory=512Mi \
      --cpu-throttling \
      --quiet || true
  fi
done
