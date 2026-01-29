output "backend_url" {
  description = "URL of the backend Cloud Run service"
  value       = google_cloud_run_service.backend.status[0].url
}

output "frontend_url" {
  description = "URL of the frontend website"
  value       = "https://${local.frontend_domain_fqdn}"
}

output "backend_custom_domain" {
  description = "Custom domain serving the Cloud Run API"
  value       = "https://${local.backend_domain_fqdn}"
}

output "firestore_database" {
  description = "Firestore database name"
  value       = google_firestore_database.database.name
}

output "frontend_bucket_name" {
  description = "Name of the frontend storage bucket"
  value       = google_storage_bucket.frontend.name
}

output "backend_service_account_email" {
  description = "Email of the backend service account"
  value       = google_service_account.backend_sa.email
}

output "frontend_load_balancer_ip" {
  description = "Reserved global IPv4 address serving the frontend"
  value       = google_compute_global_address.frontend.address
}
