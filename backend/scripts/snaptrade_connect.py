"""One-time SnapTrade connection script.

Registers a SnapTrade user (if not already), generates a Connection Portal URL,
opens it in the default browser so you can log into Robinhood, then verifies
the connection by listing accounts.

The internal user ID is passed as --user-id (use your Google UID, or any stable
opaque string). Credentials are persisted to Firestore so the API and the
sync script can use them afterwards.

Usage:
  cd backend
  python -m scripts.snaptrade_connect --user-id <your-google-uid>
  # or to link a different broker:
  python -m scripts.snaptrade_connect --user-id <uid> --broker QUESTRADE
"""
from __future__ import annotations

import argparse
import json
import sys
import webbrowser

from app.services import snaptrade_service


def main() -> int:
    parser = argparse.ArgumentParser(description="One-time SnapTrade brokerage link")
    parser.add_argument("--user-id", required=True, help="Your internal app user ID (e.g. your Google UID)")
    parser.add_argument("--broker", default="ROBINHOOD", help="Brokerage slug (default: ROBINHOOD)")
    parser.add_argument("--no-browser", action="store_true", help="Print URL only, do not open browser")
    args = parser.parse_args()

    print(f"[1/3] Registering SnapTrade user for internal id={args.user_id}")
    reg = snaptrade_service.register_user(args.user_id)
    print(f"      snaptrade_user_id={reg['snaptrade_user_id']} (already_registered={reg['already_registered']})")

    print(f"[2/3] Generating Connection Portal URL for broker={args.broker}")
    login = snaptrade_service.login_url(args.user_id, broker=args.broker)
    url = login.get("redirectURI") or login.get("url")
    if not url:
        print("ERROR: SnapTrade did not return a redirect URL:", json.dumps(login, indent=2))
        return 1
    print(f"      {url}")
    if not args.no_browser:
        webbrowser.open(url)
        print("      (opened in browser - complete the login flow there)")

    input("\nPress ENTER once you have completed the brokerage login in the browser...")

    print("[3/3] Listing connected accounts")
    accounts = snaptrade_service.list_accounts(args.user_id)
    if not accounts:
        print("WARNING: no accounts returned yet. Brokerage sync can take a minute - rerun the sync script soon.")
    else:
        for a in accounts:
            print(f"  - {a.get('institution_name')} | {a.get('name')} | id={a.get('id')} | status={a.get('sync_status', {}).get('transactions', {}).get('initial_sync_completed')}")
    print("\nDone. Run scripts/snaptrade_sync.py to pull holdings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
