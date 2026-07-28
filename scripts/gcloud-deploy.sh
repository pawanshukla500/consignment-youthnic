#!/usr/bin/env bash
# Deploy consignment-youthnic-git to Cloud Run (called from GitHub Actions).
# Sensitive values come from GitHub Actions secrets as normal Cloud Run env vars
# (no GCP Secret Manager — avoids Secret Manager cost).
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
# Managed cloud DBs (Cockroach/Neon/Supabase) need TLS. Lease-line Postgres may use DB_SSL=false.
DB_SSL="${DB_SSL:-true}"

# Sensitive config from GitHub Secrets (passed as env by deploy.yml)
JWT_SECRET="${JWT_SECRET:-}"
MAILGUN_API_KEY="${MAILGUN_API_KEY:-}"
MAILGUN_DOMAIN="${MAILGUN_DOMAIN:-}"
DATABASE_URL="${DATABASE_URL:-}"
SUPABASE_JWT_SECRET="${SUPABASE_JWT_SECRET:-}"
FIREBASE_SERVICE_ACCOUNT_JSON="${FIREBASE_SERVICE_ACCOUNT_JSON:-}"
GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON="${GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON:-}"
BOOTSTRAP_SECRET="${BOOTSTRAP_SECRET:-}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
SHARE_LINK_SECRET="${SHARE_LINK_SECRET:-}"

echo "Image: $IMAGE_REF"
echo "DB_SSL=${DB_SSL}"
echo "Config mode: Cloud Run env vars (GitHub Secrets) — Secret Manager not used"

if [ -z "$DATABASE_URL" ]; then
  echo "::error::DATABASE_URL is empty. Set the GitHub Actions secret DATABASE_URL."
  exit 1
fi

if [ -z "$JWT_SECRET" ]; then
  echo "::error::JWT_SECRET is empty. Set the GitHub Actions secret JWT_SECRET."
  exit 1
fi

DB_URL="$DATABASE_URL"
DB_HOST="$(DB_URL="$DB_URL" python3 -c 'import os,urllib.parse; print(urllib.parse.urlparse(os.environ["DB_URL"]).hostname or "")')"
DB_PORT="$(DB_URL="$DB_URL" python3 -c 'import os,urllib.parse; u=urllib.parse.urlparse(os.environ["DB_URL"]); print(u.port or (26257 if "cockroach" in (u.hostname or "") else 5432))')"

echo "DATABASE_URL host: ${DB_HOST:-unknown} port: ${DB_PORT}"

case "$DB_HOST" in
  localhost|127.0.0.1|::1|0.0.0.0|"")
    echo "::error::DATABASE_URL host is local/empty ($DB_HOST). Use a public host (Cockroach / Neon / public IP)."
    exit 1
    ;;
esac

if echo "$DB_HOST" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'; then
  echo "::error::DATABASE_URL points at private LAN IP ($DB_HOST). Cloud Run cannot reach it. Use Cockroach Cloud or a public IP."
  exit 1
fi

echo "Probing TCP ${DB_HOST}:${DB_PORT} from this runner..."
if ! DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" python3 -c 'import os,socket,sys
h=os.environ["DB_HOST"]; p=int(os.environ["DB_PORT"])
try:
  socket.create_connection((h,p),timeout=20).close()
  print("OK", f"{h}:{p}")
except Exception as e:
  print("FAIL", f"{h}:{p}", e, file=sys.stderr); sys.exit(1)'; then
  echo "::error::Cannot open TCP ${DB_HOST}:${DB_PORT} from the internet. Check DATABASE_URL host/port / firewall."
  exit 1
fi
echo "TCP ${DB_HOST}:${DB_PORT} reachable"

# Build env-vars YAML for gcloud (handles commas/JSON safely; no Secret Manager)
ENV_FILE="$(mktemp /tmp/cloudrun-env.XXXXXX.yaml)"

python3 - "$ENV_FILE" <<'PY'
import os, sys, json

out_path = sys.argv[1]

def yaml_scalar(value: str) -> str:
    """Emit a YAML double-quoted scalar safe for gcloud --env-vars-file."""
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'

def put(key, value, data):
    if value is None:
        return
    text = str(value)
    if text == "":
        return
    data[key] = text

data = {}
put("NODE_ENV", "production", data)
put("ADMIN_EMAIL", "returnorders@vbexports.co.in", data)
put("FIREBASE_PROJECT_ID", os.environ.get("FIREBASE_PROJECT_ID"), data)
put("FIREBASE_AUTH_DOMAIN", os.environ.get("FIREBASE_AUTH_DOMAIN"), data)
put("R2_BUCKET", "consigmentapp", data)
put("DB_USE_POSTGRES", "true", data)
put("DB_SSL", os.environ.get("DB_SSL", "true"), data)
put("DB_POOL_MAX", "10", data)
put("SUPABASE_URL", os.environ.get("SUPABASE_URL"), data)
put("SUPABASE_ANON_KEY", os.environ.get("SUPABASE_ANON_KEY"), data)
put("MAIL_FROM_EMAIL", "consignment@youthnic.shop", data)
put("MAIL_FROM_NAME", "Consignment App", data)
put("MAIL_USER_DOMAIN", "youthnic.shop", data)
put("APP_URL", os.environ.get("CUSTOM_DOMAIN"), data)
put("INVENTORY_GOOGLE_SHEET_ID", os.environ.get("INVENTORY_GOOGLE_SHEET_ID", "1tTOzLKp_Ybh3kIuQbzZOv6eTdVLMk-3EyzHcEjMQgk4"), data)
put("INVENTORY_GOOGLE_SHEET_NAME", os.environ.get("INVENTORY_GOOGLE_SHEET_NAME", "AutoFetch"), data)
put("LOGTAIL_INGEST_HOST", "s2531760.eu-fsn-3.betterstackdata.com", data)
put("POSTHOG_DASHBOARD_URL", os.environ.get("POSTHOG_DASHBOARD_URL"), data)
put("BETTERSTACK_DASHBOARD_URL", os.environ.get("BETTERSTACK_DASHBOARD_URL"), data)
put("LOGTAIL_SOURCE_TOKEN", os.environ.get("LOGTAIL_SOURCE_TOKEN"), data)

for key in [
    "JWT_SECRET",
    "MAILGUN_API_KEY",
    "MAILGUN_DOMAIN",
    "DATABASE_URL",
    "SUPABASE_JWT_SECRET",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
    "BOOTSTRAP_SECRET",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "SHARE_LINK_SECRET",
    "TASKFLOW_ENABLED",
    "TASKFLOW_SUPABASE_URL",
    "TASKFLOW_SERVICE_ROLE_KEY",
    "TASKFLOW_TEMPLATE_ID",
    "TASKFLOW_RAISED_BY_USER_ID",
    "TASKFLOW_MCP_PAT",
    "TASKFLOW_WEBHOOK_SECRET",
]:
    put(key, os.environ.get(key), data)

# ALLOWED_ORIGINS filled later once we know service URLs
meta_path = out_path + ".json"
with open(meta_path, "w", encoding="utf-8") as f:
    json.dump(data, f)
with open(out_path, "w", encoding="utf-8") as f:
    for k, v in data.items():
        f.write(f"{k}: {yaml_scalar(v)}\n")

print(f"Wrote {len(data)} env keys to {out_path}")
sensitive = {
    "DATABASE_URL", "JWT_SECRET", "FIREBASE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
    "R2_SECRET_ACCESS_KEY", "MAILGUN_API_KEY", "SUPABASE_JWT_SECRET", "BOOTSTRAP_SECRET",
    "SHARE_LINK_SECRET", "R2_ACCESS_KEY_ID", "LOGTAIL_SOURCE_TOKEN",
    "TASKFLOW_SERVICE_ROLE_KEY", "TASKFLOW_MCP_PAT", "TASKFLOW_WEBHOOK_SECRET",
}
for k in sorted(data):
    if k in sensitive:
        print(f"  {k}=***")
    else:
        v = data[k]
        print(f"  {k}={v[:60]}{'…' if len(v) > 60 else ''}")
PY

# Secret names previously mounted via Secret Manager — remove so Cloud Run uses env vars only
LEGACY_SECRET_KEYS=(
  JWT_SECRET
  MAILGUN_API_KEY
  MAILGUN_DOMAIN
  DATABASE_URL
  SUPABASE_JWT_SECRET
  FIREBASE_SERVICE_ACCOUNT_JSON
  GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON
  R2_ACCOUNT_ID
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  SHARE_LINK_SECRET
  BOOTSTRAP_SECRET
)
REMOVE_SECRETS_CSV=$(IFS=,; echo "${LEGACY_SECRET_KEYS[*]}")

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

# Patch ALLOWED_ORIGINS into the env file
ALLOWED_ORIGINS="$ALL_ORIGINS" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os, json

def yaml_scalar(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'

path = os.environ["ENV_FILE"]
meta = path + ".json"
with open(meta, encoding="utf-8") as f:
    data = json.load(f)
data["ALLOWED_ORIGINS"] = os.environ["ALLOWED_ORIGINS"]
with open(meta, "w", encoding="utf-8") as f:
    json.dump(data, f)
with open(path, "w", encoding="utf-8") as f:
    for k, v in data.items():
        f.write(f"{k}: {yaml_scalar(v)}\n")
PY

cleanup_env_file() { rm -f "$ENV_FILE" "${ENV_FILE}.json"; }
trap cleanup_env_file EXIT

PRIMARY_SERVICE=""
PRIMARY_URL=""

for svc in $DEPLOY_TARGETS; do
  [ -n "$svc" ] || continue
  if echo " $DEPLOYED_SVCS " | grep -q " ${svc} "; then
    continue
  fi
  echo "Deploying: $svc ($REGION)"

  # Drop legacy Secret Manager mounts (ignore errors if already gone)
  gcloud run services update "$svc" \
    --region="$REGION" \
    --remove-secrets="$REMOVE_SECRETS_CSV" \
    --quiet 2>/dev/null || true

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
    --env-vars-file="$ENV_FILE" \
    --clear-secrets

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
