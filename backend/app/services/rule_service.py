"""Merchant auto-rule service.

A merchant rule maps a merchant name (case-insensitive) to a set of
expense defaults (category, budget_id, beneficiary). When sync_transactions
encounters a new non-income transaction whose merchant_name matches a rule,
it creates the expense directly and skips the pending row.

Collection: merchant_rules
  family_id          str
  user_id            str    (creator)
  merchant_name      str    (display name, preserved case)
  merchant_name_lower str   (lowercase, used for case-insensitive querying)
  category           str
  budget_id          str | None
  beneficiary        str | None
  applied_count      int    (starts 0)
  last_applied_at    datetime | None
  created_at         datetime
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore  # type: ignore

from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)

RULES_COLLECTION = "merchant_rules"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def create(
    family_id: str,
    user_id: str,
    merchant_name: str,
    category: str,
    budget_id: str | None,
    beneficiary: str | None,
) -> dict:
    """Create a new merchant rule.

    Raises ValueError if a rule for the same (family_id, merchant_name) already
    exists — the router maps this to HTTP 409.
    """
    db = get_firestore_client()
    key = merchant_name.strip().lower()

    # Uniqueness check
    existing = (
        db.collection(RULES_COLLECTION)
        .where(filter=firestore.FieldFilter("family_id", "==", family_id))
        .where(filter=firestore.FieldFilter("merchant_name_lower", "==", key))
        .limit(1)
        .get()
    )
    if existing:
        raise ValueError(f"Rule for merchant '{merchant_name}' already exists in this family")

    now = _now()
    data: dict[str, Any] = {
        "family_id": family_id,
        "user_id": user_id,
        "merchant_name": merchant_name.strip(),
        "merchant_name_lower": key,
        "category": category,
        "budget_id": budget_id,
        "beneficiary": beneficiary,
        "applied_count": 0,
        "last_applied_at": None,
        "created_at": now,
    }
    doc_ref = db.collection(RULES_COLLECTION).document()
    doc_ref.set(data)
    rule = dict(data)
    rule["id"] = doc_ref.id
    return rule


def list_for_family(family_id: str) -> list[dict]:
    """Return all merchant rules for a family, sorted by applied_count DESC, created_at DESC."""
    db = get_firestore_client()
    # Firestore doesn't support multi-field ORDER BY with DESC on different fields without
    # a composite index on both. We sort in Python to avoid index constraints.
    snaps = (
        db.collection(RULES_COLLECTION)
        .where(filter=firestore.FieldFilter("family_id", "==", family_id))
        .get()
    )
    rules = []
    for snap in snaps:
        d = snap.to_dict() or {}
        d["id"] = snap.id
        rules.append(d)
    # Sort: applied_count DESC, then created_at DESC
    rules.sort(
        key=lambda r: (-(r.get("applied_count") or 0), r.get("created_at") or datetime.min),
        reverse=False,
    )
    return rules


def delete(rule_id: str, family_id: str) -> bool:
    """Delete a rule by ID, verifying family ownership. Returns True if deleted."""
    db = get_firestore_client()
    ref = db.collection(RULES_COLLECTION).document(rule_id)
    snap = ref.get()
    if not snap.exists:
        return False
    d = snap.to_dict() or {}
    if d.get("family_id") != family_id:
        return False
    ref.delete()
    return True


def find_match(family_id: str, merchant_name: str | None) -> dict | None:
    """Return the first rule matching merchant_name for this family, or None.

    Matching is case-insensitive against the stored merchant_name_lower field.
    Returns the full rule dict (with 'id') if found, otherwise None.
    """
    if not merchant_name:
        return None
    key = merchant_name.strip().lower()
    if not key:
        return None

    db = get_firestore_client()
    try:
        snaps = (
            db.collection(RULES_COLLECTION)
            .where(filter=firestore.FieldFilter("family_id", "==", family_id))
            .where(filter=firestore.FieldFilter("merchant_name_lower", "==", key))
            .limit(1)
            .get()
        )
        if snaps:
            d = snaps[0].to_dict() or {}
            d["id"] = snaps[0].id
            return d
    except Exception:
        logger.exception("find_match: Firestore error for merchant=%s family=%s", merchant_name, family_id)
    return None


def record_applied(rule_id: str) -> None:
    """Increment applied_count and set last_applied_at for a rule."""
    db = get_firestore_client()
    try:
        db.collection(RULES_COLLECTION).document(rule_id).update({
            "applied_count": firestore.Increment(1),
            "last_applied_at": _now(),
        })
    except Exception:
        logger.warning("record_applied: failed to update rule %s", rule_id)
