"""Backfill merchant_name on existing plaid_pending_transactions whose raw
`name` matches a known aggregator pattern (DoorDash / Uber Eats / etc.).

Idempotent. Safe to re-run.

Usage:
    cd backend
    . .venv/bin/activate
    set -a && source .env && set +a
    python -m scripts.backfill_aggregator_merchants  [--dry-run]
"""
import sys
from app.services.firestore import get_firestore_client
from app.services.plaid_service import (
    _normalize_merchant_name,
    PLAID_PENDING_COLLECTION,
)


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    db = get_firestore_client()
    docs = db.collection(PLAID_PENDING_COLLECTION).stream()

    scanned = 0
    updated = 0
    samples: list[tuple[str, str, str, str]] = []

    for d in docs:
        scanned += 1
        e = d.to_dict() or {}
        original = e.get("merchant_name") or ""
        raw_name = e.get("name") or ""
        new = _normalize_merchant_name(original or None, raw_name)
        if new and new != original:
            updated += 1
            if len(samples) < 10:
                samples.append((d.id, original, raw_name, new))
            if not dry_run:
                d.reference.update({"merchant_name": new})

    print(f"Scanned {scanned} pending rows; would update {updated}")
    for did, orig, raw, new in samples:
        print(f"  {did}  '{orig}'  (raw: '{raw}')  ->  '{new}'")
    if dry_run:
        print("(dry-run; no writes performed)")
    else:
        print(f"Wrote {updated} updates.")


if __name__ == "__main__":
    main()
