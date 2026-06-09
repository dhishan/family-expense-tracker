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

output "backend_service_account_email" {
  description = "Email of the backend service account"
  value       = google_service_account.backend_sa.email
}

output "jwt_secret_id" {
  description = "ID of the JWT secret in Secret Manager"
  value       = google_secret_manager_secret.jwt_secret.secret_id
}

output "jwt_secret_value" {
  description = "Generated JWT secret key (sensitive - only use for local development)"
  value       = random_password.jwt_secret.result
  sensitive   = true
}
