"""Unit tests for app.services.budget_suggester.

All tests mock anthropic.Anthropic so no real API key or network is needed.
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Ensure test env vars are set before any app imports
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("GCP_PROJECT_ID", "test-project")
os.environ.setdefault("FIRESTORE_DATABASE", "test-database")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")


def _make_budget(id: str, name: str, category: str | None = "dining"):
    """Build a minimal BudgetResponse-like object."""
    b = SimpleNamespace()
    b.id = id
    b.name = name
    b.category = category
    b.beneficiary = None
    b.amount = 200.0
    b.period = "monthly"
    return b


def _make_txn(id: str, merchant: str = "Starbucks", amount: float = 6.42):
    return {
        "id": id,
        "merchant_name": merchant,
        "name": merchant.upper(),
        "amount": amount,
        "plaid_category": {"primary": "FOOD_AND_DRINK"},
        "account_type": "credit",
        "account_name": "Chase Sapphire",
        "date": "2026-06-10",
    }


def _make_haiku_response(suggestions: list[dict]) -> MagicMock:
    """Build a mock anthropic response with the given suggestions payload."""
    content_block = MagicMock()
    content_block.text = json.dumps({"suggestions": suggestions})
    usage = MagicMock()
    usage.input_tokens = 100
    usage.output_tokens = 50
    resp = MagicMock()
    resp.content = [content_block]
    resp.usage = usage
    return resp


# ---------------------------------------------------------------------------
# 1. Empty inputs
# ---------------------------------------------------------------------------


class TestEmptyInputs:
    def test_no_transactions_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        budgets = [_make_budget("b1", "Dining")]
        result = suggest_budgets_for_batch([], budgets)
        assert result == {}

    def test_no_budgets_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        txns = [_make_txn("t1")]
        result = suggest_budgets_for_batch(txns, [])
        assert result == {}

    def test_both_empty_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        result = suggest_budgets_for_batch([], [])
        assert result == {}


# ---------------------------------------------------------------------------
# 2. Missing API key
# ---------------------------------------------------------------------------


class TestMissingApiKey:
    def test_skips_when_no_api_key(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        from app.services.budget_suggester import suggest_budgets_for_batch
        txns = [_make_txn("t1")]
        budgets = [_make_budget("b1", "Dining")]
        with patch("anthropic.Anthropic") as mock_cls:
            result = suggest_budgets_for_batch(txns, budgets)
        mock_cls.assert_not_called()
        assert result == {}


# ---------------------------------------------------------------------------
# 3. Happy path — parses JSON and returns expected dict
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_parses_json_response_correctly(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001"), _make_txn("txn-002", "Whole Foods", 52.0)]
        budgets = [
            _make_budget("bud-dining", "Eating Out", "dining"),
            _make_budget("bud-grocery", "Groceries", "groceries"),
        ]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-001", "budget_id": "bud-dining", "reason": "Starbucks matches dining"},
            {"transaction_id": "txn-002", "budget_id": "bud-grocery", "reason": "Whole Foods matches groceries"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-001"] == "bud-dining"
        assert result["txn-002"] == "bud-grocery"

    def test_null_budget_id_in_response_preserved(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-income", "Payroll", -3000.0)]
        budgets = [_make_budget("b1", "Dining")]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-income", "budget_id": None, "reason": "Income — no budget"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-income"] is None


# ---------------------------------------------------------------------------
# 4. Hallucinated budget_id dropped
# ---------------------------------------------------------------------------


class TestHallucinatedId:
    def test_drops_hallucinated_budget_id(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("bud-real", "Real Budget")]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-001", "budget_id": "bud-fake-hallucinated", "reason": "Wrong id"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        # The hallucinated id should be replaced with None, not kept.
        assert result["txn-001"] is None


# ---------------------------------------------------------------------------
# 5. API failure and malformed JSON
# ---------------------------------------------------------------------------


class TestApiFailure:
    def test_handles_api_error_gracefully(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("b1", "Dining")]

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.side_effect = RuntimeError("API down")
            result = suggest_budgets_for_batch(txns, budgets)

        assert result == {}

    def test_handles_malformed_json_gracefully(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("b1", "Dining")]

        bad_content = MagicMock()
        bad_content.text = "not json at all { broken"
        mock_resp = MagicMock()
        mock_resp.content = [bad_content]
        mock_resp.usage = MagicMock(input_tokens=0, output_tokens=0)

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result == {}

    def test_handles_json_fences(self, monkeypatch):
        """Haiku sometimes wraps response in ```json fences - strip them."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("bud-dining", "Dining")]

        content_block = MagicMock()
        content_block.text = '```json\n{"suggestions": [{"transaction_id": "txn-001", "budget_id": "bud-dining", "reason": "match"}]}\n```'
        mock_resp = MagicMock()
        mock_resp.content = [content_block]
        mock_resp.usage = MagicMock(input_tokens=10, output_tokens=20)

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-001"] == "bud-dining"
