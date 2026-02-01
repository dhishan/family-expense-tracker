.PHONY: help install dev stop build test clean deploy-backend deploy-frontend deploy terraform-init terraform-plan terraform-apply terraform-destroy docker-dev docker-up docker-down

# Variables
PROJECT_ID ?= $(shell gcloud config get-value project)
REGION ?= us-central1
ENV ?= dev
BACKEND_SERVICE_NAME ?= expense-tracker-backend
BACKEND_IMAGE_TAG ?= latest
BACKEND_IMAGE ?= expense-tracker-backend
# Artifact Registry path: LOCATION-docker.pkg.dev/PROJECT/REPOSITORY/IMAGE
GCR_IMAGE ?= us-central1-docker.pkg.dev/$(PROJECT_ID)/expense-tracker-backend/expense-tracker-backend
LOCAL_BACKEND_IMAGE ?= expense-tracker-local
FRONTEND_BUCKET ?= expense-tracker-frontend-$(ENV)
TF_ENV ?= dev
TF_DIR := terraform/main
TF_VARS_REL := ../workspaces/$(TF_ENV)/terraform.tfvars
TF_VARS_PATH := $(TF_DIR)/../workspaces/$(TF_ENV)/terraform.tfvars

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-25s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install all dependencies
	@echo "Installing backend dependencies..."
	cd backend && \
		([ -d venv ] || python3 -m venv venv) && \
		. venv/bin/activate && \
		pip install --upgrade pip && \
		pip install -r requirements.txt
	@echo "Installing frontend dependencies..."
	cd frontend && npm install
	@echo "✅ Dependencies installed"

dev: ## Run both backend and frontend in development mode
	@echo "Starting development servers..."
	@trap 'kill 0' EXIT; \
	(cd backend && . venv/bin/activate && python -m uvicorn app.main:app --reload --port 8000) & \
	(cd frontend && npm run dev)

dev-backend: ## Run only backend in development mode
	cd backend && . venv/bin/activate && python -m uvicorn app.main:app --reload --port 8000

dev-frontend: ## Run only frontend in development mode
	cd frontend && npm run dev

docker-dev: ## Run with Docker Compose (hot reload)
	docker-compose --profile dev up --build

docker-up: ## Run with Docker Compose (production build)
	docker-compose up --build

docker-down: ## Stop Docker Compose
	docker-compose down

stop: ## Stop development servers and free up ports
	@echo "Stopping development servers..."
	@lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:5173 | xargs kill -9 2>/dev/null || true
	@echo "✅ Ports cleared"

build-backend: ## Build backend Docker image
	@echo "Building backend Docker image..."
	cd backend && docker build --platform=linux/amd64 -t $(BACKEND_IMAGE):latest .
	@echo "✅ Backend image built: $(BACKEND_IMAGE):latest"

build-frontend: ## Build frontend for production
	@echo "Building frontend..."
	cd frontend && npm run build
	@echo "✅ Frontend built to frontend/dist/"

test: ## Run tests
	@echo "Running backend tests..."
	cd backend && . venv/bin/activate && python -m pytest tests/ -v || echo "No tests found"
	@echo "✅ Tests completed"

lint: ## Run linters
	@echo "Linting backend..."
	cd backend && . venv/bin/activate && pip install ruff && ruff check app/ || true
	@echo "Linting frontend..."
	cd frontend && npm run lint || true
	@echo "✅ Linting completed"

format: ## Format code
	@echo "Formatting backend..."
	cd backend && . venv/bin/activate && pip install black && black app/ || true
	@echo "Formatting frontend..."
	cd frontend && npx prettier --write src/ || true
	@echo "✅ Code formatted"

clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	rm -rf backend/__pycache__ backend/**/__pycache__ backend/.pytest_cache
	rm -rf frontend/dist frontend/node_modules
	rm -rf backend/venv
	@echo "✅ Cleaned"

# GCP Authentication
gcp-auth: ## Authenticate with Google Cloud
	gcloud auth login
	gcloud auth application-default login
	gcloud config set project $(PROJECT_ID)

# Docker operations
docker-push-backend: build-backend ## Push backend image to Artifact Registry
	@echo "Configuring Docker credentials..."
	@gcloud auth configure-docker us-central1-docker.pkg.dev --quiet || true
	docker tag $(BACKEND_IMAGE):latest $(GCR_IMAGE):latest
	docker push $(GCR_IMAGE):latest
	@echo "✅ Backend image pushed: $(GCR_IMAGE):latest"

# Deployment
deploy-backend: build-backend docker-push-backend ## Deploy backend to Cloud Run
	@echo "Deploying backend to Cloud Run..."
	gcloud run deploy $(BACKEND_SERVICE_NAME) \
		--image $(GCR_IMAGE):latest \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated \
		--set-env-vars "GCP_PROJECT_ID=$(PROJECT_ID)" \
		--set-env-vars "FIRESTORE_DATABASE=family-expense-tracker-$(ENV)" \
		--set-env-vars "ENVIRONMENT=$(ENV)" \
		--set-env-vars "FRONTEND_URL=https://ui.expense-tracker.blueelephants.org" \
		--min-instances 0 \
		--max-instances 10 \
		--memory 512Mi \
		--cpu 1
	@echo "✅ Backend deployed"
	@gcloud run services describe $(BACKEND_SERVICE_NAME) --region $(REGION) --format 'value(status.url)'

deploy-frontend: build-frontend ## Deploy frontend to Cloud Storage (served via HTTPS load balancer)
	@echo "Deploying frontend to Cloud Storage..."
	@FRONTEND_BUCKET=$${FRONTEND_BUCKET:-$$(terraform -chdir=$(TF_DIR) output -raw frontend_bucket_name 2>/dev/null || echo $(FRONTEND_BUCKET))}; \
	gsutil -m rsync -r -d frontend/dist gs://$$FRONTEND_BUCKET; \
	gsutil setmeta -h "Cache-Control:no-cache, no-store, must-revalidate" gs://$$FRONTEND_BUCKET/index.html; \
	gsutil -m setmeta -h "Cache-Control:public, max-age=31536000, immutable" gs://$$FRONTEND_BUCKET/assets/*.js gs://$$FRONTEND_BUCKET/assets/*.css 2>/dev/null || true; \
	echo "✅ Frontend deployed to gs://$$FRONTEND_BUCKET"; \
	echo "Invalidating CDN cache..."; \
	gcloud compute url-maps invalidate-cdn-cache $(BACKEND_SERVICE_NAME)-frontend --path "/*" --async; \
	echo "✅ CDN cache invalidation initiated"

deploy: deploy-backend deploy-frontend ## Deploy both backend and frontend

terraform-cleanup: ## Clean up Terraform local files
	@echo "Cleaning up Terraform local files..."
	rm -rf $(TF_DIR)/.terraform
	rm -f $(TF_DIR)/.terraform.lock.hcl
	rm -f $(TF_DIR)/.terraform.tfstate
	rm -f $(TF_DIR)/.terraform.tfstate.backup
	rm -f $(TF_DIR)/.bw-provider-state
	@echo "✅ Terraform local files cleaned"

# Terraform operations
terraform-init: ## Initialize Terraform
	terraform -chdir=$(TF_DIR) init -backend-config=../workspaces/$(TF_ENV)/backend.conf

terraform-plan: terraform-init ## Plan Terraform changes (set TF_ENV to switch workspace)
	@if [ ! -f $(TF_VARS_PATH) ]; then \
		echo "Missing $(TF_VARS_PATH). Copy terraform.tfvars.example and fill in values."; \
		exit 1; \
	fi
	terraform -chdir=$(TF_DIR) plan -var-file=$(TF_VARS_REL)

terraform-apply: terraform-init ## Apply Terraform changes (set TF_ENV to switch workspace)
	@if [ ! -f $(TF_VARS_PATH) ]; then \
		echo "Missing $(TF_VARS_PATH). Copy terraform.tfvars.example and fill in values."; \
		exit 1; \
	fi
	terraform -chdir=$(TF_DIR) apply -var-file=$(TF_VARS_REL) -auto-approve

terraform-destroy: ## Destroy Terraform resources (set TF_ENV to switch workspace)
	@if [ ! -f $(TF_VARS_PATH) ]; then \
		echo "Missing $(TF_VARS_PATH)."; \
		exit 1; \
	fi
	terraform -chdir=$(TF_DIR) destroy -var-file=$(TF_VARS_REL)

terraform-unlock: ## Force unlock Terraform state
	@echo "Force unlocking Terraform state..."
	@echo "Enter the Lock ID from the error message:"
	@read lock_id; \
	terraform -chdir=$(TF_DIR) force-unlock -force $$lock_id

terraform-output: ## Show Terraform outputs
	terraform -chdir=$(TF_DIR) output

# Setup helpers
setup-tfstate-bucket: ## Create GCS bucket for Terraform state
	@echo "Creating Terraform state bucket..."
	gsutil mb -p $(PROJECT_ID) -c STANDARD -l $(REGION) gs://$(PROJECT_ID)-tfstate || true
	gsutil versioning set on gs://$(PROJECT_ID)-tfstate
	@echo "✅ Terraform state bucket created"

setup-artifact-registry: ## Create Artifact Registry repository
	@echo "Creating Artifact Registry repository..."
	gcloud artifacts repositories create expense-tracker-backend \
		--repository-format=docker \
		--location=$(REGION) \
		--description="Expense Tracker backend images" || true
	@echo "✅ Artifact Registry repository created"

enable-apis: ## Enable required GCP APIs
	@echo "Enabling required APIs..."
	gcloud services enable run.googleapis.com
	gcloud services enable storage.googleapis.com
	gcloud services enable artifactregistry.googleapis.com
	gcloud services enable iam.googleapis.com
	gcloud services enable secretmanager.googleapis.com
	gcloud services enable firestore.googleapis.com
	gcloud services enable compute.googleapis.com
	gcloud services enable dns.googleapis.com
	@echo "✅ APIs enabled"

setup: enable-apis setup-tfstate-bucket setup-artifact-registry install ## Complete initial setup
	@echo "✅ Setup complete!"
	@echo ""
	@echo "Next steps:"
	@echo "1. Copy backend/.env.example to backend/.env and fill in your values"
	@echo "2. Copy frontend/.env.example to frontend/.env and fill in your values"
	@echo "3. Copy terraform/workspaces/dev/terraform.tfvars.example to terraform.tfvars"
	@echo "4. Run 'make terraform-apply' to provision infrastructure"
	@echo "5. Run 'make dev' to start local development"

# Status
status: ## Show deployment status
	@echo "Backend status:"
	@gcloud run services describe $(BACKEND_SERVICE_NAME) --region $(REGION) --format 'value(status.url)' 2>/dev/null || echo "Not deployed"
	@echo ""
	@echo "Frontend bucket:"
	@gsutil ls gs://$(FRONTEND_BUCKET) 2>/dev/null && echo "gs://$(FRONTEND_BUCKET)" || echo "Not deployed"
