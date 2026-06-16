"""SnapTrade per-connection isolation.

We're on the SnapTrade Personal plan which only allows ONE provisioned
SnapTrade user across our whole app. Multiple app users (and multiple
families) share that single SnapTrade user, so list_accounts /
get_holdings will naturally return EVERY connected brokerage across
everyone.

To make per-user / per-family visibility work, we track every brokerage
connection (`authorization_id`) we see in our own Firestore collection
along with its owner and a "shared with family" toggle. All listing
endpoints filter the SnapTrade response by an allowlist derived from
the calling user:

    own connections  ∪  (connections of users in the same family
                          whose shared_with_family == True)

When a user starts /investments/connect we snapshot the authorization_ids
that already exist; on the user's next listing call we diff and attribute
new ones to them. That keeps attribution accurate without depending on a
SnapTrade webhook.

The composite index for `family_id + shared_with_family == True` is
declared in terraform/main/firestore_indexes.tf.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Iterable, Optional

from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)

CONNECTIONS_COLLECTION = "snaptrade_connections"
PENDING_CLAIMS_COLLECTION = "snaptrade_pending_claims"


def _conn_ref(authorization_id: str):
    return get_firestore_client().collection(CONNECTIONS_COLLECTION).document(authorization_id)


def get_connection(authorization_id: str) -> Optional[dict]:
    doc = _conn_ref(authorization_id).get()
    return doc.to_dict() if doc.exists else None


def upsert_connection(
    *,
    authorization_id: str,
    owner_user_id: str,
    family_id: Optional[str],
    brokerage: Optional[str] = None,
    shared_with_family: bool = False,
) -> None:
    """Create or update a connection ownership row. Idempotent."""
    if not authorization_id:
        return
    payload = {
        "authorization_id": authorization_id,
        "owner_user_id": owner_user_id,
        "family_id": family_id,
        "brokerage": brokerage,
        "shared_with_family": shared_with_family,
        "updated_at": datetime.utcnow(),
    }
    existing = _conn_ref(authorization_id).get()
    if not existing.exists:
        payload["added_at"] = datetime.utcnow()
        _conn_ref(authorization_id).set(payload)
    else:
        # Don't clobber existing owner / share state on re-sync. Only
        # refresh brokerage label + updated_at.
        update = {"updated_at": datetime.utcnow()}
        if brokerage:
            update["brokerage"] = brokerage
        _conn_ref(authorization_id).update(update)


def set_shared_with_family(
    *, authorization_id: str, owner_user_id: str, shared: bool
) -> dict:
    """Toggle the family-share flag. Owner-only — raises ValueError on a
    mismatch so the router can return 403."""
    row = get_connection(authorization_id)
    if not row:
        raise ValueError("not_found")
    if row.get("owner_user_id") != owner_user_id:
        raise ValueError("not_owner")
    _conn_ref(authorization_id).update(
        {"shared_with_family": bool(shared), "updated_at": datetime.utcnow()}
    )
    row["shared_with_family"] = bool(shared)
    return row


def allowed_authorization_ids(
    *, user_id: str, family_id: Optional[str]
) -> set[str]:
    """Authorization IDs the caller is allowed to see: own + family-shared."""
    db = get_firestore_client()
    out: set[str] = set()
    # Own connections
    own = db.collection(CONNECTIONS_COLLECTION).where("owner_user_id", "==", user_id).stream()
    for d in own:
        aid = (d.to_dict() or {}).get("authorization_id")
        if aid:
            out.add(aid)
    # Family-shared connections (requires composite index — declared in
    # terraform/main/firestore_indexes.tf)
    if family_id:
        shared = (
            db.collection(CONNECTIONS_COLLECTION)
            .where("family_id", "==", family_id)
            .where("shared_with_family", "==", True)
            .stream()
        )
        for d in shared:
            aid = (d.to_dict() or {}).get("authorization_id")
            if aid:
                out.add(aid)
    return out


def list_connections_visible_to(
    *, user_id: str, family_id: Optional[str]
) -> list[dict]:
    """Detailed rows of visible connections for the Settings → Connections
    UI. Marks `is_owner=True` on rows the caller can toggle."""
    db = get_firestore_client()
    seen: dict[str, dict] = {}
    own_docs = (
        db.collection(CONNECTIONS_COLLECTION).where("owner_user_id", "==", user_id).stream()
    )
    for d in own_docs:
        row = d.to_dict() or {}
        row["is_owner"] = True
        seen[row.get("authorization_id", d.id)] = row
    if family_id:
        shared_docs = (
            db.collection(CONNECTIONS_COLLECTION)
            .where("family_id", "==", family_id)
            .where("shared_with_family", "==", True)
            .stream()
        )
        for d in shared_docs:
            row = d.to_dict() or {}
            aid = row.get("authorization_id", d.id)
            if aid not in seen:
                row["is_owner"] = False
                seen[aid] = row
    return list(seen.values())


# ─── Pending claims: pre-connect snapshot ─────────────────────────────────────


def _claim_ref(user_id: str):
    return get_firestore_client().collection(PENDING_CLAIMS_COLLECTION).document(user_id)


def write_pending_claim(*, user_id: str, family_id: Optional[str], existing_ids: Iterable[str]) -> None:
    """Snapshot the authorization_ids that exist BEFORE a /connect call so the
    next list_accounts can diff and attribute new ones to this user."""
    _claim_ref(user_id).set(
        {
            "user_id": user_id,
            "family_id": family_id,
            "existing_ids": list(existing_ids),
            "created_at": datetime.utcnow(),
        }
    )


def consume_pending_claim(*, user_id: str) -> Optional[dict]:
    """Read and DELETE the pending claim for this user. Returns the doc or
    None. Called once per list_accounts cycle to attribute new connections."""
    ref = _claim_ref(user_id)
    snap = ref.get()
    if not snap.exists:
        return None
    data = snap.to_dict()
    try:
        ref.delete()
    except Exception:
        pass
    return data


def attribute_new_connections(
    *,
    user_id: str,
    family_id: Optional[str],
    current_authorization_ids: Iterable[str],
) -> list[str]:
    """Compare the user's pre-connect snapshot against the current set of
    authorization_ids; any new ones become THIS user's connections. Returns
    the list of attributed authorization_ids. Idempotent / no-op when no
    pending claim exists.

    Also lazily attributes any pre-existing authorization_ids (from before
    this collection was introduced) by writing rows owned by the FIRST user
    who lists them — practically the family admin since they're the only
    one with credentials to call list_accounts pre-rollout.
    """
    current = set(current_authorization_ids)
    claim = consume_pending_claim(user_id=user_id)
    if claim:
        before = set(claim.get("existing_ids") or [])
        new_ids = current - before
        for aid in new_ids:
            upsert_connection(
                authorization_id=aid,
                owner_user_id=user_id,
                family_id=family_id,
            )
        return list(new_ids)
    # No pending claim: opportunistically claim any authorization_id we
    # haven't seen yet under this user. Safe because pre-rollout, only the
    # primary user ever calls list_accounts.
    attributed: list[str] = []
    for aid in current:
        if not get_connection(aid):
            upsert_connection(
                authorization_id=aid,
                owner_user_id=user_id,
                family_id=family_id,
            )
            attributed.append(aid)
    return attributed
