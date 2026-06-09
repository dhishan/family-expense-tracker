# Hosted MCP Server - Deploy Runbook

The MCP server is mounted at `/mcp` on the existing backend Cloud Run service and exposed
at `mcp.expense-tracker.blueelephants.org`, gated by Cloudflare Access (Google SSO).

---

## Prerequisites

- `gcloud` CLI authenticated as `dhishan.coder@gmail.com` (not the CI SA)
- `terraform` >= 1.9 available
- The four secrets below exist or you have their values ready

---

## Step 1 - Populate secrets in Google Secret Manager

These secrets are created as empty resources by Terraform (so plaintext never lands in
state). You must add a version for each before Cloud Run can start.

Run these commands once. Replace the `VALUE` placeholders with real values.

```bash
PROJECT=personal-projects-473219
SVC=expense-tracker-backend

# SnapTrade credentials (from snaptrade.com dashboard)
echo -n "YOUR_SNAPTRADE_CLIENT_ID" | \
  gcloud secrets versions add ${SVC}-snaptrade-client-id \
    --data-file=- --project=${PROJECT}

echo -n "YOUR_SNAPTRADE_CONSUMER_KEY" | \
  gcloud secrets versions add ${SVC}-snaptrade-consumer-key \
    --data-file=- --project=${PROJECT}

# Anthropic API key (from console.anthropic.com)
echo -n "sk-ant-..." | \
  gcloud secrets versions add ${SVC}-anthropic-api-key \
    --data-file=- --project=${PROJECT}

# Cloudflare Access AUD tag — read from .env (already in backend/.env)
echo -n "$CF_ACCESS_AUD" | \
  gcloud secrets versions add ${SVC}-cf-access-aud \
    --data-file=- --project=${PROJECT}
```

You only need to run these once. Future rotations use the same command (a new version is
added; the old one stays but Cloud Run picks up `latest`).

---

## Step 2 - Create the MCP Cloud Run domain mapping (manual, one-time)

The CI service account (`tf-github`) is not a verified Google Search Console domain owner,
so it cannot create Cloud Run domain mappings. You must create the mapping once with your
own credentials, then import it into Terraform state so CI can manage it going forward.

```bash
# Create the domain mapping with your user credentials
gcloud alpha run domain-mappings create \
  --service expense-tracker-backend \
  --domain mcp.expense-tracker.blueelephants.org \
  --region us-central1 \
  --project personal-projects-473219

# Import into Terraform state so TF doesn't try to re-create it
cd terraform/main
terraform import \
  'google_cloud_run_domain_mapping.mcp' \
  'us-central1/mcp.expense-tracker.blueelephants.org'
```

After the import, `terraform plan` should show no changes for `google_cloud_run_domain_mapping.mcp`.

---

## Step 3 - Run terraform apply

```bash
cd terraform/main

terraform init \
  -backend-config="bucket=dhishan-terraform-assets" \
  -backend-config="prefix=family-expense-tracker/prod/state"

terraform plan \
  -var="google_client_secret=${GOOGLE_CLIENT_SECRET}"

terraform apply \
  -var="google_client_secret=${GOOGLE_CLIENT_SECRET}"
```

Expected resource count on first apply (new resources only):
- 4 x `google_secret_manager_secret` (snaptrade-client-id, snaptrade-consumer-key, anthropic-api-key, cf-access-aud)
- 1 x `google_cloud_run_domain_mapping.mcp` (already imported - shows 0 changes)
- 1 x `cloudflare_record.mcp_cname`
- Updated `google_cloud_run_service.backend` (new env vars wired in)

---

## Step 4 - Verify the deploy

```bash
# Should redirect to Cloudflare Access login page (302 or 200 with CF Access HTML)
curl -I https://mcp.expense-tracker.blueelephants.org/

# With a valid CF Access session cookie (grab from browser DevTools after logging in):
curl -H "Cookie: CF_Authorization=<your-jwt>" \
  https://mcp.expense-tracker.blueelephants.org/

# Check the MCP endpoint health
curl -H "Cookie: CF_Authorization=<your-jwt>" \
  https://mcp.expense-tracker.blueelephants.org/health
```

The CNAME record is set to proxied=true (orange-cloud). This is required: Cloudflare Access
only injects the `Cf-Access-Jwt-Assertion` header when traffic flows through the CF proxy.
DNS-only (gray-cloud) would bypass CF entirely, and every MCP request would be rejected.

Because Cloudflare terminates TLS at the edge, HTTPS is available immediately - no
Google-managed cert provisioning wait for this subdomain.

### End-to-end test from Claude Desktop

1. Add the MCP server to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "family-expense-tracker": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.expense-tracker.blueelephants.org/mcp"
      ]
    }
  }
}
```

2. Restart Claude Desktop.
3. The first connection triggers a Cloudflare Access OAuth flow in your browser.
4. After approving, Claude Desktop should list the MCP server's tools.

---

## Adding more family members (Cloudflare Access policy)

The Cloudflare Access application policy is managed via the Cloudflare API (not Terraform).
To add a new email to the allowlist, use the API:

```bash
CF_API_TOKEN="<your-cloudflare-api-token>"
CF_ACCOUNT_ID="8f47aec7a2756ec1917e4993e9de1da7"
CF_APP_ID="<application-id>"  # find via: curl -H "Authorization: Bearer $CF_API_TOKEN" \
                               #   "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps"

# Get existing policy ID first, then update it to add the new email
# Cloudflare Access UI at https://one.dash.cloudflare.com is the easiest route for one-off adds.
```

For bulk changes or automation, use the Cloudflare API:
`https://developers.cloudflare.com/api/operations/access-policies-update-an-access-policy`

---

## Rollback

If the new env vars cause a Cloud Run startup failure:

```bash
# Identify the last known-good revision
gcloud run revisions list \
  --service expense-tracker-backend \
  --region us-central1 \
  --project personal-projects-473219

# Pin traffic to a specific revision
gcloud run services update-traffic expense-tracker-backend \
  --to-revisions <REVISION-NAME>=100 \
  --region us-central1 \
  --project personal-projects-473219
```

To remove the MCP subdomain without touching the main backend:

```bash
# Remove the domain mapping
gcloud alpha run domain-mappings delete mcp.expense-tracker.blueelephants.org \
  --region us-central1 \
  --project personal-projects-473219

# Remove the Cloudflare DNS record (via dashboard or API)
```

---

## Secret rotation

To rotate a secret value:

```bash
echo -n "NEW_VALUE" | \
  gcloud secrets versions add expense-tracker-backend-<secret-name> \
    --data-file=- --project=personal-projects-473219
```

Cloud Run picks up `latest` on the next cold start / new revision. To force a new revision
immediately:

```bash
gcloud run services update expense-tracker-backend \
  --region us-central1 \
  --project personal-projects-473219
```
