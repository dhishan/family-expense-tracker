"""Backfill: auto-discard pending rows that are the pending-hold side of
a charge whose posted side was already approved.

Heuristic match (since older docs don't have pending_predecessor_id):
  same family_id
  same account_id
  same merchant_name (case-insensitive)
  amount within $0.01
  date within ±3 days
  one is status='pending' and another is status='approved' with expense_id

Action: mark the pending one as 'discarded' with
discarded_reason='auto-dup-of-posted'. The approved row + linked
expense are untouched.

Usage:
    cd backend
    . .venv/bin/activate
    set -a && source .env && set +a
    python -m scripts.backfill_pending_to_posted_dupes  [--dry-run]
"""
import sys
from datetime import datetime, timezone
from app.services.firestore import get_firestore_client
from app.services.plaid_service import PLAID_PENDING_COLLECTION


def _parse_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).date()
    except Exception:
        try:
            return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()
        except Exception:
            return None


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    db = get_firestore_client()

    # Load every plaid pending doc into memory (it's hundreds, not millions).
    docs = []
    for d in db.collection(PLAID_PENDING_COLLECTION).stream():
        e = d.to_dict() or {}
        e["_id"] = d.id
        docs.append(e)

    by_family: dict[str, list[dict]] = {}
    for d in docs:
        fid = d.get("family_id") or ""
        by_family.setdefault(fid, []).append(d)

    updates: list[tuple[str, str, str, str]] = []  # (pending_id, merchant, amount, approved_id)

    for fid, family_docs in by_family.items():
        approved = [d for d in family_docs if d.get("status") == "approved" and d.get("expense_id")]
        pendings = [d for d in family_docs if d.get("status") == "pending"]
        for p in pendings:
            p_merchant = (p.get("merchant_name") or "").strip().lower()
            p_amount = float(p.get("amount") or 0)
            p_account = p.get("account_id") or ""
            p_date = _parse_date(p.get("date") or p.get("authorized_date"))
            if not p_merchant or p_amount == 0 or not p_date or not p_account:
                continue
            for a in approved:
                if a.get("account_id") != p_account:
                    continue
                a_merchant = (a.get("merchant_name") or "").strip().lower()
                if a_merchant != p_merchant:
                    continue
                if abs(float(a.get("amount") or 0) - p_amount) > 0.01:
                    continue
                a_date = _parse_date(a.get("date") or a.get("authorized_date"))
                if not a_date:
                    continue
                if abs((a_date - p_date).days) > 3:
                    continue
                updates.append((p["_id"], p.get("merchant_name") or "?", f"${p_amount:.2f}", a["_id"]))
                if not dry_run:
                    db.collection(PLAID_PENDING_COLLECTION).document(p["_id"]).update({
                        "status": "discarded",
                        "discarded_at": datetime.now(tz=timezone.utc),
                        "discarded_reason": "auto-dup-of-posted",
                        "pending_to_posted_link": True,
                    })
                break  # one match is enough

    print(f"Scanned {len(docs)} docs across {len(by_family)} families")
    print(f"{'Would mark' if dry_run else 'Marked'} {len(updates)} pending rows as discarded (dup-of-posted)")
    for pid, m, amt, aid in updates[:25]:
        print(f"  pending {pid} ({m} {amt}) → already approved as {aid}")
    if dry_run:
        print("(dry-run; no writes performed)")


if __name__ == "__main__":
    main()
