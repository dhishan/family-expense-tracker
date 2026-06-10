"""Plaid service: bank account linking + transaction sync.

Phase 2 additions on top of Phase 1 foundation:
- PLAID_CATEGORY_MAP + map_plaid_category helper
- plaid_pending_transactions Firestore CRUD
- sync_transactions cursor-based loop helper
- get_access_token helper (internal use only)



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
PLAID_PENDING_COLLECTION = "plaid_pending_transactions"

# ---------------------------------------------------------------------------
# Plaid category -> app category mapping
# ---------------------------------------------------------------------------

PLAID_CATEGORY_MAP: dict[str, str] = {
    "FOOD_AND_DRINK": "dining",
    "GROCERIES": "groceries",
    "TRANSPORTATION": "transportation",
    "TRAVEL": "travel",
    "GENERAL_MERCHANDISE": "shopping",
    "ENTERTAINMENT": "entertainment",
    "MEDICAL": "healthcare",
    "RENT_AND_UTILITIES": "utilities",
    "EDUCATION": "education",
    # fallbacks
    "GENERAL_SERVICES": "other",
    "PERSONAL_CARE": "other",
    "GOVERNMENT_AND_NON_PROFIT": "other",
    "HOME_IMPROVEMENT": "shopping",
    "LOAN_PAYMENTS": "other",
    "INCOME": "other",
    "TRANSFER_IN": "other",
    "TRANSFER_OUT": "other",
    "BANK_FEES": "other",
}


def map_plaid_category(personal_finance_category: dict | None) -> str:
    """Map Plaid's personal_finance_category dict to an app category string.

    Plaid's personal_finance_category has a 'primary' key with a value like
    'FOOD_AND_DRINK'. Returns 'other' for None or unknown values.
    """
    if not personal_finance_category:
        return "other"
    primary = (personal_finance_category.get("primary") or "").upper()
    return PLAID_CATEGORY_MAP.get(primary, "other")

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


def get_access_token(plaid_item_id: str, user_id: str) -> str | None:
    """Return plaid_access_token for the given item after ownership check.

    Returns None if the item doesn't exist or belongs to a different user.
    The token is intentionally NOT included in get_item() return values —
    this function exists so sync_transactions (and similar internal callers)
    can fetch it explicitly with a clear audit trail.
    """
    db = get_firestore_client()
    snap = db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id).get()
    if not snap.exists:
        return None
    data: dict[str, Any] = snap.to_dict() or {}
    if data.get("user_id") != user_id:
        logger.warning(
            "Cross-user plaid_item token access attempted: requester=%s owner=%s item=%s",
            user_id,
            data.get("user_id"),
            plaid_item_id,
        )
        return None
    return data.get("plaid_access_token")


def update_item_status(plaid_item_id: str, status: str) -> None:
    """Update only the status field of a plaid_item doc."""
    db = get_firestore_client()
    db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id).update(
        {"status": status, "updated_at": _now()}
    )


def update_item_cursor(plaid_item_id: str, cursor: str | None, last_synced_at: datetime) -> None:
    """Persist a new transactions/sync cursor + last_synced_at timestamp."""
    db = get_firestore_client()
    db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id).update(
        {"cursor": cursor, "last_synced_at": last_synced_at, "updated_at": _now()}
    )


# ---------------------------------------------------------------------------
# plaid_pending_transactions helpers
# ---------------------------------------------------------------------------


def _txn_to_doc(txn: Any, user_id: str, plaid_item_id: str, account_name: str, institution_name: str) -> dict[str, Any]:
    """Convert a Plaid transaction object (or dict) to a pending_transaction doc."""
    # Plaid SDK returns objects with attribute access; dicts work too.
    def _get(obj: Any, key: str) -> Any:
        return getattr(obj, key, None) if not isinstance(obj, dict) else obj.get(key)

    pfc = _get(txn, "personal_finance_category")
    if not isinstance(pfc, dict):
        pfc = pfc.to_dict() if pfc is not None and hasattr(pfc, "to_dict") else (
            {"primary": str(pfc)} if pfc else None
        )

    # Plaid stores amounts as positive for debits, negative for credits
    # We store the raw amount as-is; the UI shows it as a debit.
    amount = _get(txn, "amount")
    if amount is None:
        amount = 0.0

    txn_date = _get(txn, "date")
    if txn_date is not None and not isinstance(txn_date, str):
        txn_date = str(txn_date)
    auth_date = _get(txn, "authorized_date")
    if auth_date is not None and not isinstance(auth_date, str):
        auth_date = str(auth_date)

    return {
        "user_id": user_id,
        "plaid_item_id": plaid_item_id,
        "plaid_transaction_id": _get(txn, "transaction_id"),
        "account_id": _get(txn, "account_id"),
        "account_name": account_name,
        "institution_name": institution_name,
        "merchant_name": _get(txn, "merchant_name"),
        "name": _get(txn, "name"),
        "amount": float(amount),
        "iso_currency_code": _get(txn, "iso_currency_code"),
        "date": txn_date,
        "authorized_date": auth_date,
        "suggested_category": map_plaid_category(pfc),
        "plaid_category": pfc,
        "pending_until_posted": bool(_get(txn, "pending")),
        "raw_personal_finance_category": pfc,
        "status": "pending",
        "expense_id": None,
        "created_at": _now(),
        "updated_at": _now(),
    }


def get_pending_transaction(pending_id: str, user_id: str) -> dict | None:
    """Fetch a plaid_pending_transaction, verifying ownership. Returns None on miss / cross-user."""
    db = get_firestore_client()
    snap = db.collection(PLAID_PENDING_COLLECTION).document(pending_id).get()
    if not snap.exists:
        return None
    data: dict[str, Any] = snap.to_dict() or {}
    if data.get("user_id") != user_id:
        logger.warning(
            "Cross-user pending_transaction access: requester=%s owner=%s doc=%s",
            user_id,
            data.get("user_id"),
            pending_id,
        )
        return None
    data["id"] = pending_id
    return data


def list_pending_transactions(user_id: str, page: int = 1, page_size: int = 50) -> tuple[list[dict], int]:
    """Paginated list of pending transactions for a user, newest first.

    Returns (items, total_count).
    """
    from google.cloud import firestore  # type: ignore

    db = get_firestore_client()
    base_query = (
        db.collection(PLAID_PENDING_COLLECTION)
        .where(filter=firestore.FieldFilter("user_id", "==", user_id))
        .where(filter=firestore.FieldFilter("status", "==", "pending"))
        .order_by("created_at", direction=firestore.Query.DESCENDING)
    )

    # Total count
    count_agg = base_query.count()
    count_result = count_agg.get()
    total = count_result[0][0].value

    offset = (page - 1) * page_size
    docs = base_query.offset(offset).limit(page_size).stream()
    items: list[dict] = []
    for doc in docs:
        d: dict[str, Any] = doc.to_dict() or {}
        d["id"] = doc.id
        items.append(d)
    return items, total


def update_pending_status(
    pending_id: str,
    *,
    status: str,
    expense_id: str | None = None,
    actor_user_id: str | None = None,
) -> None:
    """Update the status (and optionally expense_id) of a pending transaction doc."""
    db = get_firestore_client()
    update: dict[str, Any] = {"status": status, "updated_at": _now()}
    if status == "approved":
        update["approved_at"] = _now()
        update["approved_by"] = actor_user_id
        if expense_id:
            update["expense_id"] = expense_id
    elif status == "discarded":
        update["discarded_at"] = _now()
        update["discarded_by"] = actor_user_id
    db.collection(PLAID_PENDING_COLLECTION).document(pending_id).update(update)


# ---------------------------------------------------------------------------
# Transaction sync
# ---------------------------------------------------------------------------

_SYNC_LOOP_CAP = 10  # safety cap on cursor pagination


def sync_transactions(plaid_item_id: str, user_id: str) -> dict[str, Any]:
    """Cursor-based transaction sync from Plaid into plaid_pending_transactions.

    Returns {added, modified, removed, has_more}.

    Behavior:
    - Fetches the item and verifies ownership. Bails if status != 'active'.
    - Loops calling /transactions/sync until has_more=False (capped at _SYNC_LOOP_CAP).
    - For each 'added' transaction: upsert a pending doc (dedupe by plaid_transaction_id).
    - For each 'modified': if pending row is still 'pending', update in place.
      If already approved/discarded, log and skip.
    - For each 'removed': if pending row is 'pending', delete it.
      If approved, mark the expense doc plaid_status='removed' without deleting it.
    - Persists the new cursor + last_synced_at on the item doc.
    """
    from plaid.model.transactions_sync_request import TransactionsSyncRequest  # type: ignore
    from google.cloud import firestore  # type: ignore

    db = get_firestore_client()

    # --- Load item + verify ownership (before touching Plaid API) ---
    item_snap = db.collection(PLAID_ITEMS_COLLECTION).document(plaid_item_id).get()
    if not item_snap.exists:
        logger.warning("sync_transactions: item %s not found", plaid_item_id)
        return {"added": 0, "modified": 0, "removed": 0, "has_more": False, "error": "item_not_found"}

    item_data: dict[str, Any] = item_snap.to_dict() or {}
    if item_data.get("user_id") != user_id:
        logger.warning("sync_transactions: cross-user attempt item=%s requester=%s", plaid_item_id, user_id)
        return {"added": 0, "modified": 0, "removed": 0, "has_more": False, "error": "not_found"}

    if item_data.get("status") != "active":
        logger.info("sync_transactions: item %s status=%s, skipping", plaid_item_id, item_data.get("status"))
        return {"added": 0, "modified": 0, "removed": 0, "has_more": False, "error": "item_not_active"}

    # Only build Plaid client after guards pass so tests without credentials can exercise early exits.
    client = _client()

    access_token: str = item_data.get("plaid_access_token", "")
    cursor: str | None = item_data.get("cursor")
    institution_name: str = item_data.get("institution_name", "")

    # Build a quick account_id -> account_name lookup for this item.
    acct_snaps = (
        db.collection(PLAID_ACCOUNTS_COLLECTION)
        .where(filter=firestore.FieldFilter("plaid_item_id", "==", plaid_item_id))
        .stream()
    )
    account_map: dict[str, str] = {}
    for a in acct_snaps:
        ad = a.to_dict() or {}
        account_map[ad.get("account_id", a.id)] = ad.get("name", "")

    added_count = 0
    modified_count = 0
    removed_count = 0
    has_more = True
    iterations = 0

    while has_more and iterations < _SYNC_LOOP_CAP:
        iterations += 1
        req_body: dict[str, Any] = {"access_token": access_token}
        if cursor:
            req_body["cursor"] = cursor

        try:
            resp = client.transactions_sync(TransactionsSyncRequest(**req_body))
            resp_body = resp.to_dict() if hasattr(resp, "to_dict") else resp
        except Exception as exc:
            logger.exception("sync_transactions: Plaid API error for item %s", plaid_item_id)
            return {"added": added_count, "modified": modified_count, "removed": removed_count,
                    "has_more": False, "error": str(exc)}

        added_txns = resp_body.get("added") or []
        modified_txns = resp_body.get("modified") or []
        removed_txns = resp_body.get("removed") or []
        cursor = resp_body.get("next_cursor") or cursor
        has_more = bool(resp_body.get("has_more", False))

        # --- Process added ---
        for txn in added_txns:
            txn_id = _plaid_txn_id(txn)
            if not txn_id:
                continue
            acct_id = _get_attr(txn, "account_id") or ""
            acct_name = account_map.get(acct_id, "")
            doc = _txn_to_doc(txn, user_id, plaid_item_id, acct_name, institution_name)
            # Dedupe by plaid_transaction_id: check if a doc already exists.
            existing = _find_pending_by_plaid_txn_id(db, user_id, txn_id)
            if existing:
                # Already in our system — skip to avoid duplicates.
                continue
            db.collection(PLAID_PENDING_COLLECTION).document().set(doc)
            added_count += 1

        # --- Process modified ---
        for txn in modified_txns:
            txn_id = _plaid_txn_id(txn)
            if not txn_id:
                continue
            existing = _find_pending_by_plaid_txn_id(db, user_id, txn_id)
            if not existing:
                continue
            existing_status = existing.get("status", "pending")
            if existing_status == "pending":
                acct_id = _get_attr(txn, "account_id") or ""
                acct_name = account_map.get(acct_id, "")
                updated_doc = _txn_to_doc(txn, user_id, plaid_item_id, acct_name, institution_name)
                updated_doc["status"] = "pending"  # keep status
                updated_doc.pop("created_at", None)  # don't overwrite created_at
                db.collection(PLAID_PENDING_COLLECTION).document(existing["id"]).update(updated_doc)
                modified_count += 1
            else:
                logger.info(
                    "sync_transactions: modified txn %s already %s — skipping", txn_id, existing_status
                )

        # --- Process removed ---
        for txn in removed_txns:
            txn_id = _plaid_txn_id(txn)
            if not txn_id:
                continue
            existing = _find_pending_by_plaid_txn_id(db, user_id, txn_id)
            if not existing:
                continue
            if existing.get("status") == "pending":
                db.collection(PLAID_PENDING_COLLECTION).document(existing["id"]).delete()
                removed_count += 1
            elif existing.get("status") == "approved":
                expense_id = existing.get("expense_id")
                if expense_id:
                    try:
                        db.collection("expenses").document(expense_id).update(
                            {"plaid_status": "removed", "updated_at": _now()}
                        )
                    except Exception:
                        logger.warning("sync_transactions: could not mark expense %s plaid_status=removed", expense_id)

    if iterations >= _SYNC_LOOP_CAP and has_more:
        logger.warning("sync_transactions: hit loop cap (%d) for item %s", _SYNC_LOOP_CAP, plaid_item_id)

    # Persist cursor
    update_item_cursor(plaid_item_id, cursor, _now())

    return {"added": added_count, "modified": modified_count, "removed": removed_count, "has_more": has_more}


def _plaid_txn_id(txn: Any) -> str | None:
    return _get_attr(txn, "transaction_id")


def _get_attr(obj: Any, key: str) -> Any:
    return getattr(obj, key, None) if not isinstance(obj, dict) else obj.get(key)


def _find_pending_by_plaid_txn_id(db: Any, user_id: str, plaid_transaction_id: str) -> dict | None:
    """Return the pending_transaction doc matching a plaid_transaction_id for this user, or None."""
    from google.cloud import firestore  # type: ignore

    results = list(
        db.collection(PLAID_PENDING_COLLECTION)
        .where(filter=firestore.FieldFilter("user_id", "==", user_id))
        .where(filter=firestore.FieldFilter("plaid_transaction_id", "==", plaid_transaction_id))
        .limit(1)
        .stream()
    )
    if not results:
        return None
    d: dict[str, Any] = results[0].to_dict() or {}
    d["id"] = results[0].id
    return d


def delete_pending_transactions_for_item(plaid_item_id: str) -> int:
    """Delete all plaid_pending_transactions docs for a given item (used on item disconnect)."""
    from google.cloud import firestore  # type: ignore

    db = get_firestore_client()
    snaps = list(
        db.collection(PLAID_PENDING_COLLECTION)
        .where(filter=firestore.FieldFilter("plaid_item_id", "==", plaid_item_id))
        .stream()
    )
    batch = db.batch()
    n = 0
    for snap in snaps:
        batch.delete(snap.reference)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    if n % 400 != 0:
        batch.commit()
    return n
