"""One-shot migration: set every existing budget's start_date to Jan 1
of the current year so rollover accumulates from the beginning of the
year. Idempotent — running twice has no effect because we only update
when start_date > Jan 1.

Usage:
    cd backend
    . venv/bin/activate
    python scripts/backdate_budgets_to_jan1.py [--dry-run]
"""
import argparse
import sys
from datetime import date, datetime

from google.cloud import firestore

from app.config import settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db = firestore.Client(
        project=settings.gcp_project_id,
        database=settings.firestore_database,
    )
    jan1 = datetime(date.today().year, 1, 1, 0, 0, 0)

    docs = list(db.collection("budgets").stream())
    print(f"Found {len(docs)} budgets in {settings.firestore_database}")

    updated = 0
    for doc in docs:
        data = doc.to_dict() or {}
        sd = data.get("start_date")
        # Firestore returns either datetime or date
        if isinstance(sd, date) and not isinstance(sd, datetime):
            sd = datetime.combine(sd, datetime.min.time())
        if not isinstance(sd, datetime):
            print(f"  skip {doc.id} {data.get('name')!r} — no start_date")
            continue
        if sd <= jan1:
            print(f"  ok   {doc.id} {data.get('name')!r} start_date={sd.date()} (already <= Jan 1)")
            continue
        print(f"  set  {doc.id} {data.get('name')!r}  {sd.date()} -> {jan1.date()}")
        if not args.dry_run:
            doc.reference.update({"start_date": jan1, "updated_at": datetime.utcnow()})
        updated += 1

    print(f"Updated {updated} budget(s){' (dry run)' if args.dry_run else ''}")


if __name__ == "__main__":
    sys.exit(main() or 0)
