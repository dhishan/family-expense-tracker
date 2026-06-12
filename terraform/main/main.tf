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
  mcp_domain_fqdn      = "mcp.expense-tracker.${trim(var.root_domain, ".")}"
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

  # Backup posture — added after task #27 introduced explicit budget_id
  # pinning on expenses (lost data would mean lost financial records).
  # PITR keeps 7 days of point-in-time recovery; ~10% storage cost
  # overhead, negligible at this volume.
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"

  # Prevent accidental terraform-driven deletion of the DB itself.
  # If you ever truly need to drop it, flip this to DELETE_PROTECTION_DISABLED
  # in a separate apply first.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_project_service.firestore]
}

# Daily backup schedule — 35-day retention. Cumulative storage cost
# negligible at our volume (<$1/month) and gives plenty of room to
# discover a mistake before the oldest backup ages out.
resource "google_firestore_backup_schedule" "daily" {
  project   = var.project_id
  database  = google_firestore_database.database.name
  retention = "${35 * 24 * 60 * 60}s" # 35 days expressed in seconds

  daily_recurrence {}
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

# SnapTrade secrets (values populated manually via gcloud - see runbook)
resource "google_secret_manager_secret" "snaptrade_client_id" {
  secret_id = "${var.backend_service_name}-snaptrade-client-id"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "snaptrade_consumer_key" {
  secret_id = "${var.backend_service_name}-snaptrade-consumer-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

# Anthropic API key (values populated manually via gcloud - see runbook)
resource "google_secret_manager_secret" "anthropic_api_key" {
  secret_id = "${var.backend_service_name}-anthropic-api-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

# Cloudflare Access AUD tag (values populated manually via gcloud - see runbook)
resource "google_secret_manager_secret" "cf_access_aud" {
  secret_id = "${var.backend_service_name}-cf-access-aud"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

# Secret for Google OAuth client secret
resource "google_secret_manager_secret" "google_client_secret" {
  secret_id = "${var.backend_service_name}-google-client-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "google_client_secret" {
  secret      = google_secret_manager_secret.google_client_secret.id
  secret_data = var.google_client_secret
}

# --- Secret versions for the previously-manual secrets. Values come from
# --- sensitive TF vars (TF_VAR_* env or terraform.tfvars). Plaintext lands in
# --- terraform.tfstate which is GCS-backed + IAM-locked; never in source.
resource "google_secret_manager_secret_version" "snaptrade_client_id" {
  secret      = google_secret_manager_secret.snaptrade_client_id.id
  secret_data = var.snaptrade_client_id
}

resource "google_secret_manager_secret_version" "snaptrade_consumer_key" {
  secret      = google_secret_manager_secret.snaptrade_consumer_key.id
  secret_data = var.snaptrade_consumer_key
}

resource "google_secret_manager_secret_version" "anthropic_api_key" {
  secret      = google_secret_manager_secret.anthropic_api_key.id
  secret_data = var.anthropic_api_key
}

resource "google_secret_manager_secret_version" "cf_access_aud" {
  secret      = google_secret_manager_secret.cf_access_aud.id
  secret_data = var.cf_access_aud
}

# --- Langfuse (LLM observability) ---
resource "google_secret_manager_secret" "langfuse_secret_key" {
  secret_id = "${var.backend_service_name}-langfuse-secret-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "langfuse_secret_key" {
  secret      = google_secret_manager_secret.langfuse_secret_key.id
  secret_data = var.langfuse_secret_key
}

resource "google_secret_manager_secret" "langfuse_public_key" {
  secret_id = "${var.backend_service_name}-langfuse-public-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "langfuse_public_key" {
  secret      = google_secret_manager_secret.langfuse_public_key.id
  secret_data = var.langfuse_public_key
}

# --- Financial data API keys (Phase F: FRED, Tiingo, Finnhub) ---
resource "google_secret_manager_secret" "fred_api_key" {
  secret_id = "${var.backend_service_name}-fred-api-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "fred_api_key" {
  secret      = google_secret_manager_secret.fred_api_key.id
  secret_data = var.fred_api_key
}

resource "google_secret_manager_secret" "tiingo_api_key" {
  secret_id = "${var.backend_service_name}-tiingo-api-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "tiingo_api_key" {
  secret      = google_secret_manager_secret.tiingo_api_key.id
  secret_data = var.tiingo_api_key
}

resource "google_secret_manager_secret" "finnhub_api_key" {
  secret_id = "${var.backend_service_name}-finnhub-api-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "finnhub_api_key" {
  secret      = google_secret_manager_secret.finnhub_api_key.id
  secret_data = var.finnhub_api_key
}

# --- Plaid (bank account linking + transaction sync) ---
resource "google_secret_manager_secret" "plaid_client_id" {
  secret_id = "${var.backend_service_name}-plaid-client-id"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "plaid_client_id" {
  secret      = google_secret_manager_secret.plaid_client_id.id
  secret_data = coalesce(var.plaid_client_id, "not-configured")
}

resource "google_secret_manager_secret" "plaid_secret" {
  secret_id = "${var.backend_service_name}-plaid-secret"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "plaid_secret" {
  secret      = google_secret_manager_secret.plaid_secret.id
  secret_data = coalesce(var.plaid_secret, "not-configured")
}

resource "google_secret_manager_secret" "plaid_env" {
  secret_id = "${var.backend_service_name}-plaid-env"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "plaid_env" {
  secret      = google_secret_manager_secret.plaid_env.id
  secret_data = var.plaid_env
}

# --- Kalshi (CFTC-regulated prediction market, RSA-PSS signing) ---
resource "google_secret_manager_secret" "kalshi_key_id" {
  secret_id = "${var.backend_service_name}-kalshi-key-id"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "kalshi_key_id" {
  secret      = google_secret_manager_secret.kalshi_key_id.id
  secret_data = coalesce(var.kalshi_key_id, "not-configured")
}

resource "google_secret_manager_secret" "kalshi_private_key_b64" {
  secret_id = "${var.backend_service_name}-kalshi-private-key-b64"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "kalshi_private_key_b64" {
  secret      = google_secret_manager_secret.kalshi_private_key_b64.id
  secret_data = coalesce(var.kalshi_private_key_b64, "not-configured")
}

# --- Alpaca (options data, market quotes, OHLCV bars) ---
resource "google_secret_manager_secret" "apca_api_key_id" {
  secret_id = "${var.backend_service_name}-apca-api-key-id"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "apca_api_key_id" {
  secret      = google_secret_manager_secret.apca_api_key_id.id
  secret_data = coalesce(var.apca_api_key_id, "not-configured")
}

resource "google_secret_manager_secret" "apca_api_secret_key" {
  secret_id = "${var.backend_service_name}-apca-api-secret-key"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "apca_api_secret_key" {
  secret      = google_secret_manager_secret.apca_api_secret_key.id
  secret_data = coalesce(var.apca_api_secret_key, "not-configured")
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

        env {
          name = "GOOGLE_CLIENT_SECRET"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.google_client_secret.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "SNAPTRADE_CLIENT_ID"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.snaptrade_client_id.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "SNAPTRADE_CONSUMER_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.snaptrade_consumer_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "ANTHROPIC_API_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.anthropic_api_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "CF_ACCESS_AUD"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.cf_access_aud.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name  = "CF_ACCESS_TEAM_DOMAIN"
          value = var.cf_access_team_domain
        }

        env {
          name = "LANGFUSE_SECRET_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.langfuse_secret_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "LANGFUSE_PUBLIC_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.langfuse_public_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name  = "LANGFUSE_BASE_URL"
          value = var.langfuse_base_url
        }

        env {
          name = "FRED_API_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.fred_api_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "TIINGO_API_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.tiingo_api_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "FINNHUB_API_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.finnhub_api_key.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "PLAID_CLIENT_ID"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.plaid_client_id.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "PLAID_SECRET"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.plaid_secret.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "PLAID_ENV"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.plaid_env.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "KALSHI_KEY_ID"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.kalshi_key_id.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "KALSHI_PRIVATE_KEY_B64"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.kalshi_private_key_b64.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "APCA_API_KEY_ID"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.apca_api_key_id.secret_id
              key  = "latest"
            }
          }
        }

        env {
          name = "APCA_API_SECRET_KEY"
          value_from {
            secret_key_ref {
              name = google_secret_manager_secret.apca_api_secret_key.secret_id
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
        # Chat generation runs as a background asyncio.create_task that
        # outlives the HTTP request handler. For that task to actually
        # finish, the container must stay alive after the response
        # completes. Two settings make that work:
        #
        #   minScale = 1
        #     Keep at least one warm instance so a freshly-spun-up
        #     instance with an in-flight background task isn't torn
        #     down for scale-to-zero. Also kills cold-start latency
        #     on the chat path (~10-30s saved per first message).
        #
        #   run.googleapis.com/cpu-throttling = false
        #     Without this, CPU is throttled to near-zero when the
        #     container has no in-flight HTTP request — which is
        #     exactly the situation our background task is in once
        #     the POST /chat/start response has been sent. Throttled
        #     CPU stretches chat generation from 30s to several
        #     minutes and can cause Anthropic stream timeouts.
        #
        # Cost trade-off: one always-on instance + always-allocated
        # CPU is roughly $7-10/month for the smallest tier; this
        # exits the absolute free tier but is required for the
        # disconnect-survival behavior the mobile app needs.
        "autoscaling.knative.dev/minScale"        = "1"
        "autoscaling.knative.dev/maxScale"        = "10"
        # 2026-06-12: flipped to true to cut cost (~$50/mo always-allocated
        # vs ~$6-9/mo throttled). Trade-off accepted: background chat
        # generation throttles when no request is in flight (app backgrounded
        # mid-turn); the durable-turn store makes this recoverable on reopen.
        "run.googleapis.com/cpu-throttling"       = "true"
        # Force a new revision on every TF apply so :latest image is re-pulled.
        "client.knative.dev/user-image-sha" = "deployed-${formatdate("YYYYMMDDhhmm", timestamp())}"
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  depends_on = [
    google_project_service.run,
    google_secret_manager_secret_version.jwt_secret,
    google_secret_manager_secret_version.google_client_secret,
    google_secret_manager_secret.snaptrade_client_id,
    google_secret_manager_secret.snaptrade_consumer_key,
    google_secret_manager_secret.anthropic_api_key,
    google_secret_manager_secret.cf_access_aud,
    google_secret_manager_secret_version.plaid_client_id,
    google_secret_manager_secret_version.plaid_secret,
    google_secret_manager_secret_version.plaid_env,
    google_secret_manager_secret_version.kalshi_key_id,
    google_secret_manager_secret_version.kalshi_private_key_b64,
    google_secret_manager_secret_version.apca_api_key_id,
    google_secret_manager_secret_version.apca_api_secret_key,
  ]
}

# Make backend publicly accessible
resource "google_cloud_run_service_iam_member" "backend_public" {
  service  = google_cloud_run_service.backend.name
  location = google_cloud_run_service.backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# NOTE: the previous Cloud Storage bucket + HTTPS LB + managed cert
# + static IP that used to serve ui.expense-tracker were removed in
# the Firebase Hosting migration. They cost ~$20/month idle (the
# forwarding rule + static IP). The replacement stack lives in
# firebase_hosting.tf and serves the same content from Firebase
# Hosting at no cost on the free tier.

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

# Cloudflare DNS — frontend points at Firebase Hosting (not the old LB).
# Type changed A → CNAME during the Firebase migration. The previous A
# record pointed at the HTTPS LB static IP; both LB and IP are removed
# in this same commit.
resource "cloudflare_record" "frontend_a" {
  zone_id = var.cloudflare_zone_id
  name    = "ui.expense-tracker"
  type    = "CNAME"
  content = "${google_firebase_hosting_site.frontend.site_id}.web.app"
  proxied = false
  ttl     = 300

  depends_on = [google_firebase_hosting_custom_domain.frontend]
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

# Cloud Run domain mapping for the hosted MCP server
# IMPORTANT: Must be created manually first (see runbook) then imported into state.
# The CI service account (tf-github) is not a verified Google Search Console domain owner,
# so it cannot create new domain mappings. Workaround: create once locally with user creds,
# then `terraform import` — after that, CI can manage the resource without re-creating it.
resource "google_cloud_run_domain_mapping" "mcp" {
  name     = local.mcp_domain_fqdn
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_service.backend.name
  }

  depends_on = [google_project_service.run]
}

# Cloudflare DNS - MCP subdomain CNAME
resource "cloudflare_record" "mcp_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "mcp.expense-tracker"
  type    = "CNAME"
  content = "ghs.googlehosted.com"
  # proxied=true is required: Cloudflare Access only injects Cf-Access-Jwt-Assertion
  # when traffic flows through the CF proxy. DNS-only would bypass CF entirely and
  # every MCP request would be rejected (no JWT header present).
  proxied = true
  ttl     = 1

  depends_on = [google_cloud_run_domain_mapping.mcp]
}
