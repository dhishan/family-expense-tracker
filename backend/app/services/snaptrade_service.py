"""SnapTrade service: brokerage linking + portfolio data pull.

Flow:
  1. register_user(internal_user_id) - one-time per app user. Stores userSecret in
     Firestore under `snaptrade_users/{internal_user_id}`. The userSecret is the
     credential for ALL future calls and is never re-issued, so guard it.
  2. login_url(internal_user_id, broker="ROBINHOOD") - one-time per brokerage
     connection. Returns a short-lived URL the user opens to log into Robinhood.
     SnapTrade then holds the connection; the same userSecret pulls data for
     every connected account (including additional brokerages later).
  3. list_accounts / get_holdings / get_balances / get_positions / get_activities
     - continuous pull. Safe to call on a schedule.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

from datetime import datetime
from functools import lru_cache
from typing import Any, Optional
import uuid

from fastapi import HTTPException, status
from snaptrade_client import SnapTrade

from app.config import get_settings
from app.services import snaptrade_connections as _conn
from app.services.firestore import get_firestore_client

SNAPTRADE_USERS_COLLECTION = "snaptrade_users"


def _account_authorization_id(account: dict) -> str | None:
    """Pull the brokerage authorization id off a SnapTrade account row.
    SnapTrade returns it as either a top-level `brokerage_authorization` (the
    ID) or a nested object with `id`. Tolerate both shapes."""
    if not isinstance(account, dict):
        return None
    auth = account.get("brokerage_authorization")
    if isinstance(auth, dict):
        return auth.get("id")
    if isinstance(auth, str):
        return auth
    return None


def _family_admin_user_id(family_id: str) -> str | None:
    """The first family member who has SnapTrade credentials. Used so
    secondary family members (Nithya) can call SnapTrade endpoints using
    the admin's (Dhishan's) shared SnapTrade user — the Personal plan
    only allows one user.
    """
    db = get_firestore_client()
    # Iterate users in this family that have a snaptrade_users doc. Small N
    # so a stream is fine.
    members = (
        db.collection("users").where("family_id", "==", family_id).stream()
    )
    for m in members:
        creds = (
            db.collection(SNAPTRADE_USERS_COLLECTION).document(m.id).get()
        )
        if creds.exists:
            return m.id
    return None


def _user_family_id(user_id: str) -> str | None:
    db = get_firestore_client()
    doc = db.collection("users").document(user_id).get()
    if not doc.exists:
        return None
    return (doc.to_dict() or {}).get("family_id")


def _resolve_credentials(internal_user_id: str) -> tuple[str, str]:
    """Return (snaptrade_user_id, user_secret) for a calling user.

    Priority:
      1. The user's own snaptrade_users doc.
      2. The family admin's doc (so secondary family members can list
         brokerages via the shared SnapTrade user — Personal plan).

    Raises HTTPException(404) only when no one in the family has registered.
    """
    own = get_stored_credentials(internal_user_id)
    if own:
        return own["snaptrade_user_id"], own["user_secret"]
    family_id = _user_family_id(internal_user_id)
    if family_id:
        admin_id = _family_admin_user_id(family_id)
        if admin_id and admin_id != internal_user_id:
            admin = get_stored_credentials(admin_id)
            if admin:
                return admin["snaptrade_user_id"], admin["user_secret"]
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=(
            "No SnapTrade user is registered for your family yet. "
            "The first family member to link a brokerage will provision one."
        ),
    )


@lru_cache()
def get_client() -> SnapTrade:
    s = get_settings()
    if not s.snaptrade_client_id or not s.snaptrade_consumer_key:
        raise RuntimeError(
            "SnapTrade credentials missing. Set SNAPTRADE_CLIENT_ID and "
            "SNAPTRADE_CONSUMER_KEY in the backend environment."
        )
    return SnapTrade(
        consumer_key=s.snaptrade_consumer_key,
        client_id=s.snaptrade_client_id,
    )


def _doc_ref(internal_user_id: str):
    return get_firestore_client().collection(SNAPTRADE_USERS_COLLECTION).document(internal_user_id)


def get_stored_credentials(internal_user_id: str) -> Optional[dict]:
    snap = _doc_ref(internal_user_id).get()
    return snap.to_dict() if snap.exists else None


def _require_credentials(internal_user_id: str) -> tuple[str, str]:
    creds = get_stored_credentials(internal_user_id)
    if not creds:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="SnapTrade user not registered. Call /investments/register first.",
        )
    return creds["snaptrade_user_id"], creds["user_secret"]


class SnapTradePlanLimitError(RuntimeError):
    """Raised when the SnapTrade plan refuses to provision a second user
    (Personal plan = one user only). Caller should turn this into a 409 or
    similar with a user-facing message rather than a 500."""


def register_user(internal_user_id: str) -> dict:
    """Register the app user with SnapTrade. Idempotent: returns existing if present.

    Raises SnapTradePlanLimitError on the Personal-plan limitation so the
    router can return a friendly message instead of a 500.
    """
    existing = get_stored_credentials(internal_user_id)
    if existing:
        return {
            "snaptrade_user_id": existing["snaptrade_user_id"],
            "already_registered": True,
        }

    # Personal-plan shortcut: if the family already has an admin with
    # SnapTrade credentials, delegate to them — write a doc for THIS user
    # that points at the admin's snaptrade_user_id + user_secret. The
    # secondary user can then call SnapTrade (via _resolve_credentials)
    # without us needing a second registerUser call (which the Personal
    # plan rejects).
    family_id = _user_family_id(internal_user_id)
    if family_id:
        admin_id = _family_admin_user_id(family_id)
        if admin_id and admin_id != internal_user_id:
            admin = get_stored_credentials(admin_id)
            if admin:
                _doc_ref(internal_user_id).set({
                    "internal_user_id": internal_user_id,
                    "snaptrade_user_id": admin["snaptrade_user_id"],
                    "user_secret": admin["user_secret"],
                    "delegated_from": admin_id,
                    "created_at": datetime.utcnow(),
                })
                return {
                    "snaptrade_user_id": admin["snaptrade_user_id"],
                    "already_registered": False,
                    "delegated_from": admin_id,
                }

    client = get_client()
    # Use a stable opaque ID so we can re-register deterministically if Firestore is wiped.
    snap_user_id = f"fet-{internal_user_id}-{uuid.uuid4().hex[:8]}"
    try:
        resp = client.authentication.register_snap_trade_user(body={"userId": snap_user_id})
    except Exception as e:
        msg = str(e)
        # SnapTrade Personal plan blocks a second registerUser call. Detect
        # it specifically so the UI shows a helpful message instead of 500.
        if "registerUser is not available for personal" in msg or "registerUser is not available" in msg:
            raise SnapTradePlanLimitError(
                "Brokerage linking is not available on the family's current "
                "SnapTrade plan — only one connected SnapTrade user is allowed. "
                "Ask the family admin (the first person who connected a brokerage) "
                "to share their linked accounts."
            )
        raise
    user_secret = resp.body["userSecret"]

    _doc_ref(internal_user_id).set({
        "internal_user_id": internal_user_id,
        "snaptrade_user_id": snap_user_id,
        "user_secret": user_secret,
        "created_at": datetime.utcnow(),
    })
    return {"snaptrade_user_id": snap_user_id, "already_registered": False}


def login_url(
    internal_user_id: str,
    broker: Optional[str] = "ROBINHOOD",
    custom_redirect: Optional[str] = None,
    connection_type: str = "read",
) -> dict:
    """Generate a connection portal URL. Token expires in ~5 minutes.

    Side-effect: snapshots the set of authorization_ids currently visible to
    the shared SnapTrade user so the next list_accounts call by this user
    can diff and attribute any new connection to THEM (not the family admin).
    """
    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    client = get_client()

    # Pre-connect snapshot for attribution
    try:
        pre = client.account_information.list_user_accounts(
            query_params={"userId": snap_user_id, "userSecret": user_secret}
        ).body or []
        existing_ids = [a for a in (_account_authorization_id(x) for x in pre) if a]
        _conn.write_pending_claim(
            user_id=internal_user_id,
            family_id=_user_family_id(internal_user_id),
            existing_ids=existing_ids,
        )
    except Exception as e:
        # Best-effort — if we can't snapshot, fall through. Lazy
        # attribution still catches the connection on first list call,
        # just with default family-admin ownership.
        logger.warning("snaptrade login_url pre-snapshot failed: %s", e)

    body: dict[str, Any] = {"connectionType": connection_type}
    if broker:
        body["broker"] = broker
    if custom_redirect:
        body["customRedirect"] = custom_redirect
        body["immediateRedirect"] = True

    resp = client.authentication.login_snap_trade_user(
        query_params={"userId": snap_user_id, "userSecret": user_secret},
        body=body,
    )
    return resp.body  # {"redirectURI": "...", "sessionId": "..."}


def _attribute_and_filter(
    *, internal_user_id: str, accounts: list[dict]
) -> list[dict]:
    """Run lazy connection attribution, then filter the SnapTrade response
    down to accounts the caller is allowed to see (own + family-shared)."""
    family_id = _user_family_id(internal_user_id)
    auth_ids = [a for a in (_account_authorization_id(x) for x in accounts) if a]
    try:
        _conn.attribute_new_connections(
            user_id=internal_user_id,
            family_id=family_id,
            current_authorization_ids=auth_ids,
        )
    except Exception as e:
        logger.warning("snaptrade attribute_new_connections failed: %s", e)
    allowed = _conn.allowed_authorization_ids(
        user_id=internal_user_id, family_id=family_id
    )
    out: list[dict] = []
    for acct in accounts:
        aid = _account_authorization_id(acct)
        if aid is None or aid in allowed:
            out.append(acct)
    return out


def list_accounts(internal_user_id: str) -> list[dict]:
    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    resp = get_client().account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
    )
    return _attribute_and_filter(
        internal_user_id=internal_user_id, accounts=resp.body or []
    )


def get_all_holdings(internal_user_id: str) -> list[dict]:
    """Holdings across all connected accounts. Aggregates per-account calls
    because SnapTrade deprecated the legacy /holdings endpoint (410).

    Per-account positions/balances/orders are fetched concurrently via a
    thread pool — gives ~3-4x speedup vs sequential when multiple accounts.
    """
    from concurrent.futures import ThreadPoolExecutor

    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    client = get_client()
    accounts_resp = client.account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
    )
    # Filter raw account list to ones this user is allowed to see.
    visible_accounts = _attribute_and_filter(
        internal_user_id=internal_user_id, accounts=accounts_resp.body or []
    )
    query = {"userId": snap_user_id, "userSecret": user_secret}

    def fetch_account(acct: dict) -> dict | None:
        acct_id = acct.get("id")
        if not acct_id:
            return None
        path = {"accountId": acct_id}
        try:
            positions = client.account_information.get_user_account_positions(
                query_params=query, path_params=path
            ).body
        except Exception:
            positions = []
        try:
            balances = client.account_information.get_user_account_balance(
                query_params=query, path_params=path
            ).body
        except Exception:
            balances = []
        try:
            orders = client.account_information.get_user_account_recent_orders(
                query_params=query, path_params=path
            ).body
        except Exception:
            orders = []
        return {"account": acct, "positions": positions, "balances": balances, "orders": orders}

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_account, visible_accounts))
    return [r for r in results if r]


def _assert_account_visible(internal_user_id: str, account_id: str) -> None:
    """Confirm the calling user's allowed authorization-set covers this
    account_id. Raises HTTPException(404) on miss so we don't leak existence."""
    visible = list_accounts(internal_user_id)
    if not any(a.get("id") == account_id for a in visible):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Account not found"
        )


def get_account_balances(internal_user_id: str, account_id: str) -> list[dict]:
    _assert_account_visible(internal_user_id, account_id)
    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    resp = get_client().account_information.get_user_account_balance(
        query_params={"userId": snap_user_id, "userSecret": user_secret},
        path_params={"accountId": account_id},
    )
    return resp.body


def get_account_positions(internal_user_id: str, account_id: str) -> list[dict]:
    _assert_account_visible(internal_user_id, account_id)
    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    resp = get_client().account_information.get_user_account_positions(
        query_params={"userId": snap_user_id, "userSecret": user_secret},
        path_params={"accountId": account_id},
    )
    return resp.body


def get_activities(
    internal_user_id: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    accounts: Optional[str] = None,
) -> list[dict]:
    """Transaction history aggregated per-account. SnapTrade deprecated the cross-account
    /activities endpoint, so we iterate accounts and call get_account_activities.
    Dates as YYYY-MM-DD. `accounts` is an optional comma-separated allowlist of account UUIDs."""
    from concurrent.futures import ThreadPoolExecutor

    snap_user_id, user_secret = _resolve_credentials(internal_user_id)
    client = get_client()
    accounts_resp = client.account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
    )
    # Filter raw accounts by per-user visibility before activity fetch.
    visible_accounts = _attribute_and_filter(
        internal_user_id=internal_user_id, accounts=accounts_resp.body or []
    )
    allow = set(accounts.split(",")) if accounts else None
    query_base = {"userId": snap_user_id, "userSecret": user_secret}
    if start_date:
        query_base["startDate"] = start_date
    if end_date:
        query_base["endDate"] = end_date

    def fetch(acct: dict) -> list[dict]:
        acct_id = acct.get("id")
        if not acct_id or (allow and acct_id not in allow):
            return []
        try:
            page = client.account_information.get_account_activities(
                query_params=query_base, path_params={"accountId": acct_id}
            ).body
        except Exception as e:
            # Never echo SDK exception strings — SnapTrade SDK has been
            # observed to include the full request URL (with userSecret
            # query param) in exception messages. Log server-side, return
            # a generic code to the caller.
            logger.warning(
                "snaptrade get_account_activities failed acct=%s err=%s",
                acct_id, type(e).__name__,
            )
            return [{"account_id": acct_id, "error": "snaptrade_request_failed"}]
        items = page if isinstance(page, list) else (page.get("data") or [])
        for item in items:
            item.setdefault("account_id", acct_id)
        return items

    result: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for items in pool.map(fetch, visible_accounts):
            result.extend(items)
    return result


def snapshot_holdings(internal_user_id: str) -> str:
    """Pull all holdings and persist a dated snapshot. Returns the snapshot doc id."""
    holdings = get_all_holdings(internal_user_id)
    now = datetime.utcnow()
    snapshot = {
        "captured_at": now,
        "holdings": holdings,
    }
    ref = (
        get_firestore_client()
        .collection(SNAPTRADE_USERS_COLLECTION)
        .document(internal_user_id)
        .collection("snapshots")
        .document(now.strftime("%Y%m%dT%H%M%SZ"))
    )
    ref.set(snapshot)
    return ref.id


def delete_user(internal_user_id: str) -> dict:
    """Delete on SnapTrade side and remove the stored secret."""
    creds = get_stored_credentials(internal_user_id)
    if not creds:
        return {"deleted": False, "reason": "not registered"}
    resp = get_client().authentication.delete_snap_trade_user(
        query_params={"userId": creds["snaptrade_user_id"]}
    )
    _doc_ref(internal_user_id).delete()
    return {"deleted": True, "snaptrade_response": resp.body}
