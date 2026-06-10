"""Plaid service: bank account linking + transaction sync foundation.

This module owns all Plaid-related Firestore persistence and the configured
PlaidApi client. Phase 2 will build the HTTP endpoints on top of these helpers.

Firestore schema
----------------
/plaid_items/{plaid_item_id}
  user_id: str               (denormalized for ownership checks on every read)
  plaid_access_token: str    (SENSITIVE -- encrypted at rest by Firestore;
                              NEVER log, NEVER return to clients)
  plaid_item_id: str         (Plaid's own item ID, same as doc ID)
  institution_id: str        (Plaid's institution_id, e.g. "ins_109508")
  institution_name: str      (human-readable, e.g. "Chase")
  cursor: str | None         (transactions/sync cursor; null until first sync)
  last_synced_at: timestamp | None
  status: "active" | "needs_reauth" | "removed"
  created_at: timestamp
  updated_at: timestamp

/plaid_accounts/{plaid_account_id}
  user_id: str               (denormalized for ownership checks)
  plaid_item_id: str         (link back to the item; used for filtered queries)
  account_id: str            (Plaid's own account ID, same as doc ID)
  name: str                  (account name from Plaid)
  official_name: str | None
  type: str                  ("depository" | "credit" | "loan" | "investment")
  subtype: str | None        ("checking" | "savings" | "credit card" | ...)
  mask: str | None           (last 4 of account number)
  current_balance: float | None
  available_balance: float | None
  iso_currency_code: str | None
  updated_at: timestamp

Security model
--------------
- user_id is denormalized onto every doc (mirrors chat_store.py pattern).
- Every read function verifies ownership and returns None for foreign docs
  rather than raising, so routers can 404 without leaking existence.
- Cross-user access attempts are logged as warnings.
- plaid_access_token is NEVER included in return values from any helper.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import plaid
from plaid.api import plaid_api

from app.config import get_settings
from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)

PLAID_ITEMS_COLLECTION = "plaid_items"
PLAID_ACCOUNTS_COLLECTION = "plaid_accounts"

_ENV_MAP = {
    "sandbox": plaid.Environment.Sandbox,
    "development": plaid.Environment.Sandbox,  # plaid-python v29+ removed Development; map to Sandbox for local dev
    "production": plaid.Environment.Production,
}


@lru_cache()
def _client() -> plaid_api.PlaidApi:
    """Build and memoize a configured PlaidApi instance.

    Called once per process lifetime. Raises RuntimeError if credentials
    are absent so failures are loud at startup, not buried in request logs.
    """
    s = get_settings()
    if not s.plaid_client_id or not s.plaid_secret:
        raise RuntimeError(
            "Plaid credentials missing. Set PLAID_CLIENT_ID and PLAID_SECRET "
            "in the backend environment."
        )
    env = _ENV_MAP.get(s.plaid_env.lower(), plaid.Environment.Sandbox)
    configuration = plaid.Configuration(
        host=env,
        api_key={
            "clientId": s.plaid_client_id,
            "secret": s.plaid_secret,
        },
    )
    api_client = plaid.ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# plaid_items helpers
# ---------------------------------------------------------------------------


def get_item(plaid_item_id: str, user_id: str) -> dict | None:
    """Fetch a plaid_item doc, verifying ownership.

    Returns None when:
    - The doc does not exist.
    - The doc belongs to a different user (cross-user attempt is logged).

    The returned dict never contains plaid_access_token.
    """
    db = get_firestore_client()
    snap = db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id).get()
    if not snap.exists:
        return None
    data: dict[str, Any] = snap.to_dict() or {}
    if data.get("user_id") != user_id:
        logger.warning(
            "Cross-user plaid_item access attempted: requester=%s owner=%s item=%s",
            user_id,
            data.get("user_id"),
            plaid_item_id,
        )
        return None
    data["id"] = plaid_item_id
    data.pop("plaid_access_token", None)
    return data


def list_items(user_id: str) -> list[dict]:
    """Return all plaid_items owned by user_id, newest first.

    Serves the index page that shows connected banks. Never includes
    plaid_access_token in any returned doc.
    """
    db = get_firestore_client()
    from google.cloud import firestore  # type: ignore

    query = (
        db.collection(PLAID_ITEMS_COLLECTION)
        .where(filter=firestore.FieldFilter("user_id", "==", user_id))
        .order_by("updated_at", direction=firestore.Query.DESCENDING)
    )
    out: list[dict] = []
    for snap in query.stream():
        data: dict[str, Any] = snap.to_dict() or {}
        data["id"] = snap.id
        data.pop("plaid_access_token", None)
        out.append(data)
    return out


def upsert_item(
    *,
    plaid_item_id: str,
    user_id: str,
    plaid_access_token: str,
    institution_id: str,
    institution_name: str,
    cursor: str | None = None,
    last_synced_at: datetime | None = None,
    status: str = "active",
) -> None:
    """Write (create or overwrite) a plaid_item doc.

    Caller is responsible for passing the real plaid_access_token exactly
    once (at item creation). Subsequent syncs use update_item_cursor instead
    so the token field is not re-written unnecessarily.
    """
    db = get_firestore_client()
    now = _now()
    doc: dict[str, Any] = {
        "user_id": user_id,
        "plaid_access_token": plaid_access_token,
        "plaid_item_id": plaid_item_id,
        "institution_id": institution_id,
        "institution_name": institution_name,
        "cursor": cursor,
        "last_synced_at": last_synced_at,
        "status": status,
        "updated_at": now,
    }
    ref = db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id)
    existing = ref.get()
    if existing.exists:
        doc["created_at"] = (existing.to_dict() or {}).get("created_at", now)
    else:
        doc["created_at"] = now
    ref.set(doc)


def upsert_accounts(
    plaid_item_id: str,
    user_id: str,
    accounts: list[dict[str, Any]],
) -> None:
    """Batch-write Plaid account objects into the plaid_accounts collection.

    Each element of `accounts` is a dict with keys matching the Plaid
    AccountBase schema (account_id, name, official_name, type, subtype,
    mask, balances.current, balances.available, balances.iso_currency_code).
    Extra keys are silently ignored.
    """
    db = get_firestore_client()
    now = _now()
    batch = db.batch()
    for acct in accounts:
        account_id = acct.get("account_id") or acct.get("id") or ""
        if not account_id:
            continue
        balances = acct.get("balances") or {}
        doc: dict[str, Any] = {
            "user_id": user_id,
            "plaid_item_id": plaid_item_id,
            "account_id": account_id,
            "name": acct.get("name", ""),
            "official_name": acct.get("official_name"),
            "type": acct.get("type", ""),
            "subtype": acct.get("subtype"),
            "mask": acct.get("mask"),
            "current_balance": balances.get("current"),
            "available_balance": balances.get("available"),
            "iso_currency_code": balances.get("iso_currency_code"),
            "updated_at": now,
        }
        ref = db.collection(PLAID_ACCOUNTS_COLLECTION).document(account_id)
        batch.set(ref, doc)
    batch.commit()


def delete_item(plaid_item_id: str, user_id: str) -> bool:
    """Cascade-delete a plaid_item and all its accounts.

    Verifies ownership before deleting. Returns True when the item was
    found and deleted, False when not found or owned by a different user.
    """
    db = get_firestore_client()
    item = get_item(plaid_item_id, user_id)
    if not item:
        return False

    # Delete all accounts belonging to this item first.
    from google.cloud import firestore  # type: ignore

    accounts_query = db.collection(PLAID_ACCOUNTS_COLLECTION).where(
        filter=firestore.FieldFilter("plaid_item_id", "==", plaid_item_id)
    )
    batch = db.batch()
    n = 0
    for snap in accounts_query.stream():
        batch.delete(snap.reference)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    # Delete the item doc itself in the same final batch.
    batch.delete(db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id))
    batch.commit()
    return True
