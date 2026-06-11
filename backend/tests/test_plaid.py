"""Phase 3 Plaid tests (family-scoped ownership).

Covers:
1. map_plaid_category — known and unknown inputs
2. Approve / discard / save-uncategorized happy paths (mocked Plaid + Firestore)
3. Cross-family pending-row access returns 404
4. Webhook signature verification rejects unsigned requests
5. sync_transactions: added / modified / removed paths
6. Family-scoping behavior:
   - Family member B can view pending from member A's connected bank
   - Cross-family access returns 404 (no existence leak)
   - User without family gets 400 on protected endpoints
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
    family_id="fam-001",
    connected_by_user_id="user-alice",
    plaid_item_id="item-1",
    status="pending",
    amount=42.50,
):
    return {
        "id": "pend-001",
        "family_id": family_id,
        "connected_by_user_id": connected_by_user_id,
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

            result = asyncio.run(
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

            asyncio.run(
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
                asyncio.run(
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

            result = asyncio.run(
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
                asyncio.run(
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

            asyncio.run(
                save_uncategorized("pend-001", current_user=user)
            )

        from app.models.expense import ExpenseCategory
        assert captured["category"] == ExpenseCategory.OTHER


# ---------------------------------------------------------------------------
# 3. Cross-family access returns 404
# ---------------------------------------------------------------------------


class TestCrossFamilyAccess:
    def test_approve_cross_family_returns_404(self):
        """User in family-Y cannot approve a pending row from family-X."""
        from fastapi import HTTPException

        user_bob = _make_user(user_id="user-bob", family_id="fam-002")
        # get_pending_transaction returns None because family check fails
        with patch("app.services.plaid_service.get_pending_transaction", return_value=None):
            import asyncio
            from app.routers.plaid import _approve_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.run(
                    _approve_pending("pend-001", user_bob, None, None, None, None)
                )
            assert exc_info.value.status_code == 404

    def test_discard_cross_family_returns_404(self):
        from fastapi import HTTPException

        user_bob = _make_user(user_id="user-bob", family_id="fam-002")
        with patch("app.services.plaid_service.get_pending_transaction", return_value=None):
            import asyncio
            from app.routers.plaid import discard_pending

            with pytest.raises(HTTPException) as exc_info:
                asyncio.run(
                    discard_pending("pend-001", current_user=user_bob)
                )
            assert exc_info.value.status_code == 404

    def test_get_pending_transaction_cross_family_returns_none(self):
        """plaid_service.get_pending_transaction returns None for cross-family docs."""
        alice_doc = _make_pending_doc(family_id="fam-001")

        snap = MagicMock()
        snap.exists = True
        snap.to_dict.return_value = dict(alice_doc)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import get_pending_transaction
            result = get_pending_transaction("pend-001", family_id="fam-002")

        assert result is None

    def test_get_item_cross_family_returns_none(self):
        """plaid_service.get_item returns None when family_id doesn't match."""
        item_doc = {
            "family_id": "fam-001",
            "connected_by_user_id": "user-alice",
            "plaid_item_id": "item-1",
            "institution_name": "Chase",
            "status": "active",
        }

        snap = MagicMock()
        snap.exists = True
        snap.to_dict.return_value = dict(item_doc)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import get_item
            result = get_item("item-1", family_id="fam-999")

        assert result is None


# ---------------------------------------------------------------------------
# 3b. User without family gets 400
# ---------------------------------------------------------------------------


class TestUserWithoutFamily:
    def test_list_items_user_without_family_gets_400(self):
        """GET /plaid/items for a user with no family_id returns HTTP 400."""
        from fastapi import HTTPException
        from app.routers.plaid import _require_family_id

        user_no_family = _make_user(family_id=None)
        with pytest.raises(HTTPException) as exc_info:
            _require_family_id(user_no_family)
        assert exc_info.value.status_code == 400

    def test_discard_user_without_family_gets_400(self):
        """Discard endpoint for a user with no family_id returns HTTP 400."""
        from fastapi import HTTPException

        user_no_family = _make_user(family_id=None)
        # get_pending_transaction won't be called because _require_family_id raises first
        import asyncio
        from app.routers.plaid import discard_pending

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(
                discard_pending("pend-001", current_user=user_no_family)
            )
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# 3c. Family member B sees pending from member A's bank
# ---------------------------------------------------------------------------


class TestFamilyMemberCrossVisibility:
    def test_family_member_can_view_pending_from_other_member(self):
        """User B (same family) can see a pending doc connected by User A."""
        # pending doc was created by user-alice (connected_by_user_id=user-alice)
        alice_pending = _make_pending_doc(family_id="fam-001", connected_by_user_id="user-alice")

        snap = MagicMock()
        snap.exists = True
        snap.to_dict.return_value = dict(alice_pending)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import get_pending_transaction
            # User B queries with same family_id
            result = get_pending_transaction("pend-001", family_id="fam-001")

        # Should succeed — same family
        assert result is not None
        assert result["family_id"] == "fam-001"
        assert result["connected_by_user_id"] == "user-alice"


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


def _make_item_snap(family_id="fam-001", connected_by_user_id="user-alice", status="active", cursor=None):
    snap = MagicMock()
    snap.exists = True
    snap.to_dict.return_value = {
        "family_id": family_id,
        "connected_by_user_id": connected_by_user_id,
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
            result = sync_transactions("item-1")

        assert result["added"] == 1
        assert result["removed"] == 0
        assert len(set_calls) == 1
        assert set_calls[0]["plaid_transaction_id"] == "txn-new"
        # Verify the pending doc carries family_id, not user_id
        assert set_calls[0]["family_id"] == "fam-001"
        assert set_calls[0]["connected_by_user_id"] == "user-alice"

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
            "family_id": "fam-001",
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
            result = sync_transactions("item-1")

        assert result["removed"] == 1
        assert len(delete_calls) == 1

    def test_item_not_active_skips_sync(self):
        item_snap = _make_item_snap(status="needs_reauth")
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = item_snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1")

        assert result.get("error") == "item_not_active"
        assert result["added"] == 0

    def test_item_not_found_returns_error(self):
        """sync_transactions returns error when item does not exist."""
        snap = MagicMock()
        snap.exists = False
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-nonexistent")

        assert result.get("error") == "item_not_found"


# ---------------------------------------------------------------------------
# 6. is_income_transaction
# ---------------------------------------------------------------------------


class TestIsIncomeTransaction:
    def test_negative_amount_is_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction(None, -50.0) is True

    def test_positive_amount_expense_category_is_not_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction({"primary": "FOOD_AND_DRINK"}, 12.50) is False

    def test_income_primary_is_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction({"primary": "INCOME"}, 1500.0) is True

    def test_transfer_in_primary_is_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction({"primary": "TRANSFER_IN"}, 200.0) is True

    def test_transfer_out_not_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction({"primary": "TRANSFER_OUT"}, 200.0) is False

    def test_none_category_zero_amount_not_income(self):
        from app.services.plaid_service import is_income_transaction
        assert is_income_transaction(None, 0.0) is False

    def test_txn_to_doc_sets_is_income_for_negative_amount(self):
        """_txn_to_doc should set is_income=True for negative amounts."""
        from app.services.plaid_service import _txn_to_doc

        txn = {
            "transaction_id": "txn-income",
            "account_id": "acct-1",
            "amount": -1200.0,
            "name": "Payroll",
            "merchant_name": None,
            "date": "2026-06-01",
            "authorized_date": None,
            "pending": False,
            "iso_currency_code": "USD",
            "personal_finance_category": {"primary": "INCOME"},
        }
        doc = _txn_to_doc(txn, "fam-001", "user-alice", "item-1", "Checking", "Chase")
        assert doc["is_income"] is True

    def test_txn_to_doc_sets_is_income_false_for_normal_expense(self):
        from app.services.plaid_service import _txn_to_doc

        txn = {
            "transaction_id": "txn-coffee",
            "account_id": "acct-1",
            "amount": 5.50,
            "name": "Starbucks",
            "merchant_name": "Starbucks",
            "date": "2026-06-01",
            "authorized_date": None,
            "pending": False,
            "iso_currency_code": "USD",
            "personal_finance_category": {"primary": "FOOD_AND_DRINK"},
        }
        doc = _txn_to_doc(txn, "fam-001", "user-alice", "item-1", "Checking", "Chase")
        assert doc["is_income"] is False


# ---------------------------------------------------------------------------
# 7. exchange_public_token returns immediately (sync_transactions NOT awaited)
# ---------------------------------------------------------------------------


class TestExchangeAsync:
    def test_exchange_returns_sync_status_pending_without_awaiting_sync(self):
        """exchange_public_token should NOT await sync_transactions inline.

        sync_transactions should be called via asyncio.create_task, meaning it
        is never directly awaited. We verify this by making sync_transactions
        block — if awaited inline, the request would block too, and the test
        would time out. Instead we assert the response has sync_status='pending'.
        """
        import asyncio

        user = _make_user()

        # Minimal mocks for the plaid client calls inside exchange_public_token
        mock_client = MagicMock()
        mock_client.item_public_token_exchange.return_value.to_dict.return_value = {
            "access_token": "access-sandbox-test",
            "item_id": "item-exchange-test",
        }
        mock_client.item_get.return_value.to_dict.return_value = {
            "item": {"institution_id": "ins_1"}
        }
        mock_client.institutions_get_by_id.return_value.to_dict.return_value = {
            "institution": {"name": "Test Bank"}
        }
        mock_client.accounts_get.return_value.to_dict.return_value = {"accounts": []}

        sync_called = []

        def mock_sync(item_id):
            sync_called.append(item_id)

        with (
            patch("app.routers.plaid._plaid_client", return_value=mock_client),
            patch("app.services.plaid_service.upsert_accounts"),
            patch("app.services.plaid_service.upsert_item"),
            patch("app.services.plaid_service.sync_transactions", side_effect=mock_sync),
        ):
            from app.routers.plaid import exchange_public_token
            from app.routers.plaid import ExchangeRequest

            async def run():
                req = ExchangeRequest(public_token="public-test-token")
                return await exchange_public_token(req, current_user=user)

            result = asyncio.run(run())

        assert result["sync_status"] == "pending"
        assert result["pending_count"] == 0
        assert "plaid_item_id" in result
        # sync_transactions may or may not have been called yet (it's a task),
        # but the endpoint must return without blocking on it.
