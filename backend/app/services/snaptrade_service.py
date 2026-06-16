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
from app.services.firestore import get_firestore_client

SNAPTRADE_USERS_COLLECTION = "snaptrade_users"


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
    """Generate a connection portal URL. Token expires in ~5 minutes."""
    snap_user_id, user_secret = _require_credentials(internal_user_id)
    body: dict[str, Any] = {"connectionType": connection_type}
    if broker:
        body["broker"] = broker
    if custom_redirect:
        body["customRedirect"] = custom_redirect
        body["immediateRedirect"] = True

    resp = get_client().authentication.login_snap_trade_user(
        query_params={"userId": snap_user_id, "userSecret": user_secret},
        body=body,
    )
    return resp.body  # {"redirectURI": "...", "sessionId": "..."}


def list_accounts(internal_user_id: str) -> list[dict]:
    snap_user_id, user_secret = _require_credentials(internal_user_id)
    resp = get_client().account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
    )
    return resp.body


def get_all_holdings(internal_user_id: str) -> list[dict]:
    """Holdings across all connected accounts. Aggregates per-account calls
    because SnapTrade deprecated the legacy /holdings endpoint (410).

    Per-account positions/balances/orders are fetched concurrently via a
    thread pool — gives ~3-4x speedup vs sequential when multiple accounts.
    """
    from concurrent.futures import ThreadPoolExecutor

    snap_user_id, user_secret = _require_credentials(internal_user_id)
    client = get_client()
    accounts_resp = client.account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
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
        results = list(pool.map(fetch_account, accounts_resp.body))
    return [r for r in results if r]


def get_account_balances(internal_user_id: str, account_id: str) -> list[dict]:
    snap_user_id, user_secret = _require_credentials(internal_user_id)
    resp = get_client().account_information.get_user_account_balance(
        query_params={"userId": snap_user_id, "userSecret": user_secret},
        path_params={"accountId": account_id},
    )
    return resp.body


def get_account_positions(internal_user_id: str, account_id: str) -> list[dict]:
    snap_user_id, user_secret = _require_credentials(internal_user_id)
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

    snap_user_id, user_secret = _require_credentials(internal_user_id)
    client = get_client()
    accounts_resp = client.account_information.list_user_accounts(
        query_params={"userId": snap_user_id, "userSecret": user_secret}
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
        for items in pool.map(fetch, accounts_resp.body):
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
