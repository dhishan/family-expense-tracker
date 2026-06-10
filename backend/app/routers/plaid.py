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

import hashlib
import json
import logging
import time
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel

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

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class LinkTokenRequest(BaseModel):
    products: list[str] = ["transactions"]
    country_codes: list[str] = ["US"]


class ExchangeRequest(BaseModel):
    public_token: str


class PatchItemRequest(BaseModel):
    institution_name: Optional[str] = None


class ApproveRequest(BaseModel):
    amount: Optional[float] = None
    category: Optional[str] = None
    description: Optional[str] = None
    beneficiary: Optional[str] = None


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

    req = LinkTokenCreateRequest(
        user=LinkTokenCreateRequestUser(client_user_id=current_user.id),
        client_name="Family Expense Tracker",
        products=products,
        country_codes=country_codes,
        language="en",
        webhook=WEBHOOK_URL,
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

    # 5. Trigger initial sync (best-effort)
    try:
        plaid_service.sync_transactions(plaid_item_id)
    except Exception:
        logger.warning("Initial sync failed for item %s — will retry via webhook", plaid_item_id)

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

    beneficiary = override_beneficiary or current_user.id

    # Derive payment method from account type (family-scoped lookup)
    acct_info = _get_account_info(current_user.family_id, pending.get("account_id", ""))
    payment_method_str = _payment_method_from_account_type(acct_info.get("type"))
    try:
        payment_method = PaymentMethod(payment_method_str)
    except ValueError:
        payment_method = PaymentMethod.CREDIT

    # Parse date
    date_str = pending.get("date") or pending.get("authorized_date")
    try:
        txn_date = date.fromisoformat(str(date_str)) if date_str else date.today()
    except (ValueError, TypeError):
        txn_date = date.today()

    expense_create = ExpenseCreate(
        amount=amount,
        currency=pending.get("iso_currency_code") or "USD",
        date=txn_date,
        description=description,
        merchant=pending.get("merchant_name"),
        payment_method=payment_method,
        category=category,
        beneficiary=beneficiary,
        tags=[],
    )

    svc = get_expense_service()
    expense = await svc.create(expense_create, current_user)

    # Store extra Plaid metadata on the expense doc (non-model fields, set directly)
    try:
        db = get_firestore_client()
        db.collection("expenses").document(expense.id).update({
            "source": "plaid",
            "plaid_transaction_id": pending.get("plaid_transaction_id"),
        })
    except Exception:
        logger.warning("Could not write plaid metadata onto expense %s", expense.id)

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
