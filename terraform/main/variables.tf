variable "project_id" {
  description = "GCP Project ID"
  type        = string
  default     = "personal-projects-473219"
}

variable "region" {
  description = "GCP region (must support Cloud Run domain mappings)"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
  default     = "dev"
}

variable "backend_service_name" {
  description = "Name of the backend Cloud Run service"
  type        = string
  default     = "expense-tracker-backend"
}

variable "frontend_bucket_name" {
  description = "Name of the frontend storage bucket"
  type        = string
}

variable "root_domain" {
  description = "Apex domain managed in Cloudflare (e.g., blueelephants.org)"
  type        = string
  default     = "blueelephants.org"
}

variable "firestore_location" {
  description = "Firestore location"
  type        = string
  default     = "us-central1"
}

variable "google_client_id" {
  description = "OAuth client ID used to validate Google Sign-In tokens"
  type        = string
  default     = ""
}

variable "jwt_secret_key" {
  description = "Secret key for signing JWT tokens"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API Token for DNS management"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for root domain (blueelephants.org)"
  type        = string
  default     = "1eb0ae8907a74b14d5226384b92946b7"
}
