# Family Expense Tracker

A family expense tracking application with brokerage portfolio integration and a Claude-powered financial analyst. Web + native iOS app, all sharing the same FastAPI backend.

## Features

### Expenses & budgets
- Log expenses with amount, date, description, merchant, payment method, and beneficiary
- 10 default categories (Groceries, Dining, Transportation, Utilities, Entertainment, Healthcare, Shopping, Travel, Education, Other)
- Family workspace — invite members to share expenses
- Budgets by category, time period (weekly/monthly), and beneficiary, with over-budget alerts
- Dashboard with visual summary, recent activity, budget progress

### Investments
- Connect brokerage accounts via SnapTrade (Robinhood, E*TRADE, and 30+ others)
- Live holdings, cost basis, unrealized P&L, recent transactions
- Eye toggle to hide values for privacy

### AI chat (Claude-powered)
- In-app `/chat` page and a hosted MCP server that Claude Desktop / Claude mobile can call
- 25 tools across SnapTrade brokerage, FRED macro, Tiingo price history, Finnhub quotes/news/analyst data, SEC EDGAR filings, and your own expense/budget data
- **Durable conversations** — every chat is stored in Firestore (`chat_conversations` collection, per-user isolated). Generation runs as a background asyncio task that survives client disconnects; the SSE stream is resumable from `?from_seq=N` so backgrounding the iOS app and returning picks up exactly where it left off
- **History UI** in both mobile and web — recent chats, full transcripts, swipe-to-delete
- Auto-compaction (Anthropic beta) + per-tool result truncation to keep input-token usage bounded
- Adaptive routing (Sonnet 4.6 by default, Opus 4.7 only on explicit "deep analysis" keywords) + "brief" system prompt by default — typical chat 25-50s instead of 130-190s
- Langfuse tracing with per-turn LLM generations + per-tool spans for cost analytics
- Hosted MCP gated by Cloudflare Access (Google SSO)

### Mobile (native iOS)
- React Native + Expo (SDK 53) app sharing the same backend
- Native Google Sign-In via `@react-native-google-signin/google-signin`
- Silent re-auth on app launch (session survives reinstall via Google's OS-level account cache)
- EAS Update — push JS-only changes OTA in ~10 seconds without rebuild

## Install as a native-feeling app

The web app is a PWA, so you can add it to your phone or Mac and launch it like a real app — no browser chrome, own icon, own window.

**iPhone / iPad (Safari, iOS 17.4+):**
1. Open `https://ui.expense-tracker.blueelephants.org` in Safari
2. Tap **Share** (square with up-arrow) → **Add to Home Screen**
3. If you see the **Open as Web App** toggle, turn it on
4. Tap **Add**

Launch from the Home Screen icon to get the standalone, full-screen experience.

**Mac (Safari 17+):**
1. Open the site in Safari
2. **File → Add to Dock**
3. Pick a name and icon → **Add**

It launches as its own Dock app with no browser controls.

The native mobile app (Expo + EAS) is a separate distribution — see `mobile/` and the IPA releases in GitHub Releases.

## Tech Stack

- **Frontend (web)**: React 18, TypeScript, Vite, Tailwind CSS, React Query
- **Frontend (mobile)**: React Native 0.79 + Expo SDK 53, NativeWind, expo-router
- **Backend**: Python 3.12, FastAPI, Anthropic SDK, Langfuse v4 SDK, SnapTrade SDK, MCP SDK
- **Database**: Google Cloud Firestore
- **Infrastructure**: GCP Cloud Run (backend), **Firebase Hosting (frontend)**, Firestore, Secret Manager, Terraform, Cloudflare (DNS + Access for MCP)
- **Auth**: Google OAuth 2.0 (web + iOS native clients), Cloudflare Access for the MCP endpoint
- **CI/CD**: GitHub Actions
- **OTA**: EAS Update (Expo)

## External Accounts & API Keys

This section is the single source of truth for every account and credential the app depends on. **All accounts are free** unless flagged otherwise.

### Required (app won't run without these)

| Account | Used for | Where to sign up | Stored as |
|---|---|---|---|
| **Google Cloud Platform** | Firestore, Cloud Run, Secret Manager, Firebase Hosting, OAuth | https://console.cloud.google.com | `personal-projects-473219` (this repo's project ID) |
| **Google OAuth** | Sign-in (web + iOS native) | GCP Console → Credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` |
| **Anthropic** | Claude API for `/chat` and the analyzer scripts | https://console.anthropic.com | `ANTHROPIC_API_KEY` (Secret Manager in prod, `backend/.env` locally) |
| **SnapTrade** | Brokerage data aggregator | https://snaptrade.com | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` |
| **GitHub** | CI/CD via GitHub Actions | https://github.com | OIDC federation to GCP service account (no static key) |

### Required for the hosted MCP

| Account | Used for | Where to sign up |
|---|---|---|
| **Cloudflare** | DNS + Access for `mcp.expense-tracker.blueelephants.org` | https://dash.cloudflare.com (free tier) |
| **Cloudflare Zero Trust** | OAuth-gated access to the MCP endpoint | Enabled inside the Cloudflare dashboard (free up to 50 users) |

The Cloudflare Access app is configured via API — see `docs/HOSTED_MCP_DEPLOY.md`. Required env vars: `CF_ACCESS_TEAM_DOMAIN` (e.g. `blueelephants.cloudflareaccess.com`), `CF_ACCESS_AUD` (Application AUD tag).

### Required for observability

| Account | Used for | Where to sign up |
|---|---|---|
| **Langfuse** | LLM tracing for the `/chat` endpoint | https://us.cloud.langfuse.com (free tier; self-hostable) |

Env vars: `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`.

### Required for financial-data tools (chat + MCP)

All free tiers; sign up only the ones you actually want to use.

| Service | What it adds | Where to sign up | Env var |
|---|---|---|---|
| **FRED** (Federal Reserve) | US macro data — Fed funds rate, CPI, unemployment, yield curve | https://fred.stlouisfed.org/docs/api/api_key.html | `FRED_API_KEY` |
| **Tiingo** | Price history + company metadata | https://www.tiingo.com | `TIINGO_API_KEY` |
| **Finnhub** | Real-time quotes, news, analyst ratings, earnings | https://finnhub.io | `FINNHUB_API_KEY` |
| **SEC EDGAR** | 10-K, 10-Q, 8-K, Form 4 filings | No signup — just requires a polite `User-Agent` | _none_ |

### Required for mobile (iOS) install on real devices

| Account | Used for | Cost |
|---|---|---|
| **Apple ID** | Free Personal Team dev certificate (7-day expiry, up to 3 devices) | Free |
| **Expo** | EAS Update OTA pushes, optional EAS Build | Free tier: 1000 updates/month |
| **Apple Developer Program** | Optional — 1-year cert, TestFlight, App Store | $99/year |

The free Apple ID + Expo combination is enough for installing on 2-3 family phones with weekly cert auto-refresh via [AltStore](https://altstore.io) or [SideStore](https://sidestore.io). The $99/year Apple Developer Program is only needed if you want App Store distribution or 1-year certs without the AltStore dance.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local frontend development)
- Python 3.12+ (for local backend development; `uv` recommended for venv)
- Google Cloud SDK
- A GCP project with billing enabled
- All API keys from the table above for the features you want to use

### GCP Setup

Before running the application, you need to set up Google Cloud resources.

#### 1. Create a GCP Project (if needed)

**Using Console:**
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click the project dropdown → "New Project"
3. Enter project name and click "Create"

**Using CLI:**
```bash
# Set as active project
gcloud config set project personal-projects-473219

# Enable billing (required for Cloud Run)
# You'll need to do this in the console: https://console.cloud.google.com/billing
```

#### 2. Enable Required APIs

**Using Console:**
1. Go to [APIs & Services](https://console.cloud.google.com/apis/library)
2. Search and enable each:
   - Cloud Run API
   - Cloud Firestore API
   - Artifact Registry API
   - Secret Manager API
   - Compute Engine API
   - IAM Service Account Credentials API

**Using CLI:**
```bash
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  compute.googleapis.com \
  iamcredentials.googleapis.com \
  storage.googleapis.com
```

#### 3. Set Up OAuth Consent Screen

**Using Console:**
1. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Select **External** user type (or Internal if using Google Workspace)
3. Click "Create"
4. Fill in the required fields:
   - **App name**: Family Expense Tracker
   - **User support email**: your-email@gmail.com
   - **Developer contact email**: your-email@gmail.com
5. Click "Save and Continue"
6. **Scopes**: Click "Add or Remove Scopes"
   - Select: `email`, `profile`, `openid`
   - Click "Update" then "Save and Continue"
7. **Test users** (for External apps in testing):
   - Add your email addresses
   - Click "Save and Continue"
8. Review and click "Back to Dashboard"

> **Note**: For production, you'll need to submit for verification. During development, the app works for test users only.

#### 4. Create OAuth 2.0 Client ID

**Using Console:**
1. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" → "OAuth client ID"
3. Select **Web application**
4. Configure:
   - **Name**: Family Expense Tracker Web Client
   - **Authorized JavaScript origins**:
     ```
     http://localhost:5173
     http://localhost:3000
     https://app.blueelephants.org
     ```
   - **Authorized redirect URIs**:
     ```
     http://localhost:5173
     http://localhost:5173/auth/callback
     https://app.blueelephants.org
     https://app.blueelephants.org/auth/callback
     ```
5. Click "Create"
6. Copy the **Client ID** (you'll need this for both frontend and backend)

**Using CLI:**
```bash
# Note: OAuth client creation via CLI is limited. 
# It's recommended to use the Console for this step.

# However, you can list existing clients:
gcloud alpha iap oauth-clients list
```

#### 5. Create Firestore Database

**Using Console:**
1. Go to [Firestore](https://console.cloud.google.com/firestore)
2. Click "Create Database"
3. Select **Native mode**
4. Choose location: `us-central1` (or your preferred region)
5. Click "Create"

**Using CLI:**
```bash
# Create Firestore database
gcloud firestore databases create \
  --database=family-expense-tracker-dev \
  --location=us-central1 \
  --type=firestore-native
```

#### 6. Set Up GitHub Actions Authentication (Workload Identity Federation)

This allows GitHub Actions to deploy to GCP without storing service account keys.

**Using Console:**

1. **Create a Service Account:**
   - Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
   - Click "Create Service Account"
   - Name: `github-actions-deployer`
   - Click "Create and Continue"
   - Grant roles:
     - `Cloud Run Admin`
     - `Storage Admin`
     - `Artifact Registry Writer`
     - `Service Account User`
   - Click "Done"

2. **Create Workload Identity Pool:**
   - Go to [Workload Identity Federation](https://console.cloud.google.com/iam-admin/workload-identity-pools)
   - Click "Create Pool"
   - Name: `github-actions-pool`
   - Click "Continue"
   - Select provider: **OpenID Connect (OIDC)**
   - Provider name: `github-provider`
   - Issuer URL: `https://token.actions.githubusercontent.com`
   - Click "Continue"
   - Configure attribute mapping:
     - `google.subject` = `assertion.sub`
     - `attribute.actor` = `assertion.actor`
     - `attribute.repository` = `assertion.repository`
   - Click "Save"

3. **Grant Service Account Access:**
   - In the Workload Identity Pool, click on your provider
   - Click "Grant Access"
   - Select your service account: `github-actions-deployer`
   - Add attribute condition:
     ```
     attribute.repository == "YOUR_GITHUB_USERNAME/family-expense-tracker"
     ```
   - Click "Save"

**Using CLI:**
```bash
# Set variables
export PROJECT_ID="your-project-id"
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export GITHUB_REPO="YOUR_GITHUB_USERNAME/family-expense-tracker"
export SA_NAME="github-actions-deployer"
export POOL_NAME="github-actions-pool"
export PROVIDER_NAME="github-provider"

# Create service account
gcloud iam service-accounts create $SA_NAME \
  --display-name="GitHub Actions Deployer"

# Grant roles to service account
for role in "roles/run.admin" "roles/storage.admin" "roles/artifactregistry.writer" "roles/iam.serviceAccountUser"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$role"
done

# Create Workload Identity Pool
gcloud iam workload-identity-pools create $POOL_NAME \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create OIDC Provider
gcloud iam workload-identity-pools providers create-oidc $PROVIDER_NAME \
  --location="global" \
  --workload-identity-pool=$POOL_NAME \
  --display-name="GitHub Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository"

# Allow GitHub repo to impersonate service account
gcloud iam service-accounts add-iam-policy-binding \
  "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/attribute.repository/${GITHUB_REPO}"

# Get the Workload Identity Provider resource name (for GitHub secrets)
echo "GCP_WORKLOAD_IDENTITY_PROVIDER:"
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/providers/${PROVIDER_NAME}"

echo "GCP_SERVICE_ACCOUNT:"
echo "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

#### 7. Configure GitHub Repository Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/610355955735/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT` | `tf-github@personal-projects-473219.iam.gserviceaccount.com` |
| `GOOGLE_CLIENT_ID` | `610355955735-0uv0l16rbkr6bd345c34ck690s892kn6.apps.googleusercontent.com` |

#### 8. Create Artifact Registry Repository

**Using Console:**
1. Go to [Artifact Registry](https://console.cloud.google.com/artifacts)
2. Click "Create Repository"
3. Name: `expense-tracker-backend`
4. Format: Docker
5. Region: `us-central1`
6. Click "Create"

**Using CLI:**
```bash
gcloud artifacts repositories create expense-tracker-backend \
  --repository-format=docker \
  --location=us-central1 \
  --description="Expense Tracker backend images"
```

### Local Development with Docker

1. **Clone and setup environment files**:
   ```bash
   git clone <repository-url>
   cd family-expense-tracker
   
   # Copy environment templates
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

2. **Configure environment variables**:
   
   Edit `backend/.env`:
   ```
   GCP_PROJECT_ID=personal-projects-473219
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   JWT_SECRET_KEY=your-secret-key  # generate with: openssl rand -hex 32
   FIRESTORE_DATABASE=family-expense-tracker-dev
   FRONTEND_URL=http://localhost:5173
   ```
   
   Edit `frontend/.env`:
   ```
   VITE_API_URL=http://localhost:8000
   VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```

3. **Start with Docker Compose**:
   ```bash
   # Start backend and frontend in development mode
   make docker-dev
   
   # Or start just production builds
   make docker-up
   ```

4. **Access the application**:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

### Local Development without Docker

**Backend**:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend**:
```bash
cd frontend
npm install
npm run dev
```

## Project Structure

```
family-expense-tracker/
├── backend/                 # FastAPI backend
│   ├── app/
│   │   ├── auth/           # Google OAuth + Cloudflare Access JWT
│   │   ├── models/         # Pydantic models
│   │   ├── routers/        # /api/v1/* endpoints (auth, expenses,
│   │   │                   #   budgets, investments, chat, families,
│   │   │                   #   notifications)
│   │   ├── services/       # snaptrade_service, market_data (FRED/
│   │   │                   #   Tiingo/Finnhub/EDGAR), expense_service,
│   │   │                   #   budget_service
│   │   ├── mcp_server.py   # 25-tool hosted MCP (mounted at /mcp)
│   │   └── main.py         # FastAPI application
│   ├── scripts/            # CLI: snaptrade_connect, snaptrade_sync,
│   │                       #   snaptrade_analyze, snaptrade_mcp (local)
│   └── tests/
├── frontend/               # React + Vite web app (ui.expense-tracker.*)
│   └── src/
│       ├── pages/          # Dashboard, Expenses, Budgets,
│       │                   #   Investments, Chat
│       ├── components/     # QuickAddStrip etc.
│       ├── services/api.ts # axios with JWT interceptor
│       ├── store/          # Zustand auth store
│       └── types/
├── mobile/                 # Expo SDK 53 + React Native iOS app
│   ├── app/                # expo-router screens (tabs: Home, Expenses,
│   │                       #   Budgets, Stocks, Chat, Settings)
│   ├── src/
│   │   ├── hooks/useAuth.ts # native Google sign-in
│   │   ├── services/api.ts  # shared API client + react-native-sse chat
│   │   └── store/auth.ts    # 3-tier session restore
│   ├── plugins/            # Expo config plugins
│   └── patches/            # patch-package patches (NativeWind fmt fix)
├── terraform/              # IaC
│   ├── main/              # Cloud Run, Firestore, Secret Manager,
│   │                       #   Cloudflare DNS, observability
│   └── workspaces/        # Per-env tfvars
├── docs/
│   └── HOSTED_MCP_DEPLOY.md  # Runbook for the MCP subdomain + secrets
└── .github/workflows/      # CI/CD
```

## Mobile dev workflow

Three speeds, by what changed:

| Change | Command | Time |
|---|---|---|
| **JS/TSX/CSS only** (most fixes — UI, validation, copy) | `make mobile-update MSG="what changed"` | ~10 seconds (OTA) |
| **Native config** (Podfile, Info.plist, app.json icons/name, new native module) | `make mobile-prebuild-ios && cd mobile && npx expo run:ios --device "<Name>" --configuration Release` | ~5 minutes |
| **Local iteration during dev** | `make mobile-dev` (Metro) + iOS Simulator | Hot reload, no install |

The OTA pipeline points at https://u.expo.dev/<project-id> (configured in `mobile/app.json`). Phones poll on app launch and pick up the latest preview-branch update.

### First-time iPhone install

1. Plug in via USB, unlock, "Trust This Computer"
2. **Enable Developer Mode**: iPhone Settings → Privacy & Security → bottom → Developer Mode → toggle on → restart
3. Open Xcode at least once, sign in with your Apple ID (Personal Team, free)
4. From repo root:
   ```bash
   cd mobile
   npx expo run:ios --device "Your iPhone Name" --configuration Release
   ```
5. After install: iPhone Settings → General → VPN & Device Management → Trust your Apple ID developer cert
6. App appears on home screen as "Expenses"

### Avoiding the weekly cable refresh

Apple's free dev cert expires every 7 days. Options ranked best-to-worst:

- **AltStore** (https://altstore.io) — Mac menu-bar app re-signs over wifi automatically
- **SideStore** (https://sidestore.io) — newer fork, doesn't need Mac always-on
- **Feather** (https://getfeather.com) — modern UI, no Mac needed
- **Sideloadly** — manual weekly re-install via USB (simpler but tedious)
- **$99/year Apple Developer Program** — official path, 1-year cert + TestFlight

For 2-3 family devices, AltStore or SideStore are the best free path.

### Sideloading via the AltStore source

The app is published as a self-hosted [AltStore](https://altstore.io) source — no App Store, no $99/yr Apple Developer Program required. AltStore Classic re-signs the app over wifi every 7 days using a free Apple ID.

**Source URL** (paste this into AltStore → Browse → Sources → **+**):

```
https://apps.blueelephants.org/altstore.json
```

The canonical JSON is served from a shared GCS bucket (`gs://blueelephants-altstore/altstore.json`) and fronted by `apps.blueelephants.org`. A mirror also lives at `frontend/public/altstore.json` (served by Firebase Hosting alongside the web app) for back-compat. Open the URL in a browser to verify it's reachable before pasting into AltStore.

**One-time setup (per phone):**

1. Install **AltServer** on a Mac that stays on the same wifi as the phone: https://altstore.io
2. Install **AltStore Classic** on the iPhone via AltServer (cable required for this step only)
3. In Finder, pair the iPhone and enable "Show this iPhone when on Wi-Fi" — required for AltServer to reach the device
4. Open AltStore on the phone → **Browse** tab → **Sources** → **+** → paste the source URL above
5. Tap the **Expenses** app in the source and hit **Free** to install

**Self-hosted anisette server (for AltStore Classic 2.3+ / SideStore):**

AltStore 2.3+ and SideStore need an "anisette server" to talk to Apple's signing service without bundling AltServer. We host one on GCP Cloud Run (free tier, scale-to-zero):

```
https://anisette.blueelephants.org
```

Paste that into AltStore Settings → **Anisette Servers** → **+**, or SideStore's equivalent. It runs `dadoum/anisette-v3-server` and stores no secrets — see `terraform/main/anisette.tf`. The raw Cloud Run URL (`https://anisette-server-ix5fldbdya-uc.a.run.app`) also works as a fallback. If you'd rather use a public community server, https://ani.sidestore.io is the standard alternative.

**Pushing updates:**

- **JS-only change** (most UI/logic fixes): `make mobile-update MSG="..."` → phone picks it up on next app launch via EAS Update (~10s, no re-sign)
- **Native change** (icons, Info.plist, new module): tag-triggered. Run `git tag mobile-v<x.y.z> && git push origin mobile-v<x.y.z>` — `.github/workflows/release-ipa.yml` builds the `.ipa` on a macOS runner, creates a GitHub Release, updates the GCS source, and mirrors `frontend/public/altstore.json`. Phones see the new version in AltStore and tap **UPDATE**
- **Manual local build**: `make mobile-publish-ipa VERSION=x.y.z` (requires Mac with Xcode + Apple ID signed in)

The canonical AltStore source JSON lives in GCS (`gs://blueelephants-altstore/altstore.json`) served via `apps.blueelephants.org`; `frontend/public/altstore.json` is a back-compat mirror. The branded icon (`blue-elephants-icon.png`) renders in the AltStore source listing.

### Local mobile testing

```bash
# Backend running locally on the same wifi as the simulator
cd backend && .venv/bin/uvicorn app.main:app --port 8000 --host 0.0.0.0 --reload

# In mobile/.env: EXPO_PUBLIC_API_BASE_URL=http://<your-lan-ip>:8000
# Then:
cd mobile && npx expo start  # press 'i' for simulator, scan QR for Expo Go
```

For production-style testing, leave `EXPO_PUBLIC_API_BASE_URL` pointed at https://api.expense-tracker.blueelephants.org — the app works on cellular without your Mac.

## Deployment

### Initial Setup

1. **Create Google Cloud resources**:
   ```bash
   make setup
   ```

2. **Configure Terraform**:
   ```bash
   cp terraform/workspaces/dev/terraform.tfvars.example terraform/workspaces/dev/terraform.tfvars
   # Edit terraform.tfvars with your values
   ```

3. **Apply infrastructure**:
   ```bash
   make terraform-apply
   ```

### Deploy Application

CI handles deploys on push to `main`. Manual triggers if you need them:

```bash
# Backend → Cloud Run (terraform apply + docker build + push)
make deploy-backend

# Frontend → Firebase Hosting (npm run build + firebase deploy --only hosting)
make deploy-frontend

# Both
make deploy
```

The frontend used to serve from a Cloud Storage bucket behind a GCP HTTPS Load Balancer (~$20/month idle cost for the forwarding rule + static IP). It now serves from Firebase Hosting on the free tier — same custom domain (`ui.expense-tracker.blueelephants.org`), TLS issued by Firebase, no LB. The migration is documented in [`docs/FIREBASE_HOSTING_MIGRATION.md`](docs/FIREBASE_HOSTING_MIGRATION.md) (or see the terraform `firebase_hosting.tf` file directly).

## API Endpoints

### Authentication
- `POST /auth/google` - Exchange Google token for JWT
- `GET /auth/me` - Get current user info

### Families
- `POST /families` - Create new family
- `GET /families/{id}` - Get family details
- `POST /families/{id}/join` - Join family with invite code
- `DELETE /families/{id}/leave` - Leave family

### Expenses
- `GET /expenses` - List expenses (with filters)
- `POST /expenses` - Create expense
- `GET /expenses/{id}` - Get expense
- `PUT /expenses/{id}` - Update expense
- `DELETE /expenses/{id}` - Delete expense
- `GET /expenses/summary` - Get expense analytics

### Budgets
- `GET /budgets` - List budgets
- `POST /budgets` - Create budget
- `GET /budgets/{id}` - Get budget
- `PUT /budgets/{id}` - Update budget
- `DELETE /budgets/{id}` - Delete budget
- `GET /budgets/{id}/status` - Get budget status

### Notifications
- `GET /notifications` - List notifications
- `PUT /notifications/{id}/read` - Mark as read
- `PUT /notifications/read-all` - Mark all as read

### Chat (durable conversations)
- `POST /chat/start` — start (or continue) a chat. Body: `{conversation_id?, message, family_id?}`. Returns `{conversation_id, user_turn_id, assistant_turn_id}` immediately. Generation runs as a background asyncio task that writes events into Firestore as it goes
- `GET /chat/conversations/{conv}/turns/{turn}/stream?from_seq=N` — resumable SSE for an in-flight or completed assistant turn. Pass the highest `seq` you've already rendered as `from_seq` on reconnect so the server only re-emits events you missed
- `GET /chat/conversations` — list recent conversations for the calling user (history UI)
- `GET /chat/conversations/{conv}` — full transcript (all turns, all tool calls)
- `DELETE /chat/conversations/{conv}` — delete a conversation and its turns
- `POST /chat` — backwards-compat shim for old mobile bundles that still POST the old `{messages: [...]}` shape. Internally creates the same Firestore conv + turn docs and streams SSE in the old event format. Safe to leave permanently or remove once all clients have OTA'd

## Testing

```bash
# Backend tests
cd backend
pytest tests/ -v

# Frontend build (includes type checking)
cd frontend
npm run build
```

## Environment Variables

See `.env.example` files in `backend/`, `frontend/`, and `mobile/`.

Quick summary of where each secret lives in production:

| Variable | Local dev | Production |
|---|---|---|
| `GCP_PROJECT_ID`, `FIRESTORE_DATABASE`, `ENVIRONMENT`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID`, `CF_ACCESS_TEAM_DOMAIN`, `LANGFUSE_BASE_URL` | `backend/.env` (plain) | Cloud Run env var (plain) |
| `JWT_SECRET_KEY`, `GOOGLE_CLIENT_SECRET`, `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `ANTHROPIC_API_KEY`, `CF_ACCESS_AUD`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `FRED_API_KEY`, `TIINGO_API_KEY`, `FINNHUB_API_KEY` | `backend/.env` (gitignored) | Google Secret Manager → injected into Cloud Run via `secret_key_ref` (Terraform-managed) |
| `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` | `mobile/.env` | Baked into the JS bundle at build time (via `EXPO_PUBLIC_*` env at build) |

## Hosted MCP

The MCP server is mounted at `/mcp` on the backend and exposed publicly at https://mcp.expense-tracker.blueelephants.org/, gated by Cloudflare Access with Google SSO. Adding it to Claude Desktop / claude.ai / ChatGPT lets you query the same portfolio + expense + bank data from a chat surface that bills against your existing Claude or ChatGPT subscription instead of our backend's Anthropic API key.

**Endpoint**: `https://mcp.expense-tracker.blueelephants.org/mcp/`

### Claude Desktop (Mac / Windows)

1. Settings → **Developer** → **Edit Config**
2. Add (or merge into) the JSON:
   ```json
   {
     "mcpServers": {
       "family-portfolio": {
         "url": "https://mcp.expense-tracker.blueelephants.org/mcp/"
       }
     }
   }
   ```
3. Restart Claude Desktop. First tool call opens a browser for Google SSO via Cloudflare Access — sign in with the same email used for the web app.

### Claude Code (CLI)

```bash
claude mcp add family-portfolio --url "https://mcp.expense-tracker.blueelephants.org/mcp/"
```

### claude.ai (web, including mobile Safari)

Requires Pro / Max / Team plan.

1. Settings → **Connectors** → **+ Add custom connector**
2. URL: `https://mcp.expense-tracker.blueelephants.org/mcp/`
3. First tool call pops the Google SSO sheet — sign in once, Cloudflare caches the session.

> **Note**: the official Claude mobile app does NOT yet expose a Custom Connectors UI. Use claude.ai in mobile Safari instead. "Add to Home Screen" makes it look like an app.

### ChatGPT (Plus / Pro / Team / Business)

ChatGPT added MCP connector support in late 2025.

1. Settings → **Beta Features** → enable Developer mode (if needed)
2. Settings → **Connectors** → **+ Add custom MCP server**
3. URL: `https://mcp.expense-tracker.blueelephants.org/mcp/`

**Caveat**: the Cloudflare Access Google-SSO popup can be unreliable from inside ChatGPT's connector sandbox. If it fails, two options:

- **Quick**: set `ALLOW_MCP_BEARER_FALLBACK=true` on the Cloud Run env and issue yourself a long-lived backend JWT. ChatGPT sends `Authorization: Bearer <token>`. Lower security — rotate the token.
- **Cleaner**: mount a parallel `/mcp-token` route with a static `X-API-Key` header (not yet implemented — open a follow-up).

### What the model can call

Same tool surface as the in-app `/chat`: 25+ tools across SnapTrade portfolio (`list_accounts`, `get_holdings`, `get_cost_basis`, `portfolio_summary`, ...), FRED macro (`macro_indicator`), Tiingo prices, Finnhub news + analyst, EDGAR filings, Manifold / Polymarket / Kalshi prediction markets, Tradier options chain + Greeks, Alpaca quotes/bars, Plaid bank data, your own expenses + budgets.

### Trade-offs vs the in-app `/chat`

| | In-app `/chat` | Claude/ChatGPT + MCP |
|---|---|---|
| Token cost | Charged to the backend's Anthropic API key | Charged to your Claude/ChatGPT subscription quota |
| Model | Sonnet 4.6 default, Opus 4.7 on "deep analysis" keywords | Whatever your subscription gives you (Opus on Pro/Max) |
| Cache hit | Yes (5-min TTL, ~80% savings) | Provider-managed |
| Mobile | Native app + web | claude.ai in mobile Safari (no Custom Connectors in Claude mobile app yet) |
| Auth | App JWT | Cloudflare Access Google SSO |

### Runbooks

Cloudflare Access app, IdP, policy, DNS, Cloud Run domain mapping, Secret Manager population — see [`docs/HOSTED_MCP_DEPLOY.md`](docs/HOSTED_MCP_DEPLOY.md).

Adding a family member's email to the Access allowlist: `docs/HOSTED_MCP_DEPLOY.md` → "Adding more family members".

## Observability

| Layer | Tool | Where |
|---|---|---|
| Infrastructure (uptime, 5xx, latency, container CPU/RAM) | GCP Cloud Monitoring | Auto-collected for Cloud Run; alert policies in `terraform/main/observability.tf` |
| Logs (per-request, MCP tool calls) | GCP Cloud Logging | Structured logs from FastAPI; log-based metric `mcp_tool_calls` captures `user_id` + `tool` |
| LLM tracing (chat conversations, tool calls, token usage) | Langfuse | https://us.cloud.langfuse.com — parent span per chat + child `generation` per LLM turn (model, in/out/cache tokens) + child `span` per tool call (latency, preview). Filter by `user_id`, `session_id`, `conv_id` in metadata |
| Auth events (CF Access logins) | Cloudflare Zero Trust dashboard | Free; see https://one.dash.cloudflare.com → Logs → Access |

## Runtime costs (idle, no traffic)

For a single-family deployment with low actual usage, the steady-state bill is approximately:

| Component | Why it costs (or doesn't) | Approx $/month |
|---|---|---|
| Cloud Run backend (`min_instances=1`, no CPU throttling) | Required so background chat-generation tasks survive after the POST /chat/start response returns. Without it, the asyncio task gets killed when the container scales to zero | ~$7 |
| Firestore | Free tier covers all read/write at this volume | $0 |
| Secret Manager | Free up to 10K access ops/month | $0 |
| Artifact Registry (Docker images) | ~3 GB stored | <$1 |
| Firebase Hosting (frontend) | Free tier: 10 GB storage + 360 MB/day egress | $0 |
| Cloudflare DNS + Access | Free tier (up to 50 users on Zero Trust) | $0 |
| Langfuse Cloud | Free tier | $0 |
| Anthropic, SnapTrade, FRED, Tiingo, Finnhub | Pay-per-use; chat is ~$0.01–$0.05 per turn on Sonnet | usage |
| **Total idle** | | **~$7-10/month** |

The previous setup served the frontend from a Cloud Storage bucket behind a GCP HTTPS Load Balancer — ~$20/month just for the forwarding rule + static IP, regardless of traffic. The Firebase Hosting migration replaced that stack at $0 idle.

If you don't need disconnect-survival for chats (e.g. all users on a desktop browser), you can flip Cloud Run back to `min_instances=0` + `cpu_throttling=true` in `terraform/main/main.tf` and drop the ~$7 too. The trade-off is that mobile chats which background mid-stream may not complete.

## License

MIT
