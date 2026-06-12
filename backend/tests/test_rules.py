"""Tests for merchant auto-rules: service + router."""
import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from datetime import datetime, timezone

from app.main import app
from app.auth.dependencies import get_current_user


FAMILY_ID = "test-family-123"
USER_ID = "test-user-123"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_snap(doc_id: str, data: dict):
    snap = MagicMock()
    snap.id = doc_id
    snap.exists = True
    snap.to_dict.return_value = dict(data)
    snap.reference = MagicMock()
    snap.reference.id = doc_id
    return snap


# ---------------------------------------------------------------------------
# rule_service unit tests
# ---------------------------------------------------------------------------


class TestRuleService:
    """Unit-tests for app.services.rule_service (Firestore mocked at call site)."""

    def _make_db(self):
        return MagicMock()

    # --- create_rule ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_rule_new(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        col = db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        new_ref = MagicMock()
        new_ref.id = "rule-abc"
        col.document.return_value = new_ref

        from app.services.rule_service import create_rule
        rule = create_rule(FAMILY_ID, "Starbucks", "dining", None, None, USER_ID)

        assert rule["id"] == "rule-abc"
        assert rule["merchant_name"] == "starbucks"
        assert rule["category"] == "dining"
        new_ref.set.assert_called_once()

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_rule_normalises_merchant_name(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        col = db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        new_ref = MagicMock()
        new_ref.id = "rule-xyz"
        col.document.return_value = new_ref

        from app.services.rule_service import create_rule
        rule = create_rule(FAMILY_ID, "  AMAZON  ", "shopping", None, None, USER_ID)
        assert rule["merchant_name"] == "amazon"

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_rule_upserts_existing(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        existing_snap = _make_snap("rule-exists", {
            "family_id": FAMILY_ID,
            "merchant_name": "starbucks",
            "category": "other",
            "budget_id": None,
            "beneficiary": None,
            "created_by": USER_ID,
        })
        col = db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = [existing_snap]

        from app.services.rule_service import create_rule
        rule = create_rule(FAMILY_ID, "Starbucks", "dining", "budget-99", None, USER_ID)

        assert rule["id"] == "rule-exists"
        assert rule["category"] == "dining"
        assert rule["budget_id"] == "budget-99"
        existing_snap.reference.update.assert_called_once()

    # --- list_rules ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_list_rules_returns_all(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        snaps = [
            _make_snap("r1", {"family_id": FAMILY_ID, "merchant_name": "amazon", "category": "shopping", "budget_id": None, "beneficiary": None}),
            _make_snap("r2", {"family_id": FAMILY_ID, "merchant_name": "starbucks", "category": "dining", "budget_id": None, "beneficiary": None}),
        ]
        db.collection.return_value.where.return_value.order_by.return_value.get.return_value = snaps

        from app.services.rule_service import list_rules
        rules = list_rules(FAMILY_ID)
        assert len(rules) == 2
        assert rules[0]["id"] == "r1"

    @patch("app.services.rule_service.get_firestore_client")
    def test_list_rules_empty(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.order_by.return_value.get.return_value = []

        from app.services.rule_service import list_rules
        rules = list_rules(FAMILY_ID)
        assert rules == []

    # --- delete_rule ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_rule_success(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        snap = _make_snap("rule-del", {"family_id": FAMILY_ID, "merchant_name": "target", "category": "shopping"})
        ref = MagicMock()
        ref.get.return_value = snap
        db.collection.return_value.document.return_value = ref

        from app.services.rule_service import delete_rule
        result = delete_rule("rule-del", FAMILY_ID)
        assert result is True
        ref.delete.assert_called_once()

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_rule_not_found(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        snap = MagicMock()
        snap.exists = False
        db.collection.return_value.document.return_value.get.return_value = snap

        from app.services.rule_service import delete_rule
        result = delete_rule("missing-id", FAMILY_ID)
        assert result is False

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_rule_cross_family_denied(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        snap = _make_snap("rule-other", {"family_id": "other-family", "merchant_name": "walmart"})
        ref = MagicMock()
        ref.get.return_value = snap
        db.collection.return_value.document.return_value = ref

        from app.services.rule_service import delete_rule
        result = delete_rule("rule-other", FAMILY_ID)
        assert result is False
        ref.delete.assert_not_called()

    # --- find_match ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_hit(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        snap = _make_snap("rule-hit", {"family_id": FAMILY_ID, "merchant_name": "starbucks", "category": "dining"})
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = [snap]

        from app.services.rule_service import find_match
        result = find_match("Starbucks", FAMILY_ID)
        assert result is not None
        assert result["id"] == "rule-hit"
        assert result["category"] == "dining"

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_miss(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = []

        from app.services.rule_service import find_match
        result = find_match("Unknown Merchant", FAMILY_ID)
        assert result is None

    def test_find_match_none_merchant(self):
        from app.services.rule_service import find_match
        with patch("app.services.rule_service.get_firestore_client") as mock_fs:
            result = find_match(None, FAMILY_ID)
        assert result is None
        mock_fs.assert_not_called()

    def test_find_match_empty_string(self):
        from app.services.rule_service import find_match
        with patch("app.services.rule_service.get_firestore_client") as mock_fs:
            result = find_match("   ", FAMILY_ID)
        assert result is None
        mock_fs.assert_not_called()

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_firestore_error_returns_none(self, mock_fs):
        db = self._make_db()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.side_effect = Exception("firestore error")

        from app.services.rule_service import find_match
        result = find_match("Starbucks", FAMILY_ID)
        assert result is None


# ---------------------------------------------------------------------------
# Router tests
# ---------------------------------------------------------------------------


class TestRulesRouter:
    """Integration tests for /api/v1/rules/merchant via TestClient."""

    @pytest.fixture(autouse=True)
    def _setup_auth(self, mock_user):
        app.dependency_overrides[get_current_user] = lambda: mock_user
        yield
        app.dependency_overrides.clear()

    @patch("app.routers.rules.rule_service")
    def test_list_rules_ok(self, mock_svc, client):
        mock_svc.list_rules.return_value = [
            {"id": "r1", "family_id": FAMILY_ID, "merchant_name": "starbucks",
             "category": "dining", "budget_id": None, "beneficiary": None, "created_by": USER_ID}
        ]
        resp = client.get("/api/v1/rules/merchant")
        assert resp.status_code == 200
        assert len(resp.json()["rules"]) == 1

    @patch("app.routers.rules.rule_service")
    def test_create_rule_ok(self, mock_svc, client, mock_user):
        mock_svc.create_rule.return_value = {
            "id": "r-new", "family_id": FAMILY_ID, "merchant_name": "amazon",
            "category": "shopping", "budget_id": None, "beneficiary": None, "created_by": USER_ID,
        }
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "Amazon",
            "category": "shopping",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["rule"]["id"] == "r-new"
        mock_svc.create_rule.assert_called_once_with(
            family_id=FAMILY_ID,
            merchant_name="Amazon",
            category="shopping",
            budget_id=None,
            beneficiary=None,
            created_by=USER_ID,
        )

    @patch("app.routers.rules.rule_service")
    def test_create_rule_with_budget(self, mock_svc, client):
        mock_svc.create_rule.return_value = {
            "id": "r-b", "family_id": FAMILY_ID, "merchant_name": "walmart",
            "category": "groceries", "budget_id": "budget-1", "beneficiary": None, "created_by": USER_ID,
        }
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "Walmart",
            "category": "groceries",
            "budget_id": "budget-1",
        })
        assert resp.status_code == 201
        assert resp.json()["rule"]["budget_id"] == "budget-1"

    @patch("app.routers.rules.rule_service")
    def test_delete_rule_ok(self, mock_svc, client):
        mock_svc.delete_rule.return_value = True
        resp = client.delete("/api/v1/rules/merchant/r1")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    @patch("app.routers.rules.rule_service")
    def test_delete_rule_not_found(self, mock_svc, client):
        mock_svc.delete_rule.return_value = False
        resp = client.delete("/api/v1/rules/merchant/missing")
        assert resp.status_code == 404

    def test_list_rules_no_family(self, client, mock_user_no_family):
        app.dependency_overrides[get_current_user] = lambda: mock_user_no_family
        resp = client.get("/api/v1/rules/merchant")
        assert resp.status_code == 400

    def test_create_rule_empty_merchant_rejected(self, client):
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "",
            "category": "dining",
        })
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# save_as_rule in approve endpoint
# ---------------------------------------------------------------------------


class TestApproveWithSaveAsRule:
    """Tests that passing save_as_rule=true in /approve body saves a rule."""

    @pytest.fixture(autouse=True)
    def _setup_auth(self, mock_user):
        app.dependency_overrides[get_current_user] = lambda: mock_user
        yield
        app.dependency_overrides.clear()

    @patch("app.services.rule_service.get_firestore_client")
    @patch("app.routers.plaid.plaid_service.update_pending_status")
    @patch("app.routers.plaid.get_firestore_client")
    @patch("app.routers.plaid.get_expense_service")
    @patch("app.routers.plaid.plaid_service.get_pending_transaction")
    @patch("app.routers.plaid._get_account_info", return_value={"type": "credit"})
    def test_approve_with_save_as_rule_calls_create_rule(
        self,
        _mock_acct,
        mock_get_pending,
        mock_get_svc,
        mock_plaid_fs,
        mock_update_status,
        mock_rule_fs,
        client,
        mock_user,
    ):
        pending_doc = {
            "id": "pend-1",
            "family_id": FAMILY_ID,
            "status": "pending",
            "amount": 5.50,
            "merchant_name": "Starbucks",
            "name": "Starbucks",
            "suggested_category": "dining",
            "iso_currency_code": "USD",
            "date": "2026-06-01",
            "authorized_date": None,
            "account_id": "acct-1",
            "plaid_transaction_id": "plaid-txn-1",
        }
        mock_get_pending.return_value = pending_doc

        mock_expense = MagicMock()
        mock_expense.id = "expense-new"
        mock_expense.model_dump.return_value = {"id": "expense-new", "amount": 5.50}

        svc_instance = MagicMock()
        svc_instance.create = AsyncMock(return_value=mock_expense)
        mock_get_svc.return_value = svc_instance

        mock_plaid_fs.return_value = MagicMock()

        # rule_service Firestore: no existing rule, then creates one
        mock_rule_db = MagicMock()
        mock_rule_fs.return_value = mock_rule_db
        col = mock_rule_db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        new_ref = MagicMock()
        new_ref.id = "rule-saved"
        col.document.return_value = new_ref

        resp = client.post("/api/v1/plaid/pending/pend-1/approve", json={
            "category": "dining",
            "save_as_rule": True,
        })

        assert resp.status_code == 200
        assert "expense" in resp.json()
        # Verify rule was created (set was called on the new doc ref)
        new_ref.set.assert_called_once()
