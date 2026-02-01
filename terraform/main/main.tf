resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "dns" {
  service            = "dns.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iam" {
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

# Artifact Registry repository for backend Docker images
resource "google_artifact_registry_repository" "backend" {
  location      = var.region
  repository_id = "expense-tracker-backend"
  description   = "Expense Tracker backend Docker images"
  format        = "DOCKER"

  depends_on = [google_project_service.artifactregistry]
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firebase" {
  service            = "firebase.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firebaserules" {
  service            = "firebaserules.googleapis.com"
  disable_on_destroy = false
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  root_domain_fqdn     = trim(var.root_domain, ".")
  frontend_domain_fqdn = "ui.expense-tracker.${trim(var.root_domain, ".")}"
  backend_domain_fqdn  = "api.expense-tracker.${trim(var.root_domain, ".")}"
  dns_zone_name        = "${replace(trim(var.root_domain, "."), ".", "-")}-zone"
  backend_image_path   = "us-central1-docker.pkg.dev/${var.project_id}/expense-tracker-backend/expense-tracker-backend:latest"
}

# Firestore Database
# FREE TIER: 1 GB storage, 50K reads/day, 20K writes/day, 20K deletes/day
resource "google_firestore_database" "database" {
  project     = var.project_id
  name        = "family-expense-tracker-${var.environment}"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]
}

# Service account for Cloud Run
resource "google_service_account" "backend_sa" {
  account_id   = "expense-tracker-${var.environment}"
  display_name = "Expense Tracker Backend Service Account"
}

# Allow the backend service account to read project secrets
resource "google_project_iam_member" "backend_secret_access" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.backend_sa.email}"

  depends_on = [google_project_service.secretmanager]
}

# Grant Firestore access to service account
resource "google_project_iam_member" "backend_firestore_access" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.backend_sa.email}"
}

# Grant Artifact Registry reader access to service account
resource "google_project_iam_member" "backend_artifact_registry_access" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.backend_sa.email}"

  depends_on = [google_project_service.artifactregistry]
}

# Generate a random JWT secret key
resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

# Secret for JWT signing key
resource "google_secret_manager_secret" "jwt_secret" {
  secret_id = "${var.backend_service_name}-jwt-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "jwt_secret" {
  secret      = google_secret_manager_secret.jwt_secret.id
  secret_data = random_password.jwt_secret.result
}

# Cloud Run service for backend
resource "google_cloud_run_service" "backend" {
  name     = var.backend_service_name
  location = var.region

  template {
    spec {
      service_account_name = google_service_account.backend_sa.email
      
      containers {
        image = local.backend_image_path

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }

        env {
          name  = "FIRESTORE_DATABASE"
          value = google_firestore_database.database.name
        }

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GOOGLE_CLIENT_ID"
          value = var.google_client_id
        }

        env {
          name  = "FRONTEND_URL"
          value = "https://${local.frontend_domain_fqdn}"
        }

        env {
          name = "JWT_SECRET_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.jwt_secret.secret_id
              key  = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1000m"
            memory = "512Mi"
          }
        }

        ports {
          container_port = 8000
        }
      }

      # FREE TIER: 2M requests/month
      container_concurrency = 80
    }

    metadata {
      annotations = {
        # Scale to zero when not in use - CRITICAL for staying in free tier
        "autoscaling.knative.dev/minScale" = "0"
        "autoscaling.knative.dev/maxScale" = "10"
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  depends_on = [
    google_project_service.run,
    google_secret_manager_secret_version.jwt_secret
  ]
}

# Make backend publicly accessible
resource "google_cloud_run_service_iam_member" "backend_public" {
  service  = google_cloud_run_service.backend.name
  location = google_cloud_run_service.backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Storage bucket for frontend
resource "google_storage_bucket" "frontend" {
  name          = var.frontend_bucket_name
  location      = var.region
  force_destroy = true
  
  storage_class = "STANDARD"

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }

  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  uniform_bucket_level_access = true

  depends_on = [google_project_service.storage]
}

# Allow HTTPS Load Balancer service account to read frontend objects
resource "google_storage_bucket_iam_member" "frontend_lb_access" {
  bucket = google_storage_bucket.frontend.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"

  depends_on = [google_project_service.compute]
}

# HTTPS Load Balancer serving the static frontend from GCS
resource "google_compute_backend_bucket" "frontend" {
  name        = "${var.backend_service_name}-frontend"
  bucket_name = google_storage_bucket.frontend.name
  enable_cdn  = true

  depends_on = [
    google_project_service.compute,
    google_storage_bucket_iam_member.frontend_lb_access
  ]
}

resource "google_compute_url_map" "frontend" {
  name            = "${var.backend_service_name}-frontend"
  default_service = google_compute_backend_bucket.frontend.id
}

resource "google_compute_managed_ssl_certificate" "frontend" {
  name = "${var.backend_service_name}-frontend-cert"

  managed {
    domains = [local.frontend_domain_fqdn]
  }
}

resource "google_compute_target_https_proxy" "frontend" {
  name             = "${var.backend_service_name}-frontend"
  url_map          = google_compute_url_map.frontend.id
  ssl_certificates = [google_compute_managed_ssl_certificate.frontend.id]
}

resource "google_compute_global_address" "frontend" {
  name = "${var.backend_service_name}-frontend"
}

resource "google_compute_global_forwarding_rule" "frontend" {
  name                  = "${var.backend_service_name}-frontend"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.frontend.id
  load_balancing_scheme = "EXTERNAL"
  ip_address            = google_compute_global_address.frontend.address
}

# Cloud Run domain mapping for backend API
resource "google_cloud_run_domain_mapping" "backend" {
  name     = local.backend_domain_fqdn
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_service.backend.name
  }

  depends_on = [google_project_service.run]
}

# Cloudflare DNS records
resource "cloudflare_record" "frontend_a" {
  zone_id = var.cloudflare_zone_id
  name    = "ui.expense-tracker"
  type    = "A"
  content = google_compute_global_address.frontend.address
  proxied = false
  ttl     = 300

  depends_on = [google_compute_global_forwarding_rule.frontend]
}

resource "cloudflare_record" "backend_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "api.expense-tracker"
  type    = "CNAME"
  content = "ghs.googlehosted.com"
  proxied = false
  ttl     = 300

  depends_on = [google_cloud_run_domain_mapping.backend]
}
