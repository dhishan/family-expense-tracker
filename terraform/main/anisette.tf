# Anisette server — bundles Apple identity headers so AltStore can renew
# free-Apple-ID signing certs from the phone without a Mac in the loop.
#
# Stateless, public, ~0 cost (scale-to-zero, fits within Cloud Run free tier
# with ~100 requests/month from two phones).
#
# Image: dadoum/anisette-v3-server  (de-facto community implementation)
# Used by: AltStore Classic 2.3+ when "Anisette Server URL" is overridden.

resource "google_cloud_run_v2_service" "anisette" {
  name     = "anisette-server"
  location = var.region
  project  = var.project_id

  # No ingress restriction — phones connect from any network.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = "docker.io/dadoum/anisette-v3-server:latest"

      ports {
        container_port = 6969
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "256Mi"
        }
        # Allow CPU throttling — anisette is bursty and idle most of the
        # time; the tiny cold-start (2-3s) is acceptable for background
        # cert refresh.
        cpu_idle = true
      }
    }
  }
}

# Allow unauthenticated public access — anisette has no secrets and no
# stateful data; it's a thin proxy of Apple's identity headers.
resource "google_cloud_run_v2_service_iam_member" "anisette_public" {
  project  = google_cloud_run_v2_service.anisette.project
  location = google_cloud_run_v2_service.anisette.location
  name     = google_cloud_run_v2_service.anisette.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "anisette_server_url" {
  description = "Public anisette server URL — paste this into AltStore Classic 2.3+ Settings → Anisette Server."
  value       = google_cloud_run_v2_service.anisette.uri
}
