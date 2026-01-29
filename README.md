# Family Expense Tracker

A family expense tracking application that allows family members to track daily spending, tag expenses by category and beneficiary, and manage budgets with alerts.

## Features

- **Expense Tracking**: Log expenses with amount, date, description, merchant, and payment method
- **Categories**: Groceries, Dining, Transportation, Utilities, Entertainment
- **Family Sharing**: Create a family workspace and invite members to share expenses
- **"Who is it for"**: Tag expenses for individual family members or the entire family
- **Budget Management**: Set budgets by category, time period (weekly/monthly), and person
- **Budget Alerts**: In-app notifications when approaching or exceeding budget limits
- **Dashboard**: Visual summary of spending with charts and analytics
- **Google Sign-In**: Secure authentication with Google OAuth

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, TailwindCSS
- **Backend**: Python 3.11, FastAPI
- **Database**: Google Cloud Firestore
- **Infrastructure**: GCP Cloud Run, Cloud Storage, Terraform
- **Authentication**: Google OAuth 2.0
- **CI/CD**: GitHub Actions

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local frontend development)
- Python 3.11+ (for local backend development)
- Google Cloud SDK (for deployment)
- A GCP project with billing enabled

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
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/610355955735/locations/global/workloadIdentityPools/github-actions-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT` | `tf-github@personal-projects-473219.iam.gserviceaccount.com` |
| `GOOGLE_CLIENT_ID` |  |

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
│   │   ├── auth/           # Google OAuth authentication
│   │   ├── models/         # Pydantic models
│   │   ├── routers/        # API endpoints
│   │   ├── services/       # Business logic
│   │   └── main.py         # FastAPI application
│   └── tests/              # Backend tests
├── frontend/               # React frontend
│   └── src/
│       ├── components/     # Reusable UI components
│       ├── pages/          # Page components
│       ├── services/       # API client
│       ├── store/          # State management (Zustand)
│       └── types/          # TypeScript types
├── terraform/              # Infrastructure as Code
│   ├── main/              # Main Terraform configuration
│   └── workspaces/        # Environment-specific variables
└── .github/workflows/     # CI/CD pipelines
```

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

```bash
# Deploy backend to Cloud Run
make deploy-backend

# Deploy frontend to Cloud Storage
make deploy-frontend

# Deploy both
make deploy
```

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

See `.env.example` files in `backend/` and `frontend/` directories.

## License

MIT
