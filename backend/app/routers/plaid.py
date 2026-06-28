"""Plaid router: bank account linking, transaction sync, and review flow.

Mounts at /api/v1/plaid in main.py.

Endpoints:
  POST   /plaid/link-token                  Create a Plaid Link token
  POST   /plaid/exchange                    Exchange public token, trigger initial sync
  GET    /plaid/items                       List connected institutions
  PATCH  /plaid/items/{id}                  Rename a connection
  DELETE /plaid/items/{id}                  Disconnect a bank
  POST   /plaid/items/{id}/reconnect        Update-mode link token for needs_reauth items

  POST   /plaid/webhook                     Plaid webhook receiver (no auth, sig verified)

  GET    /plaid/pending                     Paginated pending transaction inbox
  POST   /plaid/pending/{id}/approve        Approve -> creates expense
  POST   /plaid/pending/{id}/discard        Discard (no expense created)
  POST   /plaid/pending/{id}/save-uncategorized  Approve with category=other

Phase 3: All endpoints are family-scoped. The calling user must belong to a family
(HTTP 400 if not). Ownership checks use family_id — any family member can view/act on
items, accounts, and pending transactions connected by any other family member.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel

# Background task set — keeps references alive so GC doesn't cancel in-flight tasks.
_BG_TASKS: set[asyncio.Task] = set()

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.expense import ExpenseCategory, ExpenseCreate, PaymentMethod
from app.models.user import User
from app.services import plaid_service
from app.services.expense_service import get_expense_service
from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)
router = APIRouter()
settings = get_settings()

WEBHOOK_URL = "https://api.expense-tracker.blueelephants.org/api/v1/plaid/webhook"

# Single unified OAuth redirect URI — whitelisted in the Plaid dashboard.
# The backend endpoint reads ?client= to determine where to forward the user.
# Plaid rejects query strings in whitelisted redirect_uris ("redirect_uri
# cannot include query"). So instead of one URI with ?client=… we use:
#   - Web: directly point at the SPA route, no backend relay needed
#   - Mobile: point at the backend relay, which 302s to expenses://
# Two URIs to whitelist in the Plaid dashboard.
PLAID_REDIRECT_URI_WEB = "https://ui.expense-tracker.blueelephants.org/plaid-oauth-return"
PLAID_REDIRECT_URI_MOBILE = "https://api.expense-tracker.blueelephants.org/api/v1/plaid/oauth"

# Final destinations after the backend relay
# (Final destinations are now baked into PLAID_REDIRECT_URI_WEB /
# PLAID_REDIRECT_URI_MOBILE and the relay handler directly.)

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class LinkTokenRequest(BaseModel):
    products: list[str] = ["transactions"]
    country_codes: list[str] = ["US"]
    platform: str = "mobile"  # "web" | "mobile"


class ExchangeRequest(BaseModel):
    public_token: str


class PatchItemRequest(BaseModel):
    institution_name: Optional[str] = None


class ApproveRequest(BaseModel):
    amount: Optional[float] = None
    category: Optional[str] = None
    description: Optional[str] = None
    beneficiary: Optional[str] = None
    # Extended fields — mirroring the manual Add Transaction form
    date: Optional[str] = None          # ISO date string e.g. "2026-06-10"
    merchant: Optional[str] = None
    payment_method: Optional[str] = None
    tags: Optional[list[str]] = None
    is_income_override: bool = False     # True when user explicitly approves an income row
    budget_id: Optional[str] = None     # Explicitly pin this expense to a budget
    save_as_rule: bool = False           # If True, save a merchant rule after approving


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _plaid_client():
    """Return a configured PlaidApi instance via plaid_service."""
    # Access the internal _client() directly so we share the cached instance.
    return plaid_service._client()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _payment_method_from_account_type(account_type: str | None) -> str:
    if not account_type:
        return PaymentMethod.CREDIT.value
    t = (account_type or "").lower()
    if t == "credit":
        return PaymentMethod.CREDIT.value
    if t == "depository":
        return PaymentMethod.DEBIT.value
    return PaymentMethod.BANK_TRANSFER.value


def _get_account_info(family_id: str, account_id: str) -> dict:
    """Fetch account name + type from plaid_accounts collection, scoped to family."""
    db = get_firestore_client()
    snap = db.collection(plaid_service.PLAID_ACCOUNTS_COLLECTION).document(account_id).get()
    if snap.exists:
        d = snap.to_dict() or {}
        if d.get("family_id") == family_id:
            return d
    return {}


def _require_family_id(user: User) -> str:
    """Return user's family_id, raising HTTP 400 if the user is not in a family."""
    if not user.family_id:
        raise HTTPException(
            status_code=400,
            detail="User must belong to a family to use bank account features",
        )
    return user.family_id


# ---------------------------------------------------------------------------
# OAuth relay endpoint — no auth required
# ---------------------------------------------------------------------------


@router.get("/oauth")
async def plaid_oauth_relay(request: Request):
    """Mobile-only relay. Plaid redirects here after OAuth bank login; we
    302 to the mobile app's deep link. Web clients get redirect_uri set
    directly to the SPA route — they never touch this endpoint.

    No authentication: this is called from the bank's domain with no user
    session.
    """
    from fastapi.responses import RedirectResponse
    from urllib.parse import urlencode

    params = dict(request.query_params)
    qs = urlencode(params) if params else ""
    target = f"expenses://plaid-oauth?{qs}" if qs else "expenses://plaid-oauth"

    logger.info("plaid_oauth_relay -> %s", target)
    return RedirectResponse(
        url=target,
        status_code=302,
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Connection flow
# ---------------------------------------------------------------------------


@router.post("/link-token")
async def create_link_token(
    body: LinkTokenRequest = LinkTokenRequest(),
    current_user: User = Depends(get_current_user),
):
    """Create a Plaid Link token for the current user.

    The client_user_id is the individual user (Plaid identifies the connector),
    but the resulting access_token will be stored under the family.
    """
    from plaid.model.link_token_create_request import LinkTokenCreateRequest  # type: ignore
    from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser  # type: ignore
    from plaid.model.products import Products  # type: ignore
    from plaid.model.country_code import CountryCode  # type: ignore

    _require_family_id(current_user)
    client = _plaid_client()

    product_map = {"transactions": Products("transactions")}
    products = [product_map.get(p, Products(p)) for p in body.products]
    country_codes = [CountryCode(c) for c in body.country_codes]

    redirect_uri = PLAID_REDIRECT_URI_WEB if body.platform == "web" else PLAID_REDIRECT_URI_MOBILE

    req = LinkTokenCreateRequest(
        user=LinkTokenCreateRequestUser(client_user_id=current_user.id),
        client_name="Family Expense Tracker",
        products=products,
        country_codes=country_codes,
        language="en",
        webhook=WEBHOOK_URL,
        redirect_uri=redirect_uri,
    )
    try:
        resp = client.link_token_create(req)
    except Exception as exc:
        logger.exception("link_token_create failed for user %s", current_user.id)
        raise HTTPException(status_code=502, detail=f"Plaid error: {exc}")

    body_data = resp.to_dict() if hasattr(resp, "to_dict") else resp
    return {
        "link_token": body_data.get("link_token"),
        "expiration": body_data.get("expiration"),
    }


@router.post("/exchange")
async def exchange_public_token(
    body: ExchangeRequest,
    current_user: User = Depends(get_current_user),
):
    """Exchange a Plaid public token for an access token, upsert item + accounts, trigger sync."""
    from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest  # type: ignore
    from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest  # type: ignore
    from plaid.model.accounts_get_request import AccountsGetRequest  # type: ignore
    from plaid.model.country_code import CountryCode  # type: ignore

    family_id = _require_family_id(current_user)
    client = _plaid_client()

    # 1. Exchange public token
    try:
        exchange_resp = client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=body.public_token)
        )
    except Exception as exc:
        logger.exception("item_public_token_exchange failed")
        raise HTTPException(status_code=502, detail=f"Plaid error: {exc}")

    exchange_data = exchange_resp.to_dict() if hasattr(exchange_resp, "to_dict") else exchange_resp
    access_token: str = exchange_data["access_token"]
    plaid_item_id: str = exchange_data["item_id"]

    # 2. Fetch institution details
    institution_id = ""
    institution_name = "Unknown"
    try:
        item_resp = client.item_get(
            __import__("plaid.model.item_get_request", fromlist=["ItemGetRequest"]).ItemGetRequest(
                access_token=access_token
            )
        )
        item_data = item_resp.to_dict() if hasattr(item_resp, "to_dict") else item_resp
        institution_id = (item_data.get("item") or {}).get("institution_id") or ""
        if institution_id:
            inst_resp = client.institutions_get_by_id(
                InstitutionsGetByIdRequest(
                    institution_id=institution_id,
                    country_codes=[CountryCode("US")],
                )
            )
            inst_data = inst_resp.to_dict() if hasattr(inst_resp, "to_dict") else inst_resp
            institution_name = (inst_data.get("institution") or {}).get("name", "Unknown")
    except Exception:
        logger.warning("Could not fetch institution name for item %s", plaid_item_id)

    # 3. Fetch accounts
    try:
        accts_resp = client.accounts_get(
            AccountsGetRequest(access_token=access_token)
        )
        accts_data = accts_resp.to_dict() if hasattr(accts_resp, "to_dict") else accts_resp
        raw_accounts: list[dict] = accts_data.get("accounts") or []
    except Exception:
        logger.warning("Could not fetch accounts for item %s", plaid_item_id)
        raw_accounts = []

    plaid_service.upsert_accounts(
        plaid_item_id,
        family_id,
        raw_accounts,
        connected_by_user_id=current_user.id,
    )

    # 4. Persist item (family-scoped, with audit trail of who connected it)
    plaid_service.upsert_item(
        plaid_item_id=plaid_item_id,
        family_id=family_id,
        connected_by_user_id=current_user.id,
        plaid_access_token=access_token,
        institution_id=institution_id,
        institution_name=institution_name,
        cursor=None,
        status="active",
    )

    # 5. Kick off initial sync as a background task — do NOT await it inline.
    # Plaid Sandbox can take 10-30s for the initial sync; blocking here would freeze
    # the UI. Plaid also fires INITIAL_UPDATE / HISTORICAL_UPDATE webhooks that will
    # re-trigger the sync, so the synchronous call is redundant anyway.
    async def _bg_sync():
        try:
            plaid_service.sync_transactions(plaid_item_id)
        except Exception:
            logger.warning("Background initial sync failed for item %s — will retry via webhook", plaid_item_id)

    task = asyncio.create_task(_bg_sync())
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)

    accounts_out = [
        {
            "id": a.get("account_id", ""),
            "name": a.get("name", ""),
            "mask": a.get("mask"),
            "type": str(a.get("type", "")),
            "subtype": str(a.get("subtype", "")) if a.get("subtype") else None,
            "balances": a.get("balances") or {},
        }
        for a in raw_accounts
    ]
    return {
        "plaid_item_id": plaid_item_id,
        "institution_name": institution_name,
        "accounts": accounts_out,
        "accounts_count": len(raw_accounts),
        "pending_count": 0,
        "sync_status": "pending",
    }


# ---------------------------------------------------------------------------
# Items management
# ---------------------------------------------------------------------------


@router.get("/items")
async def list_items(current_user: User = Depends(get_current_user)):
    """List connected institutions + accounts for the current family."""
    from google.cloud import firestore  # type: ignore

    family_id = _require_family_id(current_user)
    db = get_firestore_client()
    items = plaid_service.list_items(family_id)

    # Attach accounts to each item
    out = []
    for item in items:
        item_id = item["id"]
        acct_snaps = (
            db.collection(plaid_service.PLAID_ACCOUNTS_COLLECTION)
            .where(filter=firestore.FieldFilter("plaid_item_id", "==", item_id))
            .stream()
        )
        accounts = []
        for snap in acct_snaps:
            a = snap.to_dict() or {}
            accounts.append({
                "id": snap.id,
                "name": a.get("name", ""),
                "mask": a.get("mask"),
                "type": a.get("type", ""),
                "subtype": a.get("subtype"),
                "balances": {
                    "current": a.get("current_balance"),
                    "available": a.get("available_balance"),
                    "iso_currency_code": a.get("iso_currency_code"),
                },
            })
        out.append({
            "id": item_id,
            "institution_name": item.get("institution_name", ""),
            "status": item.get("status", "active"),
            "last_synced_at": item.get("last_synced_at"),
            "connected_by_user_id": item.get("connected_by_user_id"),
            "accounts": accounts,
        })
    return {"items": out}


@router.patch("/items/{plaid_item_id}")
async def patch_item(
    plaid_item_id: str,
    body: PatchItemRequest,
    current_user: User = Depends(get_current_user),
):
    """Rename a connected institution. Any family member may rename."""
    family_id = _require_family_id(current_user)
    item = plaid_service.get_item(plaid_item_id, family_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    if body.institution_name is not None:
        db = get_firestore_client()
        db.collection(plaid_service.PLAID_ITEMS_COLLECTION).document(plaid_item_id).update(
            {"institution_name": body.institution_name, "updated_at": _now()}
        )

    return {"ok": True}


@router.delete("/items/{plaid_item_id}", status_code=200)
async def delete_item(
    plaid_item_id: str,
    current_user: User = Depends(get_current_user),
):
    """Disconnect a bank: calls Plaid /item/remove then cascade-deletes local data.

    Any family member may disconnect a bank, not just the original connector.
    """
    from plaid.model.item_remove_request import ItemRemoveRequest  # type: ignore

    family_id = _require_family_id(current_user)
    item = plaid_service.get_item(plaid_item_id, family_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # Fetch access token before deleting (internal — no family check needed here)
    access_token = plaid_service.get_access_token_internal(plaid_item_id)

    # Call Plaid to remove item (best-effort)
    if access_token:
        try:
            _plaid_client().item_remove(ItemRemoveRequest(access_token=access_token))
        except Exception:
            logger.warning("Plaid item_remove failed for %s — continuing with local delete", plaid_item_id)

    # Delete pending transactions first
    plaid_service.delete_pending_transactions_for_item(plaid_item_id)

    # Cascade-delete item + accounts
    plaid_service.delete_item(plaid_item_id, family_id)

    logger.info(
        "plaid item disconnected item=%s disconnected_by_user_id=%s family=%s",
        plaid_item_id, current_user.id, family_id,
    )
    return {"ok": True, "deleted": plaid_item_id}


@router.post("/items/{plaid_item_id}/reconnect")
async def reconnect_item(
    plaid_item_id: str,
    current_user: User = Depends(get_current_user),
):
    """Create an update-mode link token for a needs_reauth item.

    Any family member may initiate reconnect, not just the original connector.
    """
    from plaid.model.link_token_create_request import LinkTokenCreateRequest  # type: ignore
    from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser  # type: ignore

    family_id = _require_family_id(current_user)
    item = plaid_service.get_item(plaid_item_id, family_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    access_token = plaid_service.get_access_token_internal(plaid_item_id)
    if not access_token:
        raise HTTPException(status_code=404, detail="Item not found")

    client = _plaid_client()
    try:
        req = LinkTokenCreateRequest(
            user=LinkTokenCreateRequestUser(client_user_id=current_user.id),
            client_name="Family Expense Tracker",
            country_codes=[
                __import__("plaid.model.country_code", fromlist=["CountryCode"]).CountryCode("US")
            ],
            language="en",
            webhook=WEBHOOK_URL,
            access_token=access_token,
        )
        resp = client.link_token_create(req)
    except Exception as exc:
        logger.exception("link_token_create (update mode) failed")
        raise HTTPException(status_code=502, detail=f"Plaid error: {exc}")

    body_data = resp.to_dict() if hasattr(resp, "to_dict") else resp
    return {
        "link_token": body_data.get("link_token"),
        "expiration": body_data.get("expiration"),
    }


# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------

# Simple in-process cache for Plaid's webhook verification public keys.
# Keyed by key_id, values are (key_dict, fetched_at_unix_seconds).
_WEBHOOK_KEY_CACHE: dict[str, tuple[dict, float]] = {}
_WEBHOOK_KEY_TTL = 3600  # 1 hour


def _fetch_webhook_verification_key(key_id: str) -> dict:
    """Fetch + cache Plaid's webhook verification public key by key_id."""
    from plaid.model.webhook_verification_key_get_request import WebhookVerificationKeyGetRequest  # type: ignore

    now = time.time()
    if key_id in _WEBHOOK_KEY_CACHE:
        cached_key, fetched_at = _WEBHOOK_KEY_CACHE[key_id]
        if now - fetched_at < _WEBHOOK_KEY_TTL:
            return cached_key

    resp = _plaid_client().webhook_verification_key_get(
        WebhookVerificationKeyGetRequest(key_id=key_id)
    )
    resp_data = resp.to_dict() if hasattr(resp, "to_dict") else resp
    key_data = resp_data.get("key") or {}
    _WEBHOOK_KEY_CACHE[key_id] = (key_data, now)
    return key_data


def _verify_plaid_webhook(request_body: bytes, plaid_verification: str | None) -> bool:
    """Verify Plaid webhook JWT signature. Returns False on any failure (fail closed)."""
    if not plaid_verification:
        logger.warning("Plaid webhook: missing Plaid-Verification header")
        return False

    try:
        import jwt as pyjwt  # PyJWT
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # type: ignore

        # Decode header without verification to extract key_id
        unverified_header = pyjwt.get_unverified_header(plaid_verification)
        key_id = unverified_header.get("kid")
        if not key_id:
            logger.warning("Plaid webhook: JWT missing kid header")
            return False

        key_data = _fetch_webhook_verification_key(key_id)

        # Build the public key from JWK
        from jwt.algorithms import ECAlgorithm  # type: ignore
        public_key = ECAlgorithm.from_jwk(json.dumps(key_data))

        # Compute body hash
        body_hash = hashlib.sha256(request_body).hexdigest()

        # Verify and decode
        decoded = pyjwt.decode(
            plaid_verification,
            public_key,
            algorithms=["ES256"],
            options={"require": ["iat", "request_body_sha256"]},
        )

        # Confirm body hash matches
        if decoded.get("request_body_sha256") != body_hash:
            logger.warning("Plaid webhook: body hash mismatch")
            return False

        # Check iat is within 5 minutes
        iat = decoded.get("iat", 0)
        if abs(time.time() - iat) > 300:
            logger.warning("Plaid webhook: iat too old (%s)", iat)
            return False

        return True

    except Exception as exc:
        logger.warning("Plaid webhook signature verification failed: %s", exc)
        return False


@router.post("/webhook")
async def plaid_webhook(
    request: Request,
    plaid_verification: str | None = Header(default=None, alias="Plaid-Verification"),
):
    """Receive and handle Plaid webhook events."""
    body_bytes = await request.body()

    if not _verify_plaid_webhook(body_bytes, plaid_verification):
        raise HTTPException(status_code=401, detail="Webhook signature verification failed")

    try:
        payload = json.loads(body_bytes)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    webhook_type = payload.get("webhook_type", "")
    webhook_code = payload.get("webhook_code", "")
    item_id = payload.get("item_id", "")

    logger.info(
        "plaid_webhook type=%s code=%s item=%s",
        webhook_type, webhook_code, item_id,
    )

    if webhook_type == "TRANSACTIONS":
        if webhook_code == "SYNC_UPDATES_AVAILABLE":
            _handle_sync_updates(item_id)

    elif webhook_type == "ITEM":
        error = payload.get("error") or {}
        error_code = error.get("error_code") if isinstance(error, dict) else ""

        if webhook_code == "ERROR" and error_code == "ITEM_LOGIN_REQUIRED":
            _handle_item_login_required(item_id)

        elif webhook_code == "PENDING_EXPIRATION":
            _handle_pending_expiration(item_id)

    # All other webhook types: log and ignore.
    return {"ok": True}


def _handle_sync_updates(item_id: str) -> None:
    """Kick off a sync for the given item. Family_id is derived from the stored item doc."""
    if not item_id:
        return
    try:
        result = plaid_service.sync_transactions(item_id)
        logger.info("webhook sync completed item=%s result=%s", item_id, result)
    except Exception:
        logger.exception("webhook sync failed for item %s", item_id)


def _handle_item_login_required(item_id: str) -> None:
    """Mark item as needs_reauth and optionally write a notification."""
    if not item_id:
        return
    db = get_firestore_client()
    snap = db.collection(plaid_service.PLAID_ITEMS_COLLECTION).document(item_id).get()
    if not snap.exists:
        return
    item_data = snap.to_dict() or {}
    family_id = item_data.get("family_id", "")
    connected_by_user_id = item_data.get("connected_by_user_id", "")
    institution_name = item_data.get("institution_name", "your bank")

    plaid_service.update_item_status(item_id, "needs_reauth")
    logger.info("Item %s marked needs_reauth", item_id)

    # Write a notification (best-effort)
    try:
        from app.models.notification import NotificationType
        from app.services.notification_service import get_notification_service

        if connected_by_user_id and family_id:
            import asyncio
            svc = get_notification_service()
            asyncio.get_event_loop().run_until_complete(
                svc.create(
                    family_id=family_id,
                    user_id=connected_by_user_id,
                    notification_type=NotificationType.SYSTEM,
                    title=f"Reconnect {institution_name}",
                    message=(
                        f"Your connection to {institution_name} needs to be renewed. "
                        "Open the app and reconnect your account to continue syncing transactions."
                    ),
                )
            )
    except Exception:
        logger.warning("Could not write ITEM_LOGIN_REQUIRED notification for item %s", item_id)


def _handle_pending_expiration(item_id: str) -> None:
    """Write a 'reconnect soon' notification for PENDING_EXPIRATION."""
    if not item_id:
        return
    db = get_firestore_client()
    snap = db.collection(plaid_service.PLAID_ITEMS_COLLECTION).document(item_id).get()
    if not snap.exists:
        return
    item_data = snap.to_dict() or {}
    family_id = item_data.get("family_id", "")
    connected_by_user_id = item_data.get("connected_by_user_id", "")
    institution_name = item_data.get("institution_name", "your bank")

    try:
        from app.models.notification import NotificationType
        from app.services.notification_service import get_notification_service

        if connected_by_user_id and family_id:
            import asyncio
            svc = get_notification_service()
            asyncio.get_event_loop().run_until_complete(
                svc.create(
                    family_id=family_id,
                    user_id=connected_by_user_id,
                    notification_type=NotificationType.SYSTEM,
                    title=f"Reconnect {institution_name} soon",
                    message=(
                        f"Your connection to {institution_name} will expire soon. "
                        "Please reconnect to keep your transactions syncing."
                    ),
                )
            )
    except Exception:
        logger.warning("Could not write PENDING_EXPIRATION notification for item %s", item_id)


# ---------------------------------------------------------------------------
# Pending transactions review
# ---------------------------------------------------------------------------


@router.get("/pending")
async def list_pending(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
):
    """Paginated list of pending transactions for the current family.

    Returns transactions from any family member's connected accounts.
    """
    family_id = _require_family_id(current_user)
    items, total = plaid_service.list_pending_transactions(
        family_id, page=page, page_size=page_size
    )
    return {
        "pending": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def _approve_pending(
    pending_id: str,
    current_user: User,
    override_amount: float | None,
    override_category: str | None,
    override_description: str | None,
    override_beneficiary: str | None,
    override_date: str | None = None,
    override_merchant: str | None = None,
    override_payment_method: str | None = None,
    override_tags: list[str] | None = None,
    is_income_override: bool = False,
    override_budget_id: str | None = None,
    save_as_rule: bool = False,
) -> dict:
    """Shared logic for approve and save-uncategorized."""
    if not current_user.family_id:
        raise HTTPException(status_code=422, detail="User must belong to a family to approve expenses")

    pending = plaid_service.get_pending_transaction(pending_id, current_user.family_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending transaction not found")

    if pending.get("status") != "pending":
        raise HTTPException(
            status_code=409, detail=f"Transaction already {pending['status']}"
        )

    amount = override_amount if override_amount is not None else pending.get("amount", 0.0)
    # Plaid amounts: positive = debit (money out). Negative = credit (money in).
    # Our expense model requires amount > 0.
    amount = abs(float(amount))
    if amount <= 0:
        raise HTTPException(status_code=422, detail="Expense amount must be positive")

    category_str = override_category or pending.get("suggested_category", "other")
    # Validate against known categories
    try:
        category = ExpenseCategory(category_str)
    except ValueError:
        category = ExpenseCategory.OTHER

    description = (
        override_description
        or pending.get("merchant_name")
        or pending.get("name")
        or "Bank transaction"
    )

    # Budget pin is authoritative for beneficiary — a budget already
    # represents the agreed split (e.g. Groceries → whole family). Without
    # this, Plaid's cardholder default leaks through and personal-filter
    # views misattribute family spending.
    beneficiary = override_beneficiary or current_user.id
    if override_budget_id:
        from app.services.budget_service import get_budget_service
        budget = await get_budget_service().get(override_budget_id, current_user.family_id)
        if budget:
            beneficiary = budget.beneficiary or ""

    # Derive payment method — user override wins; else derive from account type
    if override_payment_method:
        try:
            payment_method = PaymentMethod(override_payment_method)
        except ValueError:
            payment_method = PaymentMethod.CREDIT
    else:
        acct_info = _get_account_info(current_user.family_id, pending.get("account_id", ""))
        payment_method_str = _payment_method_from_account_type(acct_info.get("type"))
        try:
            payment_method = PaymentMethod(payment_method_str)
        except ValueError:
            payment_method = PaymentMethod.CREDIT

    # Parse date — user override wins; else use Plaid-supplied date
    if override_date:
        try:
            txn_date = date.fromisoformat(override_date)
        except (ValueError, TypeError):
            txn_date = date.today()
    else:
        date_str = pending.get("date") or pending.get("authorized_date")
        try:
            txn_date = date.fromisoformat(str(date_str)) if date_str else date.today()
        except (ValueError, TypeError):
            txn_date = date.today()

    # Merchant — user override wins; else use Plaid-supplied merchant_name
    merchant = override_merchant if override_merchant is not None else pending.get("merchant_name")

    tags = override_tags if override_tags is not None else []

    expense_create = ExpenseCreate(
        amount=amount,
        currency=pending.get("iso_currency_code") or "USD",
        date=txn_date,
        description=description,
        merchant=merchant,
        payment_method=payment_method,
        category=category,
        beneficiary=beneficiary,
        tags=tags,
        budget_id=override_budget_id or None,
    )

    svc = get_expense_service()
    expense = await svc.create(expense_create, current_user)

    # Store extra Plaid metadata on the expense doc (non-model fields, set directly)
    try:
        db = get_firestore_client()
        extra: dict[str, Any] = {
            "source": "plaid",
            "plaid_transaction_id": pending.get("plaid_transaction_id"),
        }
        # Forward-looking: tag income approvals so future income tab work is correct.
        if is_income_override:
            extra["is_income"] = True
        db.collection("expenses").document(expense.id).update(extra)
    except Exception:
        logger.warning("Could not write plaid metadata onto expense %s", expense.id)

    # Optionally save a merchant rule for future auto-categorisation
    if save_as_rule and not is_income_override:
        merchant_for_rule = (
            override_merchant
            if override_merchant is not None
            else pending.get("merchant_name")
        )
        if merchant_for_rule:
            try:
                from app.services import rule_service as _rule_svc
                _rule_svc.create(
                    family_id=current_user.family_id,
                    user_id=current_user.id,
                    merchant_name=merchant_for_rule,
                    category=category.value,
                    budget_id=override_budget_id or None,
                    beneficiary=beneficiary if beneficiary != current_user.id else None,
                )
            except Exception:
                logger.warning("Could not save merchant rule for %s", merchant_for_rule)

    # Mark pending as approved (record who approved it for audit)
    plaid_service.update_pending_status(
        pending_id,
        status="approved",
        expense_id=expense.id,
        actor_user_id=current_user.id,
    )

    return {"expense": expense.model_dump(mode="json")}


@router.post("/pending/{pending_id}/approve")
async def approve_pending(
    pending_id: str,
    body: ApproveRequest = ApproveRequest(),
    current_user: User = Depends(get_current_user),
):
    """Approve a pending transaction, creating an expense."""
    return await _approve_pending(
        pending_id,
        current_user,
        override_amount=body.amount,
        override_category=body.category,
        override_description=body.description,
        override_beneficiary=body.beneficiary,
        override_date=body.date,
        override_merchant=body.merchant,
        override_payment_method=body.payment_method,
        override_tags=body.tags,
        is_income_override=body.is_income_override,
        override_budget_id=body.budget_id,
        save_as_rule=body.save_as_rule,
    )


@router.post("/pending/{pending_id}/discard")
async def discard_pending(
    pending_id: str,
    current_user: User = Depends(get_current_user),
):
    """Discard a pending transaction (no expense created)."""
    if not current_user.family_id:
        raise HTTPException(status_code=400, detail="User must belong to a family to use bank features")

    pending = plaid_service.get_pending_transaction(pending_id, current_user.family_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending transaction not found")

    if pending.get("status") != "pending":
        raise HTTPException(
            status_code=409, detail=f"Transaction already {pending['status']}"
        )

    plaid_service.update_pending_status(
        pending_id,
        status="discarded",
        actor_user_id=current_user.id,
    )
    return {"ok": True, "discarded": pending_id}


@router.post("/pending/{pending_id}/save-uncategorized")
async def save_uncategorized(
    pending_id: str,
    current_user: User = Depends(get_current_user),
):
    """Approve a pending transaction with category=other (no body required)."""
    return await _approve_pending(
        pending_id,
        current_user,
        override_amount=None,
        override_category="other",
        override_description=None,
        override_beneficiary=None,
    )


# ---------------------------------------------------------------------------
# Split-approve endpoint
# ---------------------------------------------------------------------------


class SplitItem(BaseModel):
    amount: float
    category: Optional[str] = None
    budget_id: Optional[str] = None
    beneficiary: Optional[str] = None


class ApproveSplitRequest(BaseModel):
    splits: list[SplitItem]
    merchant: Optional[str] = None
    date: Optional[str] = None
    payment_method: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None


@router.post("/pending/{pending_id}/approve-split")
async def approve_split(
    pending_id: str,
    body: ApproveSplitRequest,
    current_user: User = Depends(get_current_user),
):
    """Split a pending transaction into N expense rows (N >= 2).

    Each split carries its own amount, category, budget_id, and beneficiary.
    Top-level merchant, date, payment_method, description, and tags are shared
    across all splits.

    Validation:
    - At least 2 splits required (use /approve for a single expense).
    - sum(splits[].amount) must equal pending.amount within $0.01.
    - pending.status must be "pending" (409 if already approved/discarded).
    - pending must belong to the calling user's family (404 otherwise).
    """
    from app.models.expense import ExpenseCategory, ExpenseCreate, PaymentMethod

    family_id = _require_family_id(current_user)

    # --- Validate split count ---
    if len(body.splits) < 2:
        raise HTTPException(
            status_code=400,
            detail="At least 2 splits are required. Use /approve for a single expense.",
        )

    # --- Load pending ---
    pending = plaid_service.get_pending_transaction(pending_id, family_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending transaction not found")

    if pending.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Transaction already {pending['status']}",
        )

    # --- Validate amounts sum ---
    pending_amount = abs(float(pending.get("amount", 0.0)))
    split_total = sum(abs(float(s.amount)) for s in body.splits)
    if abs(split_total - pending_amount) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Split amounts sum to {split_total:.2f} but pending amount is "
                f"{pending_amount:.2f} (tolerance $0.01)."
            ),
        )

    # --- Resolve shared fields ---
    currency = pending.get("iso_currency_code") or "USD"
    tags = body.tags or []

    if body.payment_method:
        try:
            payment_method = PaymentMethod(body.payment_method)
        except ValueError:
            payment_method = PaymentMethod.CREDIT
    else:
        acct_info = _get_account_info(family_id, pending.get("account_id", ""))
        pm_str = _payment_method_from_account_type(acct_info.get("type"))
        try:
            payment_method = PaymentMethod(pm_str)
        except ValueError:
            payment_method = PaymentMethod.CREDIT

    if body.date:
        try:
            from datetime import date as _date
            txn_date = _date.fromisoformat(body.date)
        except (ValueError, TypeError):
            from datetime import date as _date
            txn_date = _date.today()
    else:
        date_str = pending.get("date") or pending.get("authorized_date")
        try:
            from datetime import date as _date
            txn_date = _date.fromisoformat(str(date_str)) if date_str else _date.today()
        except (ValueError, TypeError):
            from datetime import date as _date
            txn_date = _date.today()

    merchant = body.merchant if body.merchant is not None else pending.get("merchant_name")
    description_base = (
        body.description
        or pending.get("merchant_name")
        or pending.get("name")
        or "Bank transaction"
    )

    # --- Create one expense per split ---
    svc = get_expense_service()
    expense_ids: list[str] = []

    for split in body.splits:
        split_amount = abs(float(split.amount))

        category_str = split.category or "other"
        try:
            category = ExpenseCategory(category_str)
        except ValueError:
            category = ExpenseCategory.OTHER

        beneficiary = split.beneficiary or current_user.id
        if split.budget_id:
            from app.services.budget_service import get_budget_service
            split_budget = await get_budget_service().get(split.budget_id, current_user.family_id)
            if split_budget:
                beneficiary = split_budget.beneficiary or ""

        expense_create = ExpenseCreate(
            amount=split_amount,
            currency=currency,
            date=txn_date,
            description=description_base,
            merchant=merchant,
            payment_method=payment_method,
            category=category,
            beneficiary=beneficiary,
            tags=tags,
            budget_id=split.budget_id or None,
        )

        expense = await svc.create(expense_create, current_user)
        expense_ids.append(expense.id)

        # Tag the expense with source metadata (best-effort)
        try:
            db = get_firestore_client()
            db.collection("expenses").document(expense.id).update({
                "source": "plaid_split",
                "plaid_transaction_id": pending.get("plaid_transaction_id"),
            })
        except Exception:
            logger.warning("Could not write plaid_split metadata onto expense %s", expense.id)

    # --- Mark pending as approved with all expense IDs ---
    plaid_service.update_pending_status(
        pending_id,
        status="approved",
        expense_ids=expense_ids,
        actor_user_id=current_user.id,
    )

    # --- Side-effect: budget status (best-effort, must not 500 the response) ---
    try:
        from app.services.budget_service import get_budget_service
        budget_svc = get_budget_service()
        await budget_svc.check_budget_alerts(family_id)
    except Exception:
        pass

    logger.info(
        "approve_split pending=%s splits=%d expense_ids=%s user=%s family=%s",
        pending_id, len(expense_ids), expense_ids, current_user.id, family_id,
    )

    return {"expense_ids": expense_ids, "pending_id": pending_id}


# ---------------------------------------------------------------------------
# Sandbox / test-only endpoints — 404 in production
# ---------------------------------------------------------------------------


def _assert_non_prod():
    """Raise 404 if running in production so these endpoints are never exposed."""
    if settings.environment.lower() in ("production", "prod"):
        raise HTTPException(status_code=404, detail="Not found")


@router.post("/_test/sandbox-connect")
async def sandbox_connect(
    current_user: User = Depends(get_current_user),
):
    """Bypass the Plaid Link iframe: connect First Platypus Bank in sandbox and sync transactions.

    ONLY available when environment != production.  Returns 404 in prod.
    Call this from E2E tests instead of driving the Plaid Link UI.

    Returns: {plaid_item_id, accounts_count, pending_count}
    """
    _assert_non_prod()

    from plaid.model.sandbox_public_token_create_request import SandboxPublicTokenCreateRequest  # type: ignore
    from plaid.model.products import Products  # type: ignore
    from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest  # type: ignore
    from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest  # type: ignore
    from plaid.model.accounts_get_request import AccountsGetRequest  # type: ignore
    from plaid.model.country_code import CountryCode  # type: ignore

    family_id = _require_family_id(current_user)
    client = _plaid_client()

    logger.info(
        "sandbox_connect called user_id=%s family_id=%s",
        current_user.id,
        family_id,
    )

    # 1. Create sandbox public token for First Platypus Bank
    try:
        sandbox_resp = client.sandbox_public_token_create(
            SandboxPublicTokenCreateRequest(
                institution_id="ins_109508",
                initial_products=[Products("transactions")],
            )
        )
    except Exception as exc:
        logger.exception("sandbox_public_token_create failed")
        raise HTTPException(status_code=502, detail=f"Plaid sandbox error: {exc}")

    sandbox_data = sandbox_resp.to_dict() if hasattr(sandbox_resp, "to_dict") else sandbox_resp
    public_token: str = sandbox_data["public_token"]

    # 2. Exchange public token for access token
    try:
        exchange_resp = client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=public_token)
        )
    except Exception as exc:
        logger.exception("item_public_token_exchange failed in sandbox_connect")
        raise HTTPException(status_code=502, detail=f"Plaid error: {exc}")

    exchange_data = exchange_resp.to_dict() if hasattr(exchange_resp, "to_dict") else exchange_resp
    access_token: str = exchange_data["access_token"]
    plaid_item_id: str = exchange_data["item_id"]

    # 3. Fetch institution details
    institution_id = "ins_109508"
    institution_name = "First Platypus Bank"
    try:
        inst_resp = client.institutions_get_by_id(
            InstitutionsGetByIdRequest(
                institution_id=institution_id,
                country_codes=[CountryCode("US")],
            )
        )
        inst_data = inst_resp.to_dict() if hasattr(inst_resp, "to_dict") else inst_resp
        institution_name = (inst_data.get("institution") or {}).get("name", institution_name)
    except Exception:
        logger.warning("Could not fetch institution name for sandbox item %s", plaid_item_id)

    # 4. Fetch accounts
    raw_accounts: list[dict] = []
    try:
        accts_resp = client.accounts_get(AccountsGetRequest(access_token=access_token))
        accts_data = accts_resp.to_dict() if hasattr(accts_resp, "to_dict") else accts_resp
        raw_accounts = accts_data.get("accounts") or []
    except Exception:
        logger.warning("Could not fetch accounts for sandbox item %s", plaid_item_id)

    # 5. Upsert accounts + item (family-scoped)
    plaid_service.upsert_accounts(
        plaid_item_id,
        family_id,
        raw_accounts,
        connected_by_user_id=current_user.id,
    )
    plaid_service.upsert_item(
        plaid_item_id=plaid_item_id,
        family_id=family_id,
        connected_by_user_id=current_user.id,
        plaid_access_token=access_token,
        institution_id=institution_id,
        institution_name=institution_name,
        cursor=None,
        status="active",
    )

    # 6. Sync transactions (with retry) so pending rows appear immediately.
    # Plaid Sandbox sometimes takes a moment to seed historical transactions after
    # a new item is created. We retry up to 3 times with a short sleep between
    # attempts so E2E tests reliably see > 0 pending rows.
    import asyncio as _asyncio

    sync_result: dict = {}
    total_added = 0
    for attempt in range(3):
        try:
            sync_result = plaid_service.sync_transactions(plaid_item_id)
            total_added = sync_result.get("added", 0)
            logger.info(
                "sandbox sync attempt=%d item=%s added=%d",
                attempt + 1,
                plaid_item_id,
                total_added,
            )
            if total_added > 0:
                break
            # Wait before retrying — Plaid Sandbox may need time to seed transactions
            await _asyncio.sleep(2)
        except Exception:
            logger.warning(
                "sandbox sync attempt=%d failed for item %s",
                attempt + 1,
                plaid_item_id,
            )
            await _asyncio.sleep(1)

    pending_count = total_added

    logger.info(
        "sandbox_connect complete user_id=%s family_id=%s item=%s accounts=%d pending=%d",
        current_user.id,
        family_id,
        plaid_item_id,
        len(raw_accounts),
        pending_count,
    )

    return {
        "plaid_item_id": plaid_item_id,
        "accounts_count": len(raw_accounts),
        "pending_count": pending_count,
    }


@router.post("/_test/reset")
async def sandbox_reset(
    current_user: User = Depends(get_current_user),
):
    """Delete all Plaid items, accounts, and pending transactions for the calling user's family.

    ONLY available when environment != production.  Returns 404 in prod.
    Call this in test globalSetup / afterEach to start from a clean slate.

    Returns: {deleted_items, deleted_pending}
    """
    _assert_non_prod()

    family_id = _require_family_id(current_user)
    db = get_firestore_client()

    logger.info(
        "sandbox_reset called user_id=%s family_id=%s",
        current_user.id,
        family_id,
    )

    from google.cloud import firestore as _fs  # type: ignore

    # Collect item IDs for this family
    item_snaps = list(
        db.collection(plaid_service.PLAID_ITEMS_COLLECTION)
        .where(filter=_fs.FieldFilter("family_id", "==", family_id))
        .stream()
    )
    deleted_items = 0
    for snap in item_snaps:
        item_id = snap.id
        plaid_service.delete_pending_transactions_for_item(item_id)
        plaid_service.delete_item(item_id, family_id)
        deleted_items += 1

    # Any orphaned pending rows (item deleted mid-test, etc.)
    orphan_snaps = list(
        db.collection(plaid_service.PLAID_PENDING_COLLECTION)
        .where(filter=_fs.FieldFilter("family_id", "==", family_id))
        .stream()
    )
    deleted_pending = 0
    if orphan_snaps:
        batch = db.batch()
        for snap in orphan_snaps:
            batch.delete(snap.reference)
            deleted_pending += 1
        batch.commit()

    logger.info(
        "sandbox_reset complete user_id=%s family_id=%s deleted_items=%d deleted_pending=%d",
        current_user.id,
        family_id,
        deleted_items,
        deleted_pending,
    )

    return {"deleted_items": deleted_items, "deleted_pending": deleted_pending}
