# GCP Secret Manager + Workload Identity Federation setup

Why: the publish workflow (`.github/workflows/publish.yml`) never sees a long-lived `NPM_TOKEN`. It authenticates to GCP via **Workload Identity Federation** (OIDC, ephemeral tokens), then fetches `NPM_TOKEN` from **Secret Manager** at publish time.

This avoids the most common npm supply-chain failure mode: a leaked CI token used to publish typosquatted packages.

## Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI authenticated as a project owner
- Admin access on this GitHub repo

## One-time setup (5 minutes)

### 1. Enable APIs

```bash
gcloud services enable \
  iam.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com
```

### 2. Create the Workload Identity Pool + provider

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# Pool
gcloud iam workload-identity-pools create "github-pool" \
  --location=global \
  --display-name="GitHub Actions"

# OIDC provider scoped to this repo
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --location=global \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == 'ruvnet/agent-harness-generator'"
```

### 3. Create a publish-time service account

```bash
gcloud iam service-accounts create "agent-harness-publisher" \
  --display-name="agent-harness-generator npm publisher"

PUBLISHER_SA="agent-harness-publisher@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 4. Bind the pool to the SA (only this repo's `main` ref can impersonate)

```bash
gcloud iam service-accounts add-iam-policy-binding "$PUBLISHER_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/ruvnet/agent-harness-generator"
```

### 5. Create the NPM_TOKEN secret

```bash
# Generate an npm access token at https://www.npmjs.com/settings/<your-user>/tokens
# Use "Automation" type; copy it; then:

printf "%s" "$NPM_TOKEN_VALUE" | gcloud secrets create NPM_TOKEN \
  --replication-policy=automatic \
  --data-file=-

# Grant the SA read access
gcloud secrets add-iam-policy-binding NPM_TOKEN \
  --member="serviceAccount:${PUBLISHER_SA}" \
  --role="roles/secretmanager.secretAccessor"
```

### 6. Wire the GitHub repo variables

In **Settings → Secrets and variables → Actions → Variables**, add:

| Variable name | Value |
|---|---|
| `GCP_PROJECT_ID` | `<your-project-id>` |
| `GCP_WIF_PROVIDER` | `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_WIF_SERVICE_ACCOUNT` | `agent-harness-publisher@${PROJECT_ID}.iam.gserviceaccount.com` |

(Note: these are **variables**, not secrets — they're not sensitive on their own. The actual secret is `NPM_TOKEN`, which lives in GCP, not GitHub.)

## How the publish workflow uses it

```yaml
# .github/workflows/publish.yml (excerpt)
- name: GCP Workload Identity Federation
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ env.GCP_WIF_PROVIDER }}
    service_account: ${{ env.GCP_WIF_SERVICE_ACCOUNT }}

- name: Fetch NPM_TOKEN
  id: secrets
  uses: google-github-actions/get-secretmanager-secrets@v2
  with:
    secrets: npm_token:${{ env.GCP_PROJECT_ID }}/NPM_TOKEN

- name: Publish
  env:
    NODE_AUTH_TOKEN: ${{ steps.secrets.outputs.npm_token }}
  run: npm publish --provenance --access public
```

The ephemeral token's lifetime is **the duration of that workflow run**. Even if a step were compromised, the attacker couldn't reuse the token outside that run.

## Verification (test the wire-up before tagging a real release)

```bash
# Manually trigger the publish workflow with a dry-run tag
gh workflow run publish.yml --ref main -f tag=v0.0.0-test
gh run watch
```

The workflow should reach the "Fetch NPM_TOKEN" step and either succeed (token retrieved) or fail with a clear GCP IAM error you can fix above.

## Rotation

NPM tokens age out. To rotate:

```bash
# Generate a fresh token on npm.com, then:
printf "%s" "$NEW_TOKEN" | gcloud secrets versions add NPM_TOKEN --data-file=-
```

The next publish run automatically uses the latest version of the secret. No GitHub change required.

## Optional: Terraform module

If you prefer Terraform over `gcloud`, the equivalent module is shorter:

```hcl
# infra/gcp.tf

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.ref"         = "assertion.ref"
  }
  attribute_condition = "assertion.repository == 'ruvnet/agent-harness-generator'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account" "publisher" {
  account_id   = "agent-harness-publisher"
  display_name = "agent-harness-generator npm publisher"
}

resource "google_service_account_iam_member" "publisher_wif" {
  service_account_id = google_service_account.publisher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/ruvnet/agent-harness-generator"
}

resource "google_secret_manager_secret" "npm_token" {
  secret_id = "NPM_TOKEN"
  replication { auto {} }
}

resource "google_secret_manager_secret_iam_member" "publisher_can_read_npm_token" {
  secret_id = google_secret_manager_secret.npm_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.publisher.email}"
}

data "google_project" "this" {}
```

Terraform vs gcloud: same result. Use whichever your team already runs.

## References

- [GitHub: configure OIDC for GCP](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-google-cloud-platform)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
- [google-github-actions/get-secretmanager-secrets](https://github.com/google-github-actions/get-secretmanager-secrets)
- [GCP Workload Identity Federation overview](https://cloud.google.com/iam/docs/workload-identity-federation)
