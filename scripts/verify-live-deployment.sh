#!/usr/bin/env bash
# Live deployment check — frontend Firebase chunk + public APIs.
# Usage: bash scripts/verify-live-deployment.sh [base-url]
set -euo pipefail

BASE="${1:-https://consignment.youthnic.shop}"
PACK_URL="${PACK_URL:-https://consignment-pack-3kjolc6cra-ew.a.run.app}"
PACKING_URL="${PACKING_URL:-https://consignment-packing-3kjolc6cra-ew.a.run.app}"
FAIL=0

pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; FAIL=1; }

check_firebase_chunk() {
  local url="$1"
  local label="$2"
  local html chunk body
  html=$(curl -fsS "${url}/")
  chunk=""
  for c in $(echo "$html" | grep -oE 'chunk-[A-Za-z0-9_-]+\.js' | sort -u); do
    body=$(curl -fsS "${url}/assets/${c}")
    if echo "$body" | grep -q 'firebaseConfigured'; then
      if echo "$body" | grep -qE 'apiKey:[`"]AIza'; then
        chunk="$c"
        break
      fi
    fi
  done
  if [ -n "$chunk" ]; then
    pass "${label}: ${chunk} has apiKey"
  else
    fail "${label}: no Firebase chunk with apiKey (check index.html / deploy target)"
    echo "$html" | grep -E 'chunk-CS0lvWvy|chunk-BCFZohyf' || true
  fi
}

echo "════════════════════════════════════════"
echo "Verify: $BASE"
echo "════════════════════════════════════════"

echo ""
echo "── Public APIs ──"
H=$(curl -fsS "${BASE}/api/health")
echo "$H" | jq . 2>/dev/null || echo "$H"
echo "$H" | grep -q '"status":"ok"' && pass "GET /api/health" || fail "GET /api/health"
echo "$H" | grep -q '"database":"connected"' && pass "Database connected" || fail "Database not connected"

A=$(curl -fsS "${BASE}/api/auth/status")
echo "$A" | jq . 2>/dev/null || echo "$A"
echo "$A" | grep -q '"secureSignInConfigured":true' && pass "Firebase backend" || fail "Firebase backend"
echo "$A" | grep -q '"adminInFirebase":true' && pass "Admin in Firebase" || fail "Admin in Firebase"

echo ""
echo "── Frontend Firebase (login depends on this) ──"
check_firebase_chunk "$BASE" "Custom domain"
check_firebase_chunk "$PACK_URL" "consignment-pack"
check_firebase_chunk "$PACKING_URL" "consignment-packing"

echo ""
echo "── Domain mapping (optional; needs gcloud) ──"
if command -v gcloud >/dev/null 2>&1; then
  DOMAIN_HOST="${BASE#https://}"; DOMAIN_HOST="${DOMAIN_HOST%%/*}"
  for cmd in "gcloud beta run domain-mappings describe" "gcloud alpha run domain-mappings describe"; do
    if $cmd --domain="$DOMAIN_HOST" --region="${REGION:-europe-west1}" --format='value(spec.routeName)' 2>/dev/null; then
      break
    fi
  done | xargs -I{} echo "Domain $DOMAIN_HOST → service: {}"
else
  echo "(skip — gcloud not installed)"
fi

echo ""
echo "════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo "🎉 All checks passed"
else
  echo "⚠️  Some checks failed"
  exit 1
fi
