#!/usr/bin/env bash
# Verify Firebase ↔ GCP Cloud Run ↔ GitHub are aligned for consignment.youthnic.shop
#
# Run in Google Cloud Shell:
#   bash scripts/verify-firebase-connection.sh
#
# Or with overrides:
#   GCP_PROJECT_ID=robust-solution-425310-t9 bash scripts/verify-firebase-connection.sh
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:-robust-solution-425310-t9}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-consignment-packing-app}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-consignment-packing}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-https://consignment.youthnic.shop}"
EXPECTED_AUTH_DOMAIN="${EXPECTED_AUTH_DOMAIN:-${FIREBASE_PROJECT_ID}.firebaseapp.com}"
EXPECTED_STORAGE="${EXPECTED_STORAGE:-${FIREBASE_PROJECT_ID}.firebasestorage.app}"

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN + 1)); }

echo "═══════════════════════════════════════════════════════════════"
echo " Firebase + GCP + Domain alignment check"
echo " GCP project:      $GCP_PROJECT_ID"
echo " Firebase project: $FIREBASE_PROJECT_ID"
echo " Custom domain:    $CUSTOM_DOMAIN"
echo "═══════════════════════════════════════════════════════════════"
echo ""

gcloud config set project "$GCP_PROJECT_ID" >/dev/null 2>&1

# ── 1. GCP project number ────────────────────────────────────────────────────
echo "1) GCP project"
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || echo "")
if [ -n "$PROJECT_NUMBER" ]; then
  ok "Project $GCP_PROJECT_ID exists (number: $PROJECT_NUMBER)"
else
  bad "Cannot read GCP project $GCP_PROJECT_ID"
fi

# ── 2. Cloud Run service ─────────────────────────────────────────────────────
echo ""
echo "2) Cloud Run service"
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)' 2>/dev/null || echo "")
if [ -n "$SERVICE_URL" ]; then
  ok "Service $SERVICE_NAME → $SERVICE_URL"
  if [ -n "$PROJECT_NUMBER" ] && echo "$SERVICE_URL" | grep -q "$PROJECT_NUMBER"; then
    ok "Cloud Run URL contains project number $PROJECT_NUMBER"
  else
    warn "Cloud Run URL project number may not match $PROJECT_NUMBER"
  fi
else
  bad "Cloud Run service $SERVICE_NAME not found in $REGION"
fi

# ── 3. Cloud Run Firebase env vars ───────────────────────────────────────────
echo ""
echo "3) Cloud Run Firebase environment (must match Firebase project $FIREBASE_PROJECT_ID)"
ENV_YAML=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='yaml(spec.template.spec.containers[0].env)' 2>/dev/null || echo "")

check_env() {
  local key="$1" expected="$2"
  local val
  val=$(echo "$ENV_YAML" | grep -A1 "name: $key" | grep 'value:' | head -1 | sed 's/.*value: //' || true)
  if [ -z "$val" ]; then
    bad "$key is not set on Cloud Run"
  elif [ "$val" = "$expected" ]; then
    ok "$key = $val"
  else
    bad "$key = $val (expected $expected)"
  fi
}

if [ -n "$ENV_YAML" ]; then
  check_env "FIREBASE_PROJECT_ID" "$FIREBASE_PROJECT_ID"
  check_env "FIREBASE_AUTH_DOMAIN" "$EXPECTED_AUTH_DOMAIN"
  check_env "FIREBASE_STORAGE_BUCKET" "$EXPECTED_STORAGE"

  if echo "$ENV_YAML" | grep -q 'name: FIREBASE_SERVICE_ACCOUNT_JSON'; then
    ok "FIREBASE_SERVICE_ACCOUNT_JSON is set"
    SA_EMAIL=$(echo "$ENV_YAML" | grep -A500 'FIREBASE_SERVICE_ACCOUNT_JSON' | grep 'client_email' | head -1 | sed 's/.*client_email.: .//' | tr -d '",' || true)
    if [ -n "$SA_EMAIL" ] && echo "$SA_EMAIL" | grep -q "@${FIREBASE_PROJECT_ID}"; then
      ok "Service account belongs to Firebase project: $SA_EMAIL"
    elif [ -n "$SA_EMAIL" ]; then
      bad "Service account email does not match Firebase project: $SA_EMAIL"
    else
      warn "Could not parse service account email from env (check Secret Manager JSON)"
    fi
  else
    bad "FIREBASE_SERVICE_ACCOUNT_JSON is missing on Cloud Run"
  fi

  APP_URL=$(echo "$ENV_YAML" | grep -A1 'name: APP_URL' | grep 'value:' | sed 's/.*value: //' || true)
  if [ "$APP_URL" = "$CUSTOM_DOMAIN" ]; then
    ok "APP_URL = $APP_URL"
  else
    warn "APP_URL = ${APP_URL:-<unset>} (expected $CUSTOM_DOMAIN)"
  fi

  ORIGINS=$(echo "$ENV_YAML" | grep -A1 'name: ALLOWED_ORIGINS' | grep 'value:' | sed 's/.*value: //' || true)
  if echo "$ORIGINS" | grep -q "$(echo "$CUSTOM_DOMAIN" | sed 's|https://||')"; then
    ok "ALLOWED_ORIGINS includes custom domain"
  else
    bad "ALLOWED_ORIGINS missing custom domain: ${ORIGINS:-<unset>}"
  fi
  if echo "$ORIGINS" | grep -q '.run.app'; then
    ok "ALLOWED_ORIGINS includes Cloud Run URL"
  else
    warn "ALLOWED_ORIGINS may be missing .run.app URL"
  fi
else
  bad "Could not read Cloud Run environment"
fi

# ── 4. Live API checks ───────────────────────────────────────────────────────
echo ""
echo "4) Live API (Cloud Run URL)"
if [ -n "$SERVICE_URL" ]; then
  AUTH_STATUS=$(curl -sS "${SERVICE_URL}/api/auth/status" 2>/dev/null || echo '{}')
  if echo "$AUTH_STATUS" | grep -q '"secureSignInConfigured":true'; then
    ok "/api/auth/status → secureSignInConfigured: true"
  else
    bad "/api/auth/status → Firebase not configured on server"
    echo "     $AUTH_STATUS"
  fi
  if echo "$AUTH_STATUS" | grep -q '"adminInFirebase":true'; then
    ok "Admin user exists in Firebase Auth"
  else
    warn "Admin user not found in Firebase Auth — create returnorders@vbexports.co.in in Firebase Console"
  fi

  CORS_TEST=$(curl -sS -X POST "${SERVICE_URL}/api/auth/firebase-login" \
    -H "Origin: ${SERVICE_URL}" \
    -H "Content-Type: application/json" \
    -d '{"idToken":"invalid"}' 2>/dev/null || echo '{}')
  if echo "$CORS_TEST" | grep -q 'Internal server error'; then
    bad "CORS broken on Cloud Run URL — redeploy latest main branch (CORS fix)"
  elif echo "$CORS_TEST" | grep -q 'Invalid or expired'; then
    ok "CORS OK on Cloud Run URL"
  else
    warn "Unexpected firebase-login response: $CORS_TEST"
  fi
fi

# ── 5. Custom domain DNS / SSL ───────────────────────────────────────────────
echo ""
echo "5) Custom domain ($CUSTOM_DOMAIN)"
DOMAIN_HOST=$(echo "$CUSTOM_DOMAIN" | sed 's|https://||')
if curl -fsS -o /dev/null -m 10 "${CUSTOM_DOMAIN}/api/health" 2>/dev/null; then
  ok "Custom domain serves /api/health"
  CUSTOM_AUTH=$(curl -sS "${CUSTOM_DOMAIN}/api/auth/status" 2>/dev/null || echo '{}')
  if echo "$CUSTOM_AUTH" | grep -q '"secureSignInConfigured":true'; then
    ok "Custom domain Firebase backend connected"
  fi
else
  warn "Custom domain not reachable yet — map DNS in Cloud Run → Domain mappings"
  echo "     Cloud Run → Domain mappings → add $DOMAIN_HOST → point DNS CNAME to ghs.googlehosted.com or Cloud Run target"
fi

# ── 6. Frontend Firebase config (baked into deployed JS) ─────────────────────
echo ""
echo "6) Frontend Firebase config (must match $FIREBASE_PROJECT_ID)"
if [ -n "$SERVICE_URL" ]; then
  JS_FILE=$(curl -sS "${SERVICE_URL}/" | grep -oE '/assets/index-[^"]+\.js' | head -1 || true)
  if [ -n "$JS_FILE" ]; then
    JS_BODY=$(curl -sS "${SERVICE_URL}${JS_FILE}" 2>/dev/null || echo "")
    if echo "$JS_BODY" | grep -q "$FIREBASE_PROJECT_ID"; then
      ok "Deployed frontend uses projectId $FIREBASE_PROJECT_ID"
    else
      bad "Deployed frontend does NOT contain projectId $FIREBASE_PROJECT_ID — check GitHub secrets VITE_FIREBASE_*"
    fi
    if echo "$JS_BODY" | grep -q "$EXPECTED_AUTH_DOMAIN"; then
      ok "Deployed frontend authDomain = $EXPECTED_AUTH_DOMAIN"
    else
      bad "Deployed frontend authDomain mismatch — check VITE_FIREBASE_AUTH_DOMAIN secret"
    fi
  else
    warn "Could not find main JS bundle to inspect Firebase config"
  fi
fi

# ── 7. GitHub secrets checklist (manual) ─────────────────────────────────────
echo ""
echo "7) GitHub secrets checklist (Settings → Secrets and variables → Actions)"
echo "   These must ALL use Firebase project: $FIREBASE_PROJECT_ID"
echo ""
echo "   Secret / Variable              Expected value"
echo "   ─────────────────────────────────────────────────────────────"
echo "   GCP_PROJECT_ID                 $GCP_PROJECT_ID"
echo "   VITE_FIREBASE_PROJECT_ID       $FIREBASE_PROJECT_ID"
echo "   VITE_FIREBASE_AUTH_DOMAIN      $EXPECTED_AUTH_DOMAIN"
echo "   VITE_FIREBASE_STORAGE_BUCKET   $EXPECTED_STORAGE"
echo "   VITE_FIREBASE_API_KEY          from Firebase Console → Project settings → Web app"
echo "   VITE_FIREBASE_APP_ID           from same Web app config"
echo "   FIREBASE_SERVICE_ACCOUNT_JSON  from Firebase Console → Service accounts → JSON key"
echo "   CUSTOM_DOMAIN (variable)       $CUSTOM_DOMAIN"
echo ""
echo "   Firebase Console authorized domains must include:"
echo "     • $DOMAIN_HOST"
echo "     • $(echo "$SERVICE_URL" | sed 's|https://||')"
echo "     • $EXPECTED_AUTH_DOMAIN"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo " Results: $PASS passed, $FAIL failed, $WARN warnings"
if [ "$FAIL" -eq 0 ]; then
  echo " ✅ Firebase appears correctly connected. Fix any warnings above."
else
  echo " ❌ Fix failed checks, then redeploy from GitHub Actions (push to main)."
fi
echo "═══════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
