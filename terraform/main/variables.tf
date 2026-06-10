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

variable "google_client_secret" {
  description = "OAuth client secret for Google Sign-In"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for root domain (blueelephants.org)"
  type        = string
  default     = "1eb0ae8907a74b14d5226384b92946b7"
}

# --- Sensitive secrets (set via TF_VAR_* env or terraform.tfvars; never committed) ---
variable "snaptrade_client_id" {
  description = "SnapTrade partner client ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "snaptrade_consumer_key" {
  description = "SnapTrade partner consumer key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "anthropic_api_key" {
  description = "Anthropic API key (used by hosted MCP / analyzer / Phase E chat)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cf_access_aud" {
  description = "Cloudflare Access Application AUD tag for the MCP app"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cf_access_team_domain" {
  description = "Cloudflare Zero Trust team domain (e.g. blueelephants.cloudflareaccess.com)"
  type        = string
  default     = "blueelephants.cloudflareaccess.com"
}

variable "langfuse_secret_key" {
  description = "Langfuse secret key (LLM observability)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "langfuse_public_key" {
  description = "Langfuse public key (LLM observability)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "langfuse_base_url" {
  description = "Langfuse base URL (region-specific)"
  type        = string
  default     = "https://us.cloud.langfuse.com"
}

variable "notification_email" {
  description = "Email for monitoring alert notifications"
  type        = string
  default     = "iamdhishan@gmail.com"
}

# --- Financial data APIs (Phase F) ---
variable "fred_api_key" {
  description = "FRED (Federal Reserve Economic Data) API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "tiingo_api_key" {
  description = "Tiingo API key (price history + fundamentals)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "finnhub_api_key" {
  description = "Finnhub API key (news + analyst data)"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Plaid (bank account linking + transaction sync) ---
variable "plaid_client_id" {
  description = "Plaid client ID (from dashboard.plaid.com)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "plaid_secret" {
  description = "Plaid secret key (environment-specific)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "plaid_env" {
  description = "Plaid environment: sandbox | development | production"
  type        = string
  default     = "sandbox"
}
