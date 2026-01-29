# Firestore indexes for Family Expense Tracker

# Index for querying expenses by family and date
resource "google_firestore_index" "expenses_family_date" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "DESCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for querying expenses by family and category
resource "google_firestore_index" "expenses_family_category" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "category"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for querying expenses by family, user, and date (for "who is it for" filtering)
resource "google_firestore_index" "expenses_family_user_date" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "for_user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for querying budgets by family
resource "google_firestore_index" "budgets_family" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "budgets"

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "category"
    order      = "ASCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for querying notifications by user and read status
resource "google_firestore_index" "notifications_user_unread" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "notifications"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "is_read"
    order      = "ASCENDING"
  }

  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}
