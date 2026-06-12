"""Tests for usage metering: pricing.py, usage_service.py, and /usage/quick endpoint."""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeUsage:
    """Mimics an Anthropic SDK Usage object."""
    def __init__(
        self,
        input_tokens: int = 500,
        output_tokens: int = 100,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
    ):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_read_input_tokens = cache_read_input_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens


def _make_mock_db():
    """Build a mock Firestore client that tracks add() and set() calls."""
    add_calls = []
    set_calls = []
    collection_names = []

    mock_db = MagicMock()

    def _make_col(name=None):
        collection_names.append(name)
        col = MagicMock()
        col.add = MagicMock(side_effect=lambda d: add_calls.append(d))

        def _make_doc(doc_id=None):
            doc = MagicMock()
            doc.set = MagicMock(side_effect=lambda d, **kw: set_calls.append((d, kw)))
            doc.collection = MagicMock(side_effect=_make_col)
            return doc

        col.document = MagicMock(side_effect=_make_doc)
        return col

    mock_db.collection = MagicMock(side_effect=_make_col)
    return mock_db, add_calls, set_calls, collection_names


# ---------------------------------------------------------------------------
# pricing.compute_cost
# ---------------------------------------------------------------------------

class TestComputeCost:
    def test_returns_positive_for_known_model(self):
        """compute_cost with a real known model should return a positive float."""
        from app.services import pricing
        usage = _FakeUsage(input_tokens=1000, output_tokens=500)
        cost = pricing.compute_cost("claude-haiku-4-5", usage)
        assert isinstance(cost, float)
        assert cost > 0

    def test_returns_zero_for_unknown_model(self, caplog):
        """compute_cost with an unknown model returns 0.0 and logs a warning."""
        from app.services import pricing
        usage = _FakeUsage(input_tokens=1000, output_tokens=500)
        with caplog.at_level(logging.WARNING, logger="app.services.pricing"):
            cost = pricing.compute_cost("nonexistent-model-xyz-9999", usage)
        assert cost == 0.0
        assert any("LiteLLM cost lookup failed" in r.message for r in caplog.records)

    def test_accepts_dict_usage(self):
        """compute_cost works when usage is a dict."""
        from app.services import pricing
        usage = {"input_tokens": 100, "output_tokens": 50}
        cost = pricing.compute_cost("claude-haiku-4-5", usage)
        assert isinstance(cost, float)
        assert cost > 0

    def test_zero_tokens_returns_non_negative(self):
        """Zero token counts produce a non-negative cost."""
        from app.services import pricing
        usage = _FakeUsage(input_tokens=0, output_tokens=0)
        cost = pricing.compute_cost("claude-haiku-4-5", usage)
        assert cost >= 0.0


# ---------------------------------------------------------------------------
# usage_service.record_usage
# ---------------------------------------------------------------------------

class TestRecordUsage:
    def test_writes_detail_event_and_returns_cost(self):
        """record_usage writes one detail event and returns a float cost."""
        from app.services import usage_service
        mock_db, add_calls, set_calls, col_names = _make_mock_db()

        with patch("app.services.usage_service.get_firestore_client", return_value=mock_db):
            cost = usage_service.record_usage(
                user_id="u1",
                family_id="f1",
                source="chat",
                model="claude-haiku-4-5",
                conversation_id="conv1",
                turn_id="turn1",
                usage=_FakeUsage(input_tokens=500, output_tokens=100),
                duration_ms=300,
            )

        assert isinstance(cost, float)
        assert cost >= 0.0
        assert len(add_calls) == 1
        payload = add_calls[0]
        assert payload["user_id"] == "u1"
        assert payload["source"] == "chat"
        assert payload["input_tokens"] == 500
        assert payload["output_tokens"] == 100

    def test_increments_monthly_summary(self):
        """record_usage calls set(merge=True) on the monthly summary doc."""
        from app.services import usage_service
        mock_db, add_calls, set_calls, col_names = _make_mock_db()

        with patch("app.services.usage_service.get_firestore_client", return_value=mock_db):
            usage_service.record_usage(
                user_id="u2",
                family_id=None,
                source="haiku-budget-suggestion",
                model="claude-haiku-4-5",
                conversation_id=None,
                turn_id=None,
                usage=_FakeUsage(input_tokens=200, output_tokens=50),
                duration_ms=100,
            )

        # Should have at least one set(merge=True) for the monthly summary
        assert any(kw.get("merge") is True for _, kw in set_calls), (
            f"Expected at least one set(..., merge=True). set_calls: {set_calls}"
        )

    def test_increments_conversation_cost_when_conv_id_given(self):
        """record_usage accesses chat_conversations collection when conversation_id is set."""
        from app.services import usage_service
        mock_db, add_calls, set_calls, col_names = _make_mock_db()

        with patch("app.services.usage_service.get_firestore_client", return_value=mock_db):
            usage_service.record_usage(
                user_id="u3",
                family_id=None,
                source="chat",
                model="claude-haiku-4-5",
                conversation_id="conv-abc",
                turn_id="turn-xyz",
                usage=_FakeUsage(input_tokens=100, output_tokens=30),
                duration_ms=50,
            )

        assert "chat_conversations" in col_names, (
            f"Expected chat_conversations collection access. Got: {col_names}"
        )

    def test_does_not_raise_on_firestore_error(self):
        """record_usage is resilient to Firestore errors — never raises."""
        from app.services import usage_service
        mock_db = MagicMock()
        mock_db.collection.side_effect = Exception("firestore down")

        with patch("app.services.usage_service.get_firestore_client", return_value=mock_db):
            cost = usage_service.record_usage(
                user_id="u4",
                family_id=None,
                source="chat",
                model="claude-haiku-4-5",
                conversation_id=None,
                turn_id=None,
                usage=_FakeUsage(input_tokens=10, output_tokens=5),
                duration_ms=10,
            )
        assert isinstance(cost, float)


# ---------------------------------------------------------------------------
# GET /api/v1/usage/quick endpoint
# ---------------------------------------------------------------------------

class TestUsageQuickEndpoint:
    @pytest.fixture(autouse=True)
    def _setup_auth(self, mock_user):
        from app.main import app
        from app.auth.dependencies import get_current_user
        app.dependency_overrides[get_current_user] = lambda: mock_user
        yield
        app.dependency_overrides.clear()

    def test_returns_correct_shape_with_zeros(self, client):
        """GET /api/v1/usage/quick returns session_cost_usd + month_cost_usd."""
        with (
            patch("app.routers.usage.usage_service.get_conversation_cost", return_value=0.0),
            patch("app.routers.usage.usage_service.get_monthly_cost", return_value=0.0),
        ):
            resp = client.get("/api/v1/usage/quick")
        assert resp.status_code == 200
        data = resp.json()
        assert "session_cost_usd" in data
        assert "month_cost_usd" in data
        assert data["session_cost_usd"] == 0.0
        assert data["month_cost_usd"] == 0.0

    def test_returns_conversation_cost_when_id_given(self, client):
        """GET /api/v1/usage/quick?conversation_id=X returns session cost."""
        with (
            patch("app.routers.usage.usage_service.get_conversation_cost", return_value=0.0042),
            patch("app.routers.usage.usage_service.get_monthly_cost", return_value=0.15),
        ):
            resp = client.get("/api/v1/usage/quick?conversation_id=conv-123")
        assert resp.status_code == 200
        data = resp.json()
        assert abs(data["session_cost_usd"] - 0.0042) < 1e-9
        assert abs(data["month_cost_usd"] - 0.15) < 1e-9

    def test_session_cost_zero_when_no_conversation_id(self, client):
        """Without conversation_id, session_cost_usd must be 0.0."""
        with patch("app.routers.usage.usage_service.get_monthly_cost", return_value=0.05):
            resp = client.get("/api/v1/usage/quick")
        assert resp.status_code == 200
        assert resp.json()["session_cost_usd"] == 0.0

    def test_requires_auth(self, client):
        """GET /api/v1/usage/quick without a token returns 401 or 403.
        Note: dependency_overrides is cleared by autouse fixture AFTER yield;
        this test runs with overrides in place so we skip auth override here."""
        from app.main import app
        app.dependency_overrides.clear()  # ensure no override for this test
        resp = client.get("/api/v1/usage/quick")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Quota gate in chat_start
# ---------------------------------------------------------------------------

class TestQuotaGate:
    @pytest.fixture(autouse=True)
    def _setup_auth(self, mock_user):
        from app.main import app
        from app.auth.dependencies import get_current_user
        app.dependency_overrides[get_current_user] = lambda: mock_user
        yield
        app.dependency_overrides.clear()

    def test_passes_when_cap_is_none(self, client):
        """chat_start does not gate when monthly_cap_usd is None (default)."""
        mock_user_doc = MagicMock()
        mock_user_doc.exists = True
        mock_user_doc.to_dict.return_value = {"monthly_cap_usd": None}

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc

        with (
            patch("app.services.firestore.get_firestore_client", return_value=mock_db),
            patch("app.services.usage_service.get_monthly_cost", return_value=9999.0),
            patch("app.routers.chat.get_chat_store") as mock_store,
            patch("asyncio.create_task"),
        ):
            mock_store.return_value.get_conversation.return_value = None
            mock_store.return_value.create_conversation.return_value = "conv-new"
            mock_store.return_value.create_user_turn.return_value = "u-turn"
            mock_store.return_value.create_assistant_turn.return_value = "a-turn"
            mock_store.return_value.update_conversation_meta.return_value = None

            resp = client.post(
                "/api/v1/chat/start",
                json={"message": "hello"},
                headers={"Authorization": "Bearer mock-token"},
            )
        assert resp.status_code != 429

    def test_blocks_when_cap_reached(self, client):
        """chat_start returns 429 when monthly spend >= cap."""
        mock_user_doc = MagicMock()
        mock_user_doc.exists = True
        mock_user_doc.to_dict.return_value = {"monthly_cap_usd": 5.0}

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc

        with (
            patch("app.services.firestore.get_firestore_client", return_value=mock_db),
            patch("app.services.usage_service.get_monthly_cost", return_value=6.0),
        ):
            resp = client.post(
                "/api/v1/chat/start",
                json={"message": "hello"},
                headers={"Authorization": "Bearer mock-token"},
            )
        assert resp.status_code == 429
        assert "cap" in resp.json()["detail"].lower()

    def test_passes_when_spend_below_cap(self, client):
        """chat_start does not gate when spend is below cap."""
        mock_user_doc = MagicMock()
        mock_user_doc.exists = True
        mock_user_doc.to_dict.return_value = {"monthly_cap_usd": 10.0}

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = mock_user_doc

        with (
            patch("app.services.firestore.get_firestore_client", return_value=mock_db),
            patch("app.services.usage_service.get_monthly_cost", return_value=4.0),
            patch("app.routers.chat.get_chat_store") as mock_store,
            patch("asyncio.create_task"),
        ):
            mock_store.return_value.get_conversation.return_value = None
            mock_store.return_value.create_conversation.return_value = "conv-x"
            mock_store.return_value.create_user_turn.return_value = "u-turn"
            mock_store.return_value.create_assistant_turn.return_value = "a-turn"
            mock_store.return_value.update_conversation_meta.return_value = None

            resp = client.post(
                "/api/v1/chat/start",
                json={"message": "under budget"},
                headers={"Authorization": "Bearer mock-token"},
            )
        assert resp.status_code != 429
