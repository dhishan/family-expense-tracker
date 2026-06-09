"""Continuous SnapTrade portfolio pull.

Pulls all holdings for a user and either prints them or persists a dated
snapshot to Firestore (snaptrade_users/{user_id}/snapshots/{timestamp}).

Usage:
  python -m scripts.snaptrade_sync --user-id <uid>                # print only
  python -m scripts.snaptrade_sync --user-id <uid> --snapshot     # persist
  python -m scripts.snaptrade_sync --user-id <uid> --activities --start 2026-01-01
"""
from __future__ import annotations

import argparse
import json
import sys

from app.services import snaptrade_service


def main() -> int:
    p = argparse.ArgumentParser(description="Pull SnapTrade portfolio data")
    p.add_argument("--user-id", required=True)
    p.add_argument("--snapshot", action="store_true", help="Persist a dated snapshot to Firestore")
    p.add_argument("--activities", action="store_true", help="Also pull transaction activities")
    p.add_argument("--start", help="Activities start date YYYY-MM-DD")
    p.add_argument("--end", help="Activities end date YYYY-MM-DD")
    args = p.parse_args()

    accounts = snaptrade_service.list_accounts(args.user_id)
    print(f"=== Accounts ({len(accounts)}) ===")
    for a in accounts:
        bal = a.get("balance", {})
        print(f"  {a.get('institution_name')} | {a.get('name')} | total={bal.get('total', {}).get('amount')} {bal.get('total', {}).get('currency')}")

    holdings = snaptrade_service.get_all_holdings(args.user_id)
    print("\n=== Holdings ===")
    print(json.dumps(holdings, indent=2, default=str))

    if args.snapshot:
        sid = snaptrade_service.snapshot_holdings(args.user_id)
        print(f"\nSnapshot persisted: {sid}")

    if args.activities:
        acts = snaptrade_service.get_activities(args.user_id, start_date=args.start, end_date=args.end)
        print(f"\n=== Activities ({len(acts)}) ===")
        print(json.dumps(acts, indent=2, default=str))

    return 0


if __name__ == "__main__":
    sys.exit(main())
