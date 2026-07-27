#!/usr/bin/env bash
# DEPRECATED — GCP Secret Manager is no longer used by CI deploy.
#
# App secrets stay in GitHub Actions Secrets and are written as normal
# Cloud Run environment variables by scripts/gcloud-deploy.sh.
#
# Keeping this file only so old docs/bookmarks do not 404; it exits with guidance.
set -euo pipefail
echo "DEPRECATED: scripts/sync-secrets-to-gcp.sh is unused."
echo "Deploy uses GitHub Secrets → Cloud Run env vars (see scripts/gcloud-deploy.sh)."
echo "Secret Manager was removed to avoid ongoing cost."
exit 1
