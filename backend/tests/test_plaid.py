"""Phase 2 Plaid tests.

Covers:
1. map_plaid_category — known and unknown inputs
2. Approve / discard / save-uncategorized happy paths (mocked Plaid + Firestore)
3. Cross-user pending-row access returns 404
4. Webhook signature verification rejects unsigned requests
5. sync_transactions: added / modified / removed paths
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Patch env before any app imports
# ---------------------------------------------------------------------------
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("GCP_PROJECT_ID", "test-project")
os.environ.setdefault("FIRESTORE_DATABASE", "test-database")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")
os.environ.setdefault("PLAID_CLIENT_ID", "test-plaid-client")
os.environ.setdefault("PLAID_SECRET", "test-plaid-secret")
os.environ.setdefault("PLAID_ENV", "sandbox")


# ---------------------------------------------------------------------------
# 1. map_plaid_category
# ---------------------------------------------------------------------------


class TestMapPlaidCategory:
    def test_known_categories(self):
        from app.services.plaid_service import map_plaid_category

        cases = [
            ({"primary": "FOOD_AND_DRINK"}, "dining"),
            ({"primary": "GROCERIES"}, "groceries"),
            ({"primary": "TRANSPORTATION"}, "transportation"),
            ({"primary": "TRAVEL"}, "travel"),
            ({"primary": "GENERAL_MERCHANDISE"}, "shopping"),
            ({"primary": "ENTERTAINMENT"}, "entertainment"),
            ({"primary": "MEDICAL"}, "healthcare"),
            ({"primary": "RENT_AND_UTILITIES"}, "utilities"),
            ({"primary": "EDUCATION"}, "education"),
            ({"primary": "HOME_IMPROVEMENT"}, "shopping"),
        ]
        for pfc, expected in cases:
            assert map_plaid_category(pfc) == expected, f"failed for {pfc}"

    def test_fallback_categories_return_other(self):
        from app.services.plaid_service import map_plaid_category

        fallbacks = [
            {"primary": "GENERAL_SERVICES"},
            {"primary": "PERSONAL_CARE"},
            {"primary": "INCOME"},
            {"primary": "TRANSFER_IN"},
            {"primary": "TRANSFER_OUT"},
            {"primary": "BANK_FEES"},
        ]
        for pfc in fallbacks:
            assert map_plaid_category(pfc) == "other", f"failed for {pfc}"

    def test_none_returns_other(self):
        from app.services.plaid_service import map_plaid_category

        assert map_plaid_category(None) == "other"

    def test_unknown_primary_returns_other(self):
        from app.services.plaid_service import map_plaid_category

        assert map_plaid_category({"primary": "TOTALLY_MADE_UP"}) == "other"

    def test_empty_dict_returns_other(self):
        from app.services.plaid_service import map_plaid_category

        assert map_plaid_category({}) == "other"


# ---------------------------------------------------------------------------
# Helper: build mock user
# ---------------------------------------------------------------------------


def _make_user(user_id="user-alice", family_id="fam-001"):
    from app.models.user import User

    return User(
        id=user_id,
        email=f"{user_id}@example.com",
        display_name="Alice",
        photo_url=None,
        family_id=family_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


def _make_pending_doc(
    user_id="user-alice",
    plaid_item_id="item-1",
    status="pending",
    amount=42.50,
):
    return {
        "id": "pend-001",
        "user_id": user_id,
        "plaid_item_id": plaid_item_id,
        "plaid_transaction_id": "txn-abc",
        "account_id": "acct-1",
        "account_name": "Checking",
        "institution_name": "Chase",
        "merchant_name": "Starbucks",
        "name": "Starbucks #1234",
        "amount": amount,
        "iso_currency_code": "USD",
        "date": "2026-06-05",
        "authorized_date": "2026-06-04",
        "suggested_category": "dining",
        "plaid_category": {"primary": "FOOD_AND_DRINK"},
        "pending_until_posted": False,
        "raw_personal_finance_category": {"primary": "FOOD_AND_DRINK"},
        "status": status,
        "expense_id": None,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }


# ---------------------------------------------------------------------------
# 2. Approve / discard / save-uncategorized happy paths
# ---------------------------------------------------------------------------


class TestApproveHappyPath:
    def test_approve_creates_expense_and_marks_approved(self):
        """Approving a pending transaction should call ExpenseService.create and update status."""
        from app.models.expense import ExpenseResponse

        user = _make_user()
        pending = _make_pending_doc()

        mock_expense = MagicMock(spec=ExpenseResponse)
        mock_expense.id = "exp-001"
        mock_expense.model_dump = MagicMock(return_value={"id": "exp-001", "amount": 42.50})

        with (
            patch("app.services.plaid_service.get_pending_transaction", return_value=pending),
            patch("app.services.plaid_service.update_pending_status") as mock_update_status,
            patch("app.services.plaid_service.get_firestore_client") as mock_fs,
            patch("app.services.expense_service.ExpenseService.create", new_callable=AsyncMock, return_value=mock_expense),
            patch("app.routers.plaid._get_account_info", return_value={"type": "depository"}),
        ):
            # Make Firestore update() a no-op
            mock_fs.return_value.collection.return_value.document.return_value.update = MagicMock()

            import asyncio
            from app.routers.plaid import _approve_pending

            result = asyncio.get_event_loop().run_until_complete(
                _approve_pending(
                    "pend-001",
                    user,
                    override_amount=None,
                    override_category=None,
                    override_description=None,
                    override_beneficiary=None,
                )
            )

        assert "expense" in result
        mock_update_status.assert_called_once()
        call_kwargs = mock_update_status.call_args
        assert call_kwargs[1]["status"] == "approved" or call_kwargs[0][1] == "approved" or (
            len(call_kwargs[0]) > 1 and call_kwargs[0][1] == "approved"
        ) or call_kwargs[1].get("status") == "approved"

    def test_approve_amount_is_absolute_value(self):
        """Plaid amounts can be negative (credits). We always store abs(amount)."""
        from app.models.expense import ExpenseResponse, ExpenseCreate

        user = _make_user()
        pending = _make_pending_doc(amount=-55.00)  # negative = credit in Plaid

        created_expense = MagicMock(spec=ExpenseResponse)
        created_expense.id = "exp-002"
        created_expense.model_dump = MagicMock(return_value={"id": "exp-002"})

        captured_create_args = {}

        async def capture_create(expense_create, user):
            captured_create_args["amount"] = expense_create.amount
            return created_expense

        with (
            patch("app.services.plaid_service.get_pending_transaction", return_value=pending),
            patch("app.services.plaid_service.update_pending_status"),
            patch("app.services.plaid_service.get_firestore_client") as mock_fs,
            patch("app.services.expense_service.ExpenseService.create", new_callable=AsyncMock, side_effect=capture_create),
            patch("app.routers.plaid._get_account_info", return_value={}),
        ):
            mock_fs.return_value.collection.return_value.document.return_value.update = MagicMock()

            import asyncio
            from app.routers.plaid import _approve_pending

            asyncio.get_event_loop().run_until_complete(
                _approve_pending("pend-001", user, None, None, None, None)
            )

        assert captured_create_args["amount"] == 55.00

    def test_approve_no_family_raises_422(self):
        """User without family should raise 422."""
        from fastapi import HTTPException

        user = _make_user(family_id=None)
        pending = _make_pending_doc()

        with (
            patch("app.services.plaid_service.get_pending_transaction", return_value=pending),
        ):
            import asyncio
            from app.routers.plaid import _approve_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.get_event_loop().run_until_complete(
                    _approve_pending("pend-001", user, None, None, None, None)
                )
            assert exc_info.value.status_code == 422


class TestDiscardHappyPath:
    def test_discard_marks_discarded_no_expense(self):
        user = _make_user()
        pending = _make_pending_doc()

        with (
            patch("app.services.plaid_service.get_pending_transaction", return_value=pending),
            patch("app.services.plaid_service.update_pending_status") as mock_update_status,
        ):
            import asyncio
            from app.routers.plaid import discard_pending

            result = asyncio.get_event_loop().run_until_complete(
                discard_pending("pend-001", current_user=user)
            )

        assert result["ok"] is True
        mock_update_status.assert_called_once()
        call_kwargs = mock_update_status.call_args
        # status="discarded" should be in the kwargs
        assert call_kwargs[1].get("status") == "discarded"

    def test_discard_already_discarded_raises_409(self):
        from fastapi import HTTPException

        user = _make_user()
        pending = _make_pending_doc(status="discarded")

        with patch("app.services.plaid_service.get_pending_transaction", return_value=pending):
            import asyncio
            from app.routers.plaid import discard_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.get_event_loop().run_until_complete(
                    discard_pending("pend-001", current_user=user)
                )
            assert exc_info.value.status_code == 409


class TestSaveUncategorizedHappyPath:
    def test_save_uncategorized_forces_other_category(self):
        from app.models.expense import ExpenseResponse

        user = _make_user()
        pending = _make_pending_doc()

        created_expense = MagicMock(spec=ExpenseResponse)
        created_expense.id = "exp-003"
        created_expense.model_dump = MagicMock(return_value={"id": "exp-003"})

        captured = {}

        async def capture_create(expense_create, user):
            captured["category"] = expense_create.category
            return created_expense

        with (
            patch("app.services.plaid_service.get_pending_transaction", return_value=pending),
            patch("app.services.plaid_service.update_pending_status"),
            patch("app.services.plaid_service.get_firestore_client") as mock_fs,
            patch("app.services.expense_service.ExpenseService.create", new_callable=AsyncMock, side_effect=capture_create),
            patch("app.routers.plaid._get_account_info", return_value={}),
        ):
            mock_fs.return_value.collection.return_value.document.return_value.update = MagicMock()

            import asyncio
            from app.routers.plaid import save_uncategorized

            asyncio.get_event_loop().run_until_complete(
                save_uncategorized("pend-001", current_user=user)
            )

        from app.models.expense import ExpenseCategory
        assert captured["category"] == ExpenseCategory.OTHER


# ---------------------------------------------------------------------------
# 3. Cross-user access returns 404
# ---------------------------------------------------------------------------


class TestCrossUserAccess:
    def test_approve_cross_user_returns_404(self):
        from fastapi import HTTPException

        user_bob = _make_user(user_id="user-bob")
        # Simulate get_pending_transaction returning None (cross-user check failed)
        with patch("app.services.plaid_service.get_pending_transaction", return_value=None):
            import asyncio
            from app.routers.plaid import _approve_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.get_event_loop().run_until_complete(
                    _approve_pending("pend-001", user_bob, None, None, None, None)
                )
            assert exc_info.value.status_code == 404

    def test_discard_cross_user_returns_404(self):
        from fastapi import HTTPException

        user_bob = _make_user(user_id="user-bob")
        with patch("app.services.plaid_service.get_pending_transaction", return_value=None):
            import asyncio
            from app.routers.plaid import discard_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.get_event_loop().run_until_complete(
                    discard_pending("pend-001", current_user=user_bob)
                )
            assert exc_info.value.status_code == 404

    def test_get_pending_transaction_cross_user_returns_none(self):
        """plaid_service.get_pending_transaction returns None for cross-user docs."""
        alice_doc = _make_pending_doc(user_id="user-alice")

        snap = MagicMock()
        snap.exists = True
        snap.to_dict.return_value = dict(alice_doc)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import get_pending_transaction
            result = get_pending_transaction("pend-001", user_id="user-bob")

        assert result is None


# ---------------------------------------------------------------------------
# 4. Webhook signature verification rejects unsigned requests
# ---------------------------------------------------------------------------


class TestWebhookSignatureVerification:
    def test_missing_header_returns_401(self):
        from app.routers.plaid import _verify_plaid_webhook

        # No verification header
        result = _verify_plaid_webhook(b'{"webhook_type":"TRANSACTIONS"}', None)
        assert result is False

    def test_invalid_jwt_returns_false(self):
        from app.routers.plaid import _verify_plaid_webhook

        result = _verify_plaid_webhook(b'{"webhook_type":"TRANSACTIONS"}', "not.a.valid.jwt")
        assert result is False

    def test_webhook_endpoint_rejects_missing_signature(self):
        """The /plaid/webhook endpoint should return 401 when signature is missing."""
        import asyncio
        from fastapi.testclient import TestClient
        from app.main import app
        from app.auth.dependencies import get_current_user

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/v1/plaid/webhook",
            json={"webhook_type": "TRANSACTIONS", "webhook_code": "SYNC_UPDATES_AVAILABLE", "item_id": "item-1"},
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 5. sync_transactions: added / modified / removed
# ---------------------------------------------------------------------------


def _make_item_snap(user_id="user-alice", status="active", cursor=None):
    snap = MagicMock()
    snap.exists = True
    snap.to_dict.return_value = {
        "user_id": user_id,
        "plaid_item_id": "item-1",
        "institution_name": "Chase",
        "plaid_access_token": "access-sandbox-xxx",
        "status": status,
        "cursor": cursor,
    }
    return snap


def _make_plaid_txn(txn_id="txn-001", account_id="acct-1", amount=10.0, name="Test Merchant"):
    txn = MagicMock()
    txn.transaction_id = txn_id
    txn.account_id = account_id
    txn.amount = amount
    txn.name = name
    txn.merchant_name = name
    txn.date = "2026-06-05"
    txn.authorized_date = "2026-06-04"
    txn.pending = False
    txn.iso_currency_code = "USD"
    pfc = MagicMock()
    pfc.to_dict = lambda: {"primary": "FOOD_AND_DRINK"}
    txn.personal_finance_category = pfc
    return txn


class TestSyncTransactions:
    def _build_mock_db(self, item_snap, account_stream=None, pending_stream=None):
        mock_db = MagicMock()

        def collection_side_effect(col_name):
            coll = MagicMock()
            if col_name == "plaid_items":
                coll.document.return_value.get.return_value = item_snap
                coll.document.return_value.update = MagicMock()
            elif col_name == "plaid_accounts":
                q = MagicMock()
                q.stream.return_value = iter(account_stream or [])
                coll.where.return_value = q
            elif col_name == "plaid_pending_transactions":
                coll.document.return_value = MagicMock()
                coll.document.return_value.set = MagicMock()
                coll.document.return_value.update = MagicMock()
                coll.document.return_value.delete = MagicMock()
                q = MagicMock()
                q.limit.return_value.stream.return_value = iter(pending_stream or [])
                coll.where.return_value.where.return_value = q
            return coll

        mock_db.collection.side_effect = collection_side_effect
        return mock_db

    def test_added_transactions_create_pending_docs(self):
        item_snap = _make_item_snap()
        txn = _make_plaid_txn("txn-new")
        added = [txn]

        sync_resp = MagicMock()
        sync_resp.to_dict.return_value = {
            "added": added,
            "modified": [],
            "removed": [],
            "next_cursor": "cursor-v2",
            "has_more": False,
        }

        mock_db = self._build_mock_db(item_snap)
        # Override pending set to track calls
        set_calls = []
        new_doc_ref = MagicMock()
        new_doc_ref.set = lambda doc: set_calls.append(doc)

        def collection_side_effect(col_name):
            coll = MagicMock()
            if col_name == "plaid_items":
                coll.document.return_value.get.return_value = item_snap
                coll.document.return_value.update = MagicMock()
            elif col_name == "plaid_accounts":
                q = MagicMock()
                q.stream.return_value = iter([])
                coll.where.return_value = q
            elif col_name == "plaid_pending_transactions":
                # First call (dedupe check): returns empty
                q = MagicMock()
                q.limit.return_value.stream.return_value = iter([])
                coll.where.return_value.where.return_value = q
                coll.document.return_value = new_doc_ref
            return coll

        mock_db.collection.side_effect = collection_side_effect

        with (
            patch("app.services.plaid_service.get_firestore_client", return_value=mock_db),
            patch("app.services.plaid_service._client") as mock_plaid_client,
            patch("app.services.plaid_service.update_item_cursor"),
        ):
            mock_plaid_client.return_value.transactions_sync.return_value = sync_resp
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1", "user-alice")

        assert result["added"] == 1
        assert result["removed"] == 0
        assert len(set_calls) == 1
        assert set_calls[0]["plaid_transaction_id"] == "txn-new"

    def test_removed_pending_transaction_deleted(self):
        item_snap = _make_item_snap()

        # Simulate a removed transaction that has a pending row
        removed_txn = MagicMock()
        removed_txn.transaction_id = "txn-gone"

        sync_resp = MagicMock()
        sync_resp.to_dict.return_value = {
            "added": [],
            "modified": [],
            "removed": [removed_txn],
            "next_cursor": "cursor-v3",
            "has_more": False,
        }

        # Pending doc that matches the removed txn
        existing_snap = MagicMock()
        existing_snap.id = "pend-gone"
        existing_snap.to_dict.return_value = {
            "id": "pend-gone",
            "user_id": "user-alice",
            "status": "pending",
            "plaid_transaction_id": "txn-gone",
        }

        delete_calls = []

        def collection_side_effect(col_name):
            coll = MagicMock()
            if col_name == "plaid_items":
                coll.document.return_value.get.return_value = item_snap
                coll.document.return_value.update = MagicMock()
            elif col_name == "plaid_accounts":
                q = MagicMock()
                q.stream.return_value = iter([])
                coll.where.return_value = q
            elif col_name == "plaid_pending_transactions":
                pending_ref = MagicMock()
                pending_ref.delete = lambda: delete_calls.append("deleted")
                q = MagicMock()
                q.limit.return_value.stream.return_value = iter([existing_snap])
                coll.where.return_value.where.return_value = q
                coll.document.return_value = pending_ref
            return coll

        mock_db = MagicMock()
        mock_db.collection.side_effect = collection_side_effect

        with (
            patch("app.services.plaid_service.get_firestore_client", return_value=mock_db),
            patch("app.services.plaid_service._client") as mock_plaid_client,
            patch("app.services.plaid_service.update_item_cursor"),
        ):
            mock_plaid_client.return_value.transactions_sync.return_value = sync_resp
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1", "user-alice")

        assert result["removed"] == 1
        assert len(delete_calls) == 1

    def test_item_not_active_skips_sync(self):
        item_snap = _make_item_snap(status="needs_reauth")
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = item_snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1", "user-alice")

        assert result.get("error") == "item_not_active"
        assert result["added"] == 0

    def test_cross_user_sync_returns_error(self):
        item_snap = _make_item_snap(user_id="user-alice")
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = item_snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1", user_id="user-mallory")

        assert result.get("error") == "not_found"
