# Firebase Hosting for the React frontend.
#
# Background: the original setup serves ui.expense-tracker.blueelephants.org
# via a Cloud Storage bucket + global HTTPS LB + managed cert + static IP.
# That stack costs ~$20/month with zero traffic just to keep the forwarding
# rule alive. Firebase Hosting gives us identical functionality (custom
# domain, free SSL, global CDN) on the free tier for any volume this app
# will ever see (free tier: 10 GB storage + 360 MB/day egress).
#
# Migration plan (zero-downtime):
#   1. Provision the Firebase Hosting site here (this file).
#   2. CI starts deploying to BOTH the bucket and Firebase Hosting.
#   3. Verify https://family-expense-tracker-ble.web.app serves the build.
#   4. Cutover Cloudflare DNS: change ui.expense-tracker from A->LB-IP to
#      CNAME->family-expense-tracker-ble.web.app. Done in a follow-up commit
#      that also adds the google_firebase_hosting_custom_domain resource.
#   5. Tear down the LB + bucket + cert in a final cleanup commit.
#
# Everything here is additive — existing LB resources are untouched.

resource "google_project_service" "firebasehosting" {
  service                    = "firebasehosting.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

# NOTE: the GCP project is already a Firebase project (it was added
# out-of-band when we set up the Firebase web app for VITE_FIREBASE_*).
# We deliberately skip `google_firebase_project` here — creating one on
# a project that already has Firebase enabled fails with 409 ALREADY_EXISTS.
# The Firebase Hosting API + the existing project membership are enough
# to create new sites.

# Named Firebase Hosting site dedicated to this app. Gives us a stable
# https://family-expense-tracker-ble.web.app URL we can use as the CNAME
# target after DNS cutover.
resource "google_firebase_hosting_site" "frontend" {
  provider = google-beta
  project  = var.project_id
  site_id  = "family-expense-tracker-ble"

  depends_on = [
    google_project_service.firebase,
    google_project_service.firebasehosting,
  ]
}

output "firebase_hosting_default_url" {
  value       = "https://${google_firebase_hosting_site.frontend.site_id}.web.app"
  description = "Default Firebase Hosting URL — verify the build serves here before DNS cutover."
}

# The CI service account (tf-github@...) needs Firebase Hosting Admin
# to publish new releases via `firebase deploy --only hosting`. It already
# has roles/editor at the project level (granted out-of-band, see CLAUDE.md
# GCP infra notes) but Firebase Hosting deploys require this specific
# role — editor alone is not enough to call hosting.releases.create.
resource "google_project_iam_member" "ci_firebase_hosting_admin" {
  project = var.project_id
  role    = "roles/firebasehosting.admin"
  member  = "serviceAccount:tf-github@${var.project_id}.iam.gserviceaccount.com"

  depends_on = [google_project_service.firebasehosting]
}
