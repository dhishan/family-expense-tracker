# Firestore security rules for Family Expense Tracker

resource "google_firebaserules_ruleset" "firestore" {
  source {
    files {
      name    = "firestore.rules"
      content = <<-EOT
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            // Users collection
            match /users/{userId} {
              allow read: if request.auth != null && request.auth.uid == userId;
              allow create: if request.auth != null && request.auth.uid == userId;
              allow update: if request.auth != null && request.auth.uid == userId;
            }
            
            // Families collection
            match /families/{familyId} {
              // Allow read if user is a member of the family
              allow read: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == familyId;
              
              // Allow create for any authenticated user
              allow create: if request.auth != null;
              
              // Allow update if user is a member
              allow update: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == familyId;
            }
            
            // Expenses collection
            match /expenses/{expenseId} {
              // Allow read if user belongs to the family
              allow read: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == resource.data.family_id;
              
              // Allow create if user belongs to the family
              allow create: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == request.resource.data.family_id;
              
              // Allow update/delete if user belongs to the family
              allow update, delete: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == resource.data.family_id;
            }
            
            // Budgets collection
            match /budgets/{budgetId} {
              allow read: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == resource.data.family_id;
              
              allow create: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == request.resource.data.family_id;
              
              allow update, delete: if request.auth != null && 
                exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
                get(/databases/$(database)/documents/users/$(request.auth.uid)).data.family_id == resource.data.family_id;
            }
            
            // Notifications collection
            match /notifications/{notificationId} {
              allow read: if request.auth != null && 
                resource.data.user_id == request.auth.uid;
              
              allow update: if request.auth != null && 
                resource.data.user_id == request.auth.uid;
              
              allow create: if false; // Only backend can create
              allow delete: if false; // Only backend can delete
            }
          }
        }
      EOT
    }
  }

  depends_on = [
    google_project_service.firebaserules,
    google_firestore_database.database
  ]
}

resource "google_firebaserules_release" "firestore" {
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.firestore.name
  project      = var.project_id

  lifecycle {
    replace_triggered_by = [
      google_firebaserules_ruleset.firestore
    ]
  }

  depends_on = [
    google_firestore_database.database
  ]
}
