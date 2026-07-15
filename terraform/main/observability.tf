# GCP observability for the backend Cloud Run service.
# Free-tier-friendly: enables the APIs, a log-based metric for MCP tool calls,
# and a 5xx alert policy.
#
# NOTE: intentionally NO uptime check on /health. The backend runs minScale=0
# with cpu-throttling=false (instance-based billing). A periodic uptime probe
# hits /health every minute, which keeps an instance alive 24/7 so the service
# never scales to zero and is billed for a full vCPU continuously (~$1.6/day,
# ~$49/mo). Uptime alerting on a scale-to-zero personal app is low value anyway
# (cold starts read as brief failures); the 5xx alert below covers real errors.

resource "google_project_service" "monitoring" {
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "logging" {
  service            = "logging.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudtrace" {
  service            = "cloudtrace.googleapis.com"
  disable_on_destroy = false
}

# Notification channel — email, single recipient.
resource "google_monitoring_notification_channel" "email" {
  display_name = "Backend alerts → ${var.notification_email}"
  type         = "email"
  labels = {
    email_address = var.notification_email
  }
  depends_on = [google_project_service.monitoring]
}

# Alert: elevated 5xx rate on Cloud Run.
resource "google_monitoring_alert_policy" "backend_5xx" {
  display_name = "Backend 5xx rate elevated"
  combiner     = "OR"

  conditions {
    display_name = "5xx response rate > 5 / 5min"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.backend_service_name}\" AND metric.label.response_code_class=\"5xx\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      trigger {
        count = 1
      }
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.monitoring]
}

# Log-based metric: count MCP tool calls per (user, tool).
# The backend should structured-log "mcp_tool_call" events with user_id and tool fields.
resource "google_logging_metric" "mcp_tool_calls" {
  name        = "mcp_tool_calls"
  description = "MCP tool invocations on the hosted server, by user and tool"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.backend_service_name}\" AND jsonPayload.event=\"mcp_tool_call\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "user_id"
      value_type  = "STRING"
      description = "Internal user ID making the call"
    }

    labels {
      key         = "tool"
      value_type  = "STRING"
      description = "MCP tool name"
    }
  }

  label_extractors = {
    "user_id" = "EXTRACT(jsonPayload.user_id)"
    "tool"    = "EXTRACT(jsonPayload.tool)"
  }

  depends_on = [google_project_service.logging]
}
