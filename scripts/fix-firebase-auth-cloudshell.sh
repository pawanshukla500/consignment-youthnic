#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Fix Firebase Auth + Cloud Run login for Consignment Packing App
#
# Run in Google Cloud Shell (https://shell.cloud.google.com):
#   curl -fsSL https://raw.githubusercontent.com/pawanshukla500/consignment-pack/main/scripts/fix-firebase-auth-cloudshell.sh | bash
#
# Or clone the repo and run:
#   bash scripts/fix-firebase-auth-cloudshell.sh
#
# What this does:
#   1. Removes ADMIN_PASSWORD from Cloud Run (Firebase Auth owns passwords)
#   2. Fixes ALLOWED_ORIGINS (Cloud Run URL + custom domain)
#   3. Verifies JWT_SECRET + Firebase service account secrets
#   4. Resets admin password in Firebase Auth (optional, interactive)
#   5. Adds authorized domains for password reset
#   6. Runs health + auth status checks
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# GCP project where Cloud Run is deployed (Cloud Console project selector).
# Project NUMBER 426872152845 appears in the Cloud Run URL — verify with:
#   gcloud projects describe robust-solution-425310-t9 --format='value(projectNumber)'
PROJECT_ID="${GCP_PROJECT_ID:-robust-solution-425310-t9}"
# Firebase project (Authentication + Storage) — usually same GCP project, different console label.
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-consignment-packing-app}"
REGION="${CLOUD_RUN_REGION:-europe-west1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-consignment-packing}"
ADMIN_EMAIL="${ADMIN_EMAIL:-returnorders@vbexports.co.in}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-https://consignment.youthnic.shop}"

echo "═══════════════════════════════════════════════════════════════"
echo " Consignment Packing — Firebase Auth + Cloud Run Fix"
echo " GCP Project:     $PROJECT_ID"
echo " Firebase Project: $FIREBASE_PROJECT_ID"
echo " Region:   $REGION"
echo " Service:  $SERVICE_NAME"
echo " Admin:    $ADMIN_EMAIL"
echo "═══════════════════════════════════════════════════════════════"

gcloud config set project "$PROJECT_ID"

# ── 1. Get Cloud Run URL ─────────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format='value(status.url)' 2>/dev/null || true)

if [ -z "$SERVICE_URL" ]; then
  echo "ERROR: Cloud Run service '$SERVICE_NAME' not found in $REGION"
  exit 1
fi
echo "Cloud Run URL: $SERVICE_URL"

# ── 2. Remove ADMIN_PASSWORD + fix ALLOWED_ORIGINS ─────────────────────────
ALLOWED_ORIGINS="${CUSTOM_DOMAIN},${SERVICE_URL}"
echo "Setting ALLOWED_ORIGINS=$ALLOWED_ORIGINS"
echo "Removing ADMIN_PASSWORD from Cloud Run (Firebase Auth is password source)..."

gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --remove-env-vars="ADMIN_PASSWORD" \
  --update-env-vars="^##^ALLOWED_ORIGINS=${ALLOWED_ORIGINS}" \
  --quiet

echo "✅ Cloud Run env updated"

# ── 3. Verify secrets are attached ─────────────────────────────────────────
echo ""
echo "Checking Cloud Run secrets..."
gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format='yaml(spec.template.spec.containers[0].env)' | grep -E 'JWT_SECRET|RESEND|FIREBASE' || true

# ── 4. Health + auth status ──────────────────────────────────────────────────
echo ""
echo "Health check..."
curl -fsS "${SERVICE_URL}/api/health" | tee /tmp/health.json
echo ""
echo "Auth status..."
curl -fsS "${SERVICE_URL}/api/auth/status" | tee /tmp/auth-status.json
echo ""

# ── 5. CORS smoke test (this was the login bug) ──────────────────────────────
echo "CORS test (Origin: $SERVICE_URL)..."
CORS_RESULT=$(curl -sS -X POST "${SERVICE_URL}/api/auth/firebase-login" \
  -H "Origin: ${SERVICE_URL}" \
  -H "Content-Type: application/json" \
  -d '{"idToken":"invalid"}' || true)

if echo "$CORS_RESULT" | grep -q "Internal server error"; then
  echo "❌ CORS still broken — redeploy latest code from main branch"
  echo "   Response: $CORS_RESULT"
  echo ""
  echo "   Quick fix until redeploy: the server must allow *.run.app origins."
  echo "   Merge PR with CORS fix and push to main, or run:"
  echo "   gcloud run services update $SERVICE_NAME --region=$REGION --image=gcr.io/$PROJECT_ID/$SERVICE_NAME:latest"
else
  echo "✅ CORS OK — response: $CORS_RESULT"
fi

# ── 6. Firebase Admin SDK — reset password (optional) ────────────────────────
echo ""
read -r -p "Reset admin password in Firebase Auth now? [y/N] " RESET_PW
if [[ "$RESET_PW" =~ ^[Yy]$ ]]; then
  read -r -s -p "Enter new password for $ADMIN_EMAIL: " NEW_PASSWORD
  echo ""

  # Write temp service account from Secret Manager (if available)
  SA_JSON=$(gcloud secrets versions access latest --secret=FIREBASE_SERVICE_ACCOUNT_JSON 2>/dev/null || true)
  if [ -z "$SA_JSON" ]; then
    echo "FIREBASE_SERVICE_ACCOUNT_JSON secret not found in Secret Manager."
    echo "Download service account JSON from Firebase Console → Project Settings → Service Accounts"
    read -r -p "Path to serviceAccountKey.json: " SA_PATH
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH"
  else
    SA_TMP=$(mktemp)
    echo "$SA_JSON" > "$SA_TMP"
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_TMP"
  fi

  cat > /tmp/reset-admin-pw.mjs << 'EOF'
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const email = process.env.ADMIN_EMAIL;
const password = process.env.NEW_PASSWORD;

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS not set');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });

try {
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(user.uid, { password, emailVerified: true });
  console.log('✅ Password updated for existing user:', email, 'uid:', user.uid);
} catch (e) {
  if (e.code === 'auth/user-not-found') {
    const created = await admin.auth().createUser({
      email,
      password,
      emailVerified: true,
      displayName: 'Pawan Shukla',
    });
    console.log('✅ Created admin user:', email, 'uid:', created.uid);
  } else {
    throw e;
  }
}
EOF

  if ! command -v node >/dev/null 2>&1; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  cd /tmp
  npm init -y >/dev/null 2>&1
  npm install firebase-admin >/dev/null 2>&1

  ADMIN_EMAIL="$ADMIN_EMAIL" NEW_PASSWORD="$NEW_PASSWORD" node reset-admin-pw.mjs
  echo "✅ Firebase Auth password set. Sign in at: ${SERVICE_URL}/login"
fi

# ── 7. Firebase authorized domains reminder ──────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Firebase Console checklist (do manually if not done):"
echo "   https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/authentication/settings"
echo ""
echo "   1. Sign-in method → Email/Password: ENABLED"
echo "   2. Sign-in method → Google: ENABLED (optional)"
echo "   3. Authorized domains — add BOTH:"
echo "      • $(echo "$SERVICE_URL" | sed 's|https://||')"
echo "      • $(echo "$CUSTOM_DOMAIN" | sed 's|https://||')"
echo ""
echo "   4. Authentication → Users → verify $ADMIN_EMAIL exists"
echo "   5. Set password in Firebase Console OR use Forgot password on login page"
echo ""
echo " Login URL: ${SERVICE_URL}/login"
echo " Custom domain: ${CUSTOM_DOMAIN}/login"
echo "═══════════════════════════════════════════════════════════════"
