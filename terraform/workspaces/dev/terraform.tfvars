# Project ID (REQUIRED - Set this to your GCP project ID)
project_id = "personal-projects-473219"
environment = "dev"
# Region (must support Cloud Run domain mappings)
region = "us-central1"

# Frontend bucket name (must be globally unique)
frontend_bucket_name = "family-expenses-frontend-bucket-dev"
firebase_storage_bucket = "family-expenses-firebase-bucket-dev"

# Container image (will be set by CI/CD)
container_image = "us-central1-docker.pkg.dev/personal-projects-473219/family-expenses-backend/family-expenses-backend:latest"

# Domain configuration
root_domain      = "blueelephants.org"

# Google OAuth
google_client_id = "610355955735-0uv0l16rbkr6bd345c34ck690s892kn6.apps.googleusercontent.com"