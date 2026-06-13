#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# scripts/setup-gcp.sh
# One-shot GCP Workload Identity Federation + Secret Manager setup for the
# agent-harness-generator publish workflow. Documented step-by-step in
# docs/setup/gcp-secrets.md; this script automates the gcloud commands so
# you don't have to copy-paste.
#
# Requirements:
#   - gcloud CLI authenticated as a project owner
#   - GitHub repo "ruvnet/agent-harness-generator" exists
#   - $NPM_TOKEN env var set to the publish token (Automation type)
#
# Usage:
#   NPM_TOKEN=npm_xxx ./scripts/setup-gcp.sh
#
# Re-runnable. Skips steps that are already done (best-effort idempotency).

set -euo pipefail

REPO="${REPO:-ruvnet/agent-harness-generator}"
POOL="${POOL:-github-pool}"
PROVIDER="${PROVIDER:-github-provider}"
SA_NAME="${SA_NAME:-agent-harness-publisher}"
SECRET_NAME="${SECRET_NAME:-NPM_TOKEN}"

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [[ -z "${PROJECT_ID}" ]]; then
  echo "Error: no gcloud project set. Run: gcloud config set project <id>" >&2
  exit 1
fi
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "Error: \$NPM_TOKEN env var is required" >&2
  echo "Generate one at https://www.npmjs.com/settings/<your-user>/tokens (Automation type)" >&2
  exit 1
fi

echo "==> Using project: $PROJECT_ID (number: $PROJECT_NUMBER)"
echo "==> Target repo:   $REPO"
echo

echo "==> 1. Enable APIs"
gcloud services enable \
  iam.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com --quiet

echo
echo "==> 2. Create Workload Identity Pool: $POOL"
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global &>/dev/null; then
  gcloud iam workload-identity-pools create "$POOL" \
    --location=global \
    --display-name="GitHub Actions"
else
  echo "    (already exists)"
fi

echo
echo "==> 3. Create OIDC provider: $PROVIDER"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --location=global --workload-identity-pool="$POOL" &>/dev/null; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global \
    --workload-identity-pool="$POOL" \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '$REPO'"
else
  echo "    (already exists)"
fi

echo
echo "==> 4. Create publisher SA: $SA_NAME"
PUBLISHER_SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$PUBLISHER_SA" &>/dev/null; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="agent-harness-generator npm publisher"
else
  echo "    (already exists)"
fi

echo
echo "==> 5. Bind WIF pool to SA (only $REPO can impersonate)"
gcloud iam service-accounts add-iam-policy-binding "$PUBLISHER_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet

echo
echo "==> 6. Create / update secret: $SECRET_NAME"
if ! gcloud secrets describe "$SECRET_NAME" &>/dev/null; then
  printf "%s" "$NPM_TOKEN" | gcloud secrets create "$SECRET_NAME" \
    --replication-policy=automatic \
    --data-file=-
else
  echo "    (already exists — adding a new version)"
  printf "%s" "$NPM_TOKEN" | gcloud secrets versions add "$SECRET_NAME" --data-file=-
fi

echo
echo "==> 7. Grant SA read access to the secret"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:${PUBLISHER_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

echo
echo "==> 8. Wire these into GitHub repo variables"
echo
echo "Go to: https://github.com/$REPO/settings/variables/actions"
echo "Add:"
echo "  GCP_PROJECT_ID         = $PROJECT_ID"
echo "  GCP_WIF_PROVIDER       = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "  GCP_WIF_SERVICE_ACCOUNT = $PUBLISHER_SA"
echo
echo "(Note: these are VARIABLES, not secrets — they are not sensitive on their own. The actual secret is $SECRET_NAME, which lives in GCP, not GitHub.)"
echo
echo "Done."
