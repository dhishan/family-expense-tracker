# GitHub Secrets Configuration

Configure these secrets in your GitHub repository: Settings → Secrets and variables → Actions → New repository secret

## Required Secrets

### 1. GCP Authentication (Workload Identity Federation)

**GCP_WORKLOAD_IDENTITY_PROVIDER**
```
Format: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_NAME/providers/PROVIDER_NAME
```

**GCP_SERVICE_ACCOUNT**
`tf-github@personal-projects-473219.iam.gserviceaccount.com`

### 2. Google OAuth

**GOOGLE_CLIENT_ID**
```
610355955735-0uv0l16rbkr6bd345c34ck690s892kn6.apps.googleusercontent.com
```

---

## How to Set Up Workload Identity Federation

### 1. Create Workload Identity Pool

```bash
gcloud iam workload-identity-pools create github-actions \
  --project=personal-projects-473219 \
  --location=global \
  --display-name="GitHub Actions Pool"
```

### 2. Create Workload Identity Provider

```bash
gcloud iam workload-identity-pools providers create-oidc github \
  --project=personal-projects-473219 \
  --location=global \
  --workload-identity-pool=github-actions \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

### 3. Create Service Account

```bash
gcloud iam service-accounts create github-actions \
  --project=personal-projects-473219 \
  --display-name="GitHub Actions Service Account"
```

### 4. Grant Permissions to Service Account

```bash
# Cloud Run Admin
gcloud projects add-iam-policy-binding personal-projects-473219 \
  --member="serviceAccount:github-actions@personal-projects-473219.iam.gserviceaccount.com" \
  --role="roles/run.admin"

# Artifact Registry Writer
gcloud projects add-iam-policy-binding personal-projects-473219 \
  --member="serviceAccount:github-actions@personal-projects-473219.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Storage Admin (for frontend bucket)
gcloud projects add-iam-policy-binding personal-projects-473219 \
  --member="serviceAccount:github-actions@personal-projects-473219.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

# Compute Admin (for CDN cache invalidation)
gcloud projects add-iam-policy-binding personal-projects-473219 \
  --member="serviceAccount:github-actions@personal-projects-473219.iam.gserviceaccount.com" \
  --role="roles/compute.admin"

# Service Account User
gcloud projects add-iam-policy-binding personal-projects-473219 \
  --member="serviceAccount:github-actions@personal-projects-473219.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

### 5. Allow GitHub Actions to Impersonate Service Account

```bash
# Replace YOUR_GITHUB_USERNAME with your GitHub username
# Replace YOUR_REPO_NAME with your repository name

gcloud iam service-accounts add-iam-policy-binding github-actions@personal-projects-473219.iam.gserviceaccount.com \
  --project=personal-projects-473219 \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME"
```

### 6. Get the Workload Identity Provider Name

```bash
gcloud iam workload-identity-pools providers describe github \
  --project=personal-projects-473219 \
  --location=global \
  --workload-identity-pool=github-actions \
  --format="value(name)"
```

This outputs something like:
```
projects/610355955735/locations/global/workloadIdentityPools/github-actions/providers/github
```

**Use this as your `GCP_WORKLOAD_IDENTITY_PROVIDER` secret.**

---

## Summary of Secrets to Add

Go to: `https://github.com/YOUR_USERNAME/YOUR_REPO/settings/secrets/actions`

| Secret Name | Value |
|-------------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/610355955735/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `github-actions@personal-projects-473219.iam.gserviceaccount.com` |
| `GOOGLE_CLIENT_ID` | `610355955735-0uv0l16rbkr6bd345c34ck690s892kn6.apps.googleusercontent.com` |

---

## What the CI/CD Pipeline Does

1. **Test Backend** - Runs Python tests
2. **Test Frontend** - Lints and builds frontend
3. **Deploy Backend** (on push to main):
   - Builds Docker image with platform `linux/amd64`
   - Pushes to Artifact Registry
   - Deploys to Cloud Run via Terraform
4. **Deploy Frontend** (on push to main):
   - Builds with production env vars
   - Uploads to Cloud Storage
   - Sets proper cache headers
   - Invalidates CDN cache

---

## Local Development vs CI/CD

**Local**: Uses `.env` and `.env.production` files
**CI/CD**: Uses GitHub Secrets for sensitive values
