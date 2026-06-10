"""Tests for the sandbox-only Plaid bypass endpoints.

Covers:
1. _assert_non_prod() raises HTTP 404 for "production" and "prod".
2. sandbox_connect returns 400 when user has no family (via HTTP client with patched auth).
3. sandbox_connect successfully connects a sandbox bank (mocked Plaid + Firestore).
4. sandbox_reset raises HTTP 404 in production.
5. _test/reset returns ok when Plaid data is present (mocked Firestore).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Env setup before any app imports
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
# Helpers
# ---------------------------------------------------------------------------


def _make_user(user_id="test-user-123", family_id="fam-001"):
    from app.models.user import User

    return User(
        id=user_id,
        email=f"{user_id}@example.com",
        display_name="Test User",
        photo_url=None,
        family_id=family_id,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def _make_no_family_user():
    from app.models.user import User

    return User(
        id="no-family-user",
        email="nofamily@example.com",
        display_name="No Family",
        photo_url=None,
        family_id=None,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


# ---------------------------------------------------------------------------
# 1. Test: _assert_non_prod blocks production
# ---------------------------------------------------------------------------


class TestAssertNonProd:
    """Unit tests for the _assert_non_prod guard — no HTTP needed."""

    def test_raises_404_for_production(self):
        from fastapi import HTTPException
        from app.routers import plaid as plaid_router

        with patch.object(plaid_router, "settings") as mock_s:
            mock_s.environment = "production"
            with pytest.raises(HTTPException) as exc_info:
                plaid_router._assert_non_prod()
        assert exc_info.value.status_code == 404

    def test_raises_404_for_prod_alias(self):
        from fastapi import HTTPException
        from app.routers import plaid as plaid_router

        with patch.object(plaid_router, "settings") as mock_s:
            mock_s.environment = "prod"
            with pytest.raises(HTTPException) as exc_info:
                plaid_router._assert_non_prod()
        assert exc_info.value.status_code == 404

    def test_does_not_raise_for_test(self):
        from app.routers import plaid as plaid_router

        with patch.object(plaid_router, "settings") as mock_s:
            mock_s.environment = "test"
            plaid_router._assert_non_prod()  # should not raise

    def test_does_not_raise_for_sandbox(self):
        from app.routers import plaid as plaid_router

        with patch.object(plaid_router, "settings") as mock_s:
            mock_s.environment = "sandbox"
            plaid_router._assert_non_prod()  # should not raise


# ---------------------------------------------------------------------------
# 2. Test: sandbox_connect returns 400 when user has no family
# ---------------------------------------------------------------------------


class TestSandboxConnectNoFamily:
    """HTTP-level test using the shared conftest client fixture."""

    def test_returns_400_when_user_has_no_family(self, client, mock_user_no_family):
        """User without a family_id should get HTTP 400."""
        from app.routers import plaid as plaid_router
        from app.auth.dependencies import get_current_user
        from app.main import app

        with patch.object(plaid_router, "settings") as mock_s, \
             patch.object(app, "dependency_overrides", {get_current_user: lambda: mock_user_no_family}):
            mock_s.environment = "test"

            # Override the dependency directly on the FastAPI app
            orig = app.dependency_overrides.copy()
            app.dependency_overrides[get_current_user] = lambda: mock_user_no_family
            try:
                resp = client.post(
                    "/api/v1/plaid/_test/sandbox-connect",
                    headers={"Authorization": "Bearer mock-token"},
                )
            finally:
                app.dependency_overrides = orig

        assert resp.status_code == 400
        assert "family" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# 3. Test: sandbox_connect happy path (direct function call, matching test_plaid pattern)
# ---------------------------------------------------------------------------


class TestSandboxConnectHappyPath:
    """Call sandbox_connect() coroutine directly to avoid auth middleware complexity."""

    def _make_mock_client(self):
        """Build a mock PlaidApi client."""
        mock_client = MagicMock()

        sandbox_resp = MagicMock()
        sandbox_resp.to_dict.return_value = {"public_token": "public-sandbox-token-abc"}
        mock_client.sandbox_public_token_create.return_value = sandbox_resp

        exchange_resp = MagicMock()
        exchange_resp.to_dict.return_value = {
            "access_token": "access-sandbox-abc",
            "item_id": "item-sandbox-001",
        }
        mock_client.item_public_token_exchange.return_value = exchange_resp

        inst_resp = MagicMock()
        inst_resp.to_dict.return_value = {
            "institution": {"name": "First Platypus Bank", "institution_id": "ins_109508"}
        }
        mock_client.institutions_get_by_id.return_value = inst_resp

        accts_resp = MagicMock()
        accts_resp.to_dict.return_value = {
            "accounts": [
                {
                    "account_id": "acct-001",
                    "name": "Plaid Checking",
                    "type": "depository",
                    "subtype": "checking",
                    "mask": "0000",
                    "balances": {"current": 100.0, "available": 100.0, "iso_currency_code": "USD"},
                },
                {
                    "account_id": "acct-002",
                    "name": "Plaid Saving",
                    "type": "depository",
                    "subtype": "savings",
                    "mask": "1111",
                    "balances": {"current": 200.0, "available": 200.0, "iso_currency_code": "USD"},
                },
            ]
        }
        mock_client.accounts_get.return_value = accts_resp

        sync_resp = MagicMock()
        sync_resp.to_dict.return_value = {
            "added": [],  # sync is a separate concern; happy path just needs no crash
            "modified": [],
            "removed": [],
            "next_cursor": "cursor-abc",
            "has_more": False,
        }
        mock_client.transactions_sync.return_value = sync_resp

        return mock_client

    def test_returns_item_id_and_accounts_count(self):
        """Happy path: coroutine returns plaid_item_id and accounts_count."""
        import asyncio
        from app.routers.plaid import sandbox_connect
        from app.routers import plaid as plaid_router

        user = _make_user()
        mock_client = self._make_mock_client()

        # Mock Firestore
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value.exists = False
        mock_batch = MagicMock()
        mock_db.batch.return_value = mock_batch
        # For sync_transactions: account lookup stream returns empty
        mock_db.collection.return_value.where.return_value.stream.return_value = iter([])
        mock_db.collection.return_value.where.return_value.where.return_value.limit.return_value.stream.return_value = iter([])

        with patch.object(plaid_router, "settings") as mock_s, \
             patch("app.services.plaid_service._client", return_value=mock_client), \
             patch("app.routers.plaid._plaid_client", return_value=mock_client), \
             patch("app.services.plaid_service.get_firestore_client", return_value=mock_db), \
             patch("app.routers.plaid.get_firestore_client", return_value=mock_db):
            mock_s.environment = "test"
            result = asyncio.get_event_loop().run_until_complete(sandbox_connect(user))

        assert result["plaid_item_id"] == "item-sandbox-001"
        assert result["accounts_count"] == 2


# ---------------------------------------------------------------------------
# 4. Test: sandbox_reset guard and behavior
# ---------------------------------------------------------------------------


class TestSandboxReset:
    def test_assert_non_prod_blocks_production_for_reset(self):
        """_assert_non_prod is shared — production blocks reset too."""
        from fastapi import HTTPException
        from app.routers import plaid as plaid_router

        with patch.object(plaid_router, "settings") as mock_s:
            mock_s.environment = "production"
            with pytest.raises(HTTPException) as exc_info:
                plaid_router._assert_non_prod()
        assert exc_info.value.status_code == 404

    def test_reset_deletes_items_for_family(self):
        """sandbox_reset should call delete_item for each item in the family."""
        import asyncio
        from app.routers.plaid import sandbox_reset
        from app.routers import plaid as plaid_router
        from app.services import plaid_service

        user = _make_user()

        # Two items in the family
        snap1 = MagicMock()
        snap1.id = "item-001"
        snap2 = MagicMock()
        snap2.id = "item-002"

        mock_db = MagicMock()
        mock_db.collection.return_value.where.return_value.stream.return_value = iter([snap1, snap2])
        # orphan pending query returns empty
        # We need to handle multiple calls to collection().where().stream()
        call_count = {"n": 0}

        def make_stream():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return iter([snap1, snap2])
            return iter([])  # orphan query

        mock_db.collection.return_value.where.return_value.stream.side_effect = make_stream
        mock_db.batch.return_value = MagicMock()

        with patch.object(plaid_router, "settings") as mock_s, \
             patch("app.routers.plaid.get_firestore_client", return_value=mock_db), \
             patch("app.services.plaid_service.get_firestore_client", return_value=mock_db), \
             patch.object(plaid_service, "delete_pending_transactions_for_item") as mock_del_pending, \
             patch.object(plaid_service, "delete_item") as mock_del_item:
            mock_s.environment = "test"
            result = asyncio.get_event_loop().run_until_complete(sandbox_reset(user))

        assert result["deleted_items"] == 2
        assert mock_del_pending.call_count == 2
        assert mock_del_item.call_count == 2
