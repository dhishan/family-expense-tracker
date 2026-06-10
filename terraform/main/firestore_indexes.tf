# Firestore indexes for Family Expense Tracker

# Index for querying expenses by family and date (descending for list)
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

# Index for querying expenses by family and date range (ascending for summary)
resource "google_firestore_index" "expenses_family_date_range" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
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

# Index for querying expenses by beneficiary, family, and date (for budget spending calculation)
resource "google_firestore_index" "expenses_beneficiary_family_date" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "beneficiary"
    order      = "ASCENDING"
  }

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for budget spending queries: category equality + family_id equality + date range
resource "google_firestore_index" "expenses_category_family_date" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "expenses"

  fields {
    field_path = "category"
    order      = "ASCENDING"
  }

  fields {
    field_path = "family_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "date"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# Index for querying budgets by family.
#
# This index serves all `budgets` queries regardless of the `period` value
# (weekly / monthly / yearly). Period is stored as a doc field and used by
# the application to compute date ranges — it isn't a query filter, so
# adding yearly budgets did NOT require a new composite index.
#
# Spending lookups for budgets go through `expenses` queries with
# (family_id + date range + category) filters, served by the
# `expenses_family_date` and `expenses_category_family_date` indexes
# defined above. Those work for any date range — week, month, or year.
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

# Chat conversation list: filter by owner, order by updated_at desc.
# Required by ChatStore.list_conversations (history UI).
resource "google_firestore_index" "chat_conversations_user_updated" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "chat_conversations"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "updated_at"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# plaid_items list: filter by owner, order by updated_at desc.
# Required by plaid_service.list_items.
resource "google_firestore_index" "plaid_items_user_updated" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "plaid_items"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "updated_at"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# plaid_accounts: filter by owner + item for per-item account fetches.
# Required by plaid_service.upsert_accounts / delete_item cascade.
resource "google_firestore_index" "plaid_accounts_user_item" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "plaid_accounts"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "plaid_item_id"
    order      = "ASCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# plaid_pending_transactions: filter by user_id + status, order by created_at DESC.
# Required by plaid_service.list_pending_transactions.
resource "google_firestore_index" "plaid_pending_user_status_created" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "plaid_pending_transactions"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }

  depends_on = [google_firestore_database.database]
}

# plaid_pending_transactions: dedupe lookup by user_id + plaid_transaction_id.
# Required by sync_transactions._find_pending_by_plaid_txn_id.
resource "google_firestore_index" "plaid_pending_user_txn_id" {
  project    = var.project_id
  database   = google_firestore_database.database.name
  collection = "plaid_pending_transactions"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }

  fields {
    field_path = "plaid_transaction_id"
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
