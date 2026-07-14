#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# End-to-end endpoint test against a live deployment (Postgres-backed).
# Usage:
#   ADMIN_EMAIL=you@example.com ADMIN_TEST_PASSWORD='...' \
#     bash test-endpoints.sh https://your-app.example.com
#
# Requires a Firebase-backed login. Legacy /api/auth/login is not available.
# Prefer smoke-test.js with a Firebase ID token for CI.
# ════════════════════════════════════════════════════════════════════════════
BASE="${1:-https://consignment.youthnic.shop}"
EMAIL="${ADMIN_EMAIL:-}"
PASS="${ADMIN_TEST_PASSWORD:-}"
PASS_FAIL=0

if [ -z "$EMAIL" ] || [ -z "$PASS" ]; then
  echo "Set ADMIN_EMAIL and ADMIN_TEST_PASSWORD in the environment (never commit passwords)."
  exit 1
fi

echo "Testing: $BASE"
echo "════════════════════════════════════════"
echo "Note: This script expects a Bearer token via FIREBASE_ID_TOKEN or fails."
echo "Obtain a Firebase ID token from the client, then:"
echo "  FIREBASE_ID_TOKEN=... bash test-endpoints.sh $BASE"

ID_TOKEN="${FIREBASE_ID_TOKEN:-}"
if [ -z "$ID_TOKEN" ]; then
  echo "❌ FIREBASE_ID_TOKEN not set — aborting"
  exit 1
fi

TOKEN=$(curl -s -X POST "$BASE/api/auth/firebase-login" -H "Content-Type: application/json" \
  -d "{\"idToken\":\"$ID_TOKEN\"}" \
  | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"//' )

if [ -z "$TOKEN" ]; then echo "❌ LOGIN FAILED — aborting"; exit 1; fi
echo "✅ Login OK"

check() {
  local label=$1 method=$2 path=$3 data=$4 expect=${5:-200}
  if [ -n "$data" ]; then
    code=$(curl -s -o /tmp/resp -w "%{http_code}" -X "$method" "$BASE$path" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$data")
  else
    code=$(curl -s -o /tmp/resp -w "%{http_code}" -X "$method" "$BASE$path" -H "Authorization: Bearer $TOKEN")
  fi
  if [ "$code" = "$expect" ]; then echo "✅ $label ($code)"; else echo "❌ $label (got $code, want $expect)"; PASS_FAIL=1; fi
}

check "Health" GET /api/health
check "Me" GET /api/auth/me
check "Consignments" GET /api/consignments
check "Marketplaces" GET /api/marketplaces

exit $PASS_FAIL
