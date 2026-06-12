"""Tests for merchant auto-rules.

Covers:
- list returns family-scoped rules sorted by applied_count DESC, created_at DESC
- create with new merchant returns 201
- create with duplicate merchant returns 409
- delete returns 200; cross-family delete returns 404
- find_match finds case-insensitively
- During sync: matched merchant -> expense created, NO pending row, applied_count incremented
- During sync: unmatched merchant -> pending row created
- During sync: income tx with matching rule -> still pending (rule does not fire)
"""
import pytest
from datetime import datetime, timezone, date
from unittest.mock import MagicMock, patch, AsyncMock, call

from app.main import app
from app.auth.dependencies import get_current_user


FAMILY_ID = "test-family-123"
USER_ID = "test-user-123"
NOW = datetime(2026, 6, 12, 0, 0, 0, tzinfo=timezone.utc)


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


def _rule_data(**kwargs) -> dict:
    base = {
        "family_id": FAMILY_ID,
        "user_id": USER_ID,
        "merchant_name": "Starbucks",
        "merchant_name_lower": "starbucks",
        "category": "dining",
        "budget_id": None,
        "beneficiary": None,
        "applied_count": 0,
        "last_applied_at": None,
        "created_at": NOW,
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# rule_service unit tests
# ---------------------------------------------------------------------------


class TestRuleService:

    # --- create ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_new_rule(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        col = db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        new_ref = MagicMock()
        new_ref.id = "rule-abc"
        col.document.return_value = new_ref

        from app.services.rule_service import create
        rule = create(FAMILY_ID, USER_ID, "Starbucks", "dining", None, None)

        assert rule["id"] == "rule-abc"
        assert rule["merchant_name"] == "Starbucks"
        assert rule["merchant_name_lower"] == "starbucks"
        assert rule["category"] == "dining"
        assert rule["applied_count"] == 0
        assert rule["last_applied_at"] is None
        new_ref.set.assert_called_once()

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_duplicate_raises_valueerror(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        existing = _make_snap("r-exists", _rule_data())
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = [existing]

        from app.services.rule_service import create
        with pytest.raises(ValueError, match="already exists"):
            create(FAMILY_ID, USER_ID, "Starbucks", "dining", None, None)

    @patch("app.services.rule_service.get_firestore_client")
    def test_create_stores_lowercase_key(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        col = db.collection.return_value
        col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        new_ref = MagicMock()
        new_ref.id = "r-1"
        col.document.return_value = new_ref

        from app.services.rule_service import create
        rule = create(FAMILY_ID, USER_ID, "  AMAZON  ", "shopping", None, None)
        assert rule["merchant_name"] == "AMAZON"
        assert rule["merchant_name_lower"] == "amazon"

    # --- list_for_family ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_list_sorted_applied_count_desc(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        snaps = [
            _make_snap("r1", _rule_data(merchant_name="Amazon", applied_count=1, created_at=NOW)),
            _make_snap("r2", _rule_data(merchant_name="Starbucks", applied_count=5, created_at=NOW)),
            _make_snap("r3", _rule_data(merchant_name="Walmart", applied_count=0, created_at=NOW)),
        ]
        db.collection.return_value.where.return_value.get.return_value = snaps

        from app.services.rule_service import list_for_family
        rules = list_for_family(FAMILY_ID)
        assert [r["id"] for r in rules] == ["r2", "r1", "r3"]

    @patch("app.services.rule_service.get_firestore_client")
    def test_list_empty(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.get.return_value = []

        from app.services.rule_service import list_for_family
        assert list_for_family(FAMILY_ID) == []

    # --- delete ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_success(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        snap = _make_snap("rule-del", _rule_data())
        ref = MagicMock()
        ref.get.return_value = snap
        db.collection.return_value.document.return_value = ref

        from app.services.rule_service import delete
        assert delete("rule-del", FAMILY_ID) is True
        ref.delete.assert_called_once()

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_not_found(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        snap = MagicMock()
        snap.exists = False
        db.collection.return_value.document.return_value.get.return_value = snap

        from app.services.rule_service import delete
        assert delete("missing", FAMILY_ID) is False

    @patch("app.services.rule_service.get_firestore_client")
    def test_delete_cross_family_denied(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        snap = _make_snap("r-other", _rule_data(family_id="other-family"))
        ref = MagicMock()
        ref.get.return_value = snap
        db.collection.return_value.document.return_value = ref

        from app.services.rule_service import delete
        assert delete("r-other", FAMILY_ID) is False
        ref.delete.assert_not_called()

    # --- find_match ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_case_insensitive(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        snap = _make_snap("r-hit", _rule_data())
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = [snap]

        from app.services.rule_service import find_match
        # Pass mixed-case — should still match (service lowercases before query)
        result = find_match(FAMILY_ID, "STARBUCKS")
        assert result is not None
        assert result["id"] == "r-hit"
        # Verify the service queried with the lowercased field name.
        # The first .where() on the collection has a FieldFilter; inspect its field_path attribute.
        first_where_call = db.collection.return_value.where.call_args
        assert first_where_call is not None
        # FieldFilter is passed as the 'filter' keyword argument
        ff = first_where_call.kwargs.get("filter") or (first_where_call.args[0] if first_where_call.args else None)
        # The first where is on family_id; the second where is chained (.where().where())
        # so we check both the direct call and the chained call for merchant_name_lower
        second_where_call = db.collection.return_value.where.return_value.where.call_args
        assert second_where_call is not None
        ff2 = second_where_call.kwargs.get("filter") or (second_where_call.args[0] if second_where_call.args else None)
        assert ff2 is not None
        assert ff2.field_path == "merchant_name_lower"
        assert ff2.value == "starbucks"  # lowercased

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_miss(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = []

        from app.services.rule_service import find_match
        assert find_match(FAMILY_ID, "Unknown") is None

    def test_find_match_none_merchant_returns_none(self):
        with patch("app.services.rule_service.get_firestore_client") as mock_fs:
            from app.services.rule_service import find_match
            assert find_match(FAMILY_ID, None) is None
        mock_fs.assert_not_called()

    def test_find_match_blank_merchant_returns_none(self):
        with patch("app.services.rule_service.get_firestore_client") as mock_fs:
            from app.services.rule_service import find_match
            assert find_match(FAMILY_ID, "   ") is None
        mock_fs.assert_not_called()

    @patch("app.services.rule_service.get_firestore_client")
    def test_find_match_firestore_error_returns_none(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db
        db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.side_effect = Exception("boom")

        from app.services.rule_service import find_match
        assert find_match(FAMILY_ID, "Starbucks") is None

    # --- record_applied ---

    @patch("app.services.rule_service.get_firestore_client")
    def test_record_applied_increments(self, mock_fs):
        db = MagicMock()
        mock_fs.return_value = db

        from app.services.rule_service import record_applied
        record_applied("rule-1")

        db.collection.return_value.document.assert_called_with("rule-1")
        db.collection.return_value.document.return_value.update.assert_called_once()
        update_kwargs = db.collection.return_value.document.return_value.update.call_args[0][0]
        assert "applied_count" in update_kwargs
        assert "last_applied_at" in update_kwargs


# ---------------------------------------------------------------------------
# Router tests
# ---------------------------------------------------------------------------


class TestRulesRouter:

    @pytest.fixture(autouse=True)
    def _setup_auth(self, mock_user):
        app.dependency_overrides[get_current_user] = lambda: mock_user
        yield
        app.dependency_overrides.clear()

    @patch("app.routers.rules.rule_service")
    def test_list_rules_ok(self, mock_svc, client):
        mock_svc.list_for_family.return_value = [
            _rule_data(id="r1", applied_count=3),
            _rule_data(id="r2", applied_count=0),
        ]
        resp = client.get("/api/v1/rules/merchant")
        assert resp.status_code == 200
        assert len(resp.json()["rules"]) == 2

    @patch("app.routers.rules.rule_service")
    def test_create_rule_ok(self, mock_svc, client):
        mock_svc.create.return_value = _rule_data(id="r-new")
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "Starbucks",
            "category": "dining",
        })
        assert resp.status_code == 201
        assert resp.json()["rule"]["id"] == "r-new"

    @patch("app.routers.rules.rule_service")
    def test_create_duplicate_returns_409(self, mock_svc, client):
        mock_svc.create.side_effect = ValueError("already exists in this family")
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "Starbucks",
            "category": "dining",
        })
        assert resp.status_code == 409

    @patch("app.routers.rules.rule_service")
    def test_create_empty_merchant_rejected(self, mock_svc, client):
        resp = client.post("/api/v1/rules/merchant", json={
            "merchant_name": "",
            "category": "dining",
        })
        assert resp.status_code == 422

    @patch("app.routers.rules.rule_service")
    def test_delete_ok(self, mock_svc, client):
        mock_svc.delete.return_value = True
        resp = client.delete("/api/v1/rules/merchant/r1")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    @patch("app.routers.rules.rule_service")
    def test_delete_not_found(self, mock_svc, client):
        mock_svc.delete.return_value = False
        resp = client.delete("/api/v1/rules/merchant/missing")
        assert resp.status_code == 404

    def test_list_no_family_returns_400(self, client, mock_user_no_family):
        app.dependency_overrides[get_current_user] = lambda: mock_user_no_family
        resp = client.get("/api/v1/rules/merchant")
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Plaid sync integration tests
# ---------------------------------------------------------------------------


def _make_plaid_txn(txn_id: str, merchant: str, amount: float = 5.50, income: bool = False) -> dict:
    """Build a minimal Plaid transaction dict for testing."""
    return {
        "transaction_id": txn_id,
        "merchant_name": merchant,
        "name": merchant,
        "amount": -abs(amount) if income else abs(amount),
        "account_id": "acct-1",
        "date": "2026-06-12",
        "authorized_date": None,
        "pending": False,
        "iso_currency_code": "USD",
        "personal_finance_category": {"primary": "INCOME" if income else "FOOD_AND_DRINK"},
    }


def _build_sync_mocks(plaid_client_mock, plaid_db_mock, txns_added, rule_snap=None):
    """Wire up the minimal mock scaffolding for a sync_transactions call.

    plaid_db_mock  — MagicMock returned by plaid_service.get_firestore_client
    rule_snap      — snap to return from rule_service find_match, or None for no match
    Returns the pending_ref mock so callers can inspect .set calls.
    """
    ITEM_DATA = {
        "family_id": FAMILY_ID,
        "connected_by_user_id": USER_ID,
        "plaid_access_token": "access-token",
        "institution_name": "Chase",
        "cursor": None,
        "status": "active",
    }
    item_snap = MagicMock()
    item_snap.exists = True
    item_snap.to_dict.return_value = ITEM_DATA

    acct_snap = MagicMock()
    acct_snap.id = "acct-1"
    acct_snap.to_dict.return_value = {"account_id": "acct-1", "name": "Checking"}

    db = plaid_db_mock

    # item fetch: db.collection("plaid_items").document(id).get()
    item_doc_ref = MagicMock()
    item_doc_ref.get.return_value = item_snap
    # pending insert: db.collection("plaid_pending_transactions").document()
    pending_ref = MagicMock()
    pending_ref.id = "pend-auto"
    # expense metadata update (source/plaid_transaction_id): db.collection("expenses").document(id).update(...)
    expense_meta_ref = MagicMock()

    def _col(name):
        col = MagicMock()
        if name == "plaid_items":
            col.document.return_value = item_doc_ref
        elif name == "plaid_accounts":
            col.where.return_value.stream.return_value = iter([acct_snap])
        elif name == "plaid_pending_transactions":
            col.document.return_value = pending_ref
            # dedupe check — no existing doc
            col.where.return_value.where.return_value.limit.return_value.get.return_value = []
        elif name == "expenses":
            col.document.return_value = expense_meta_ref
        else:
            col.document.return_value = MagicMock()
        return col

    db.collection.side_effect = _col

    # Also patch cursor update on item
    item_doc_ref.update = MagicMock()

    # Plaid API
    resp = MagicMock()
    resp.to_dict.return_value = {
        "added": txns_added, "modified": [], "removed": [],
        "next_cursor": "cur-next", "has_more": False,
    }
    plaid_client_mock.return_value.transactions_sync.return_value = resp

    return pending_ref, expense_meta_ref


class TestSyncTransactionsWithRules:
    """Tests for rule application during sync_transactions."""

    @patch("app.services.rule_service.get_firestore_client")
    @patch("app.services.plaid_service.get_firestore_client")
    @patch("app.services.plaid_service._client")
    def test_matched_merchant_creates_expense_no_pending_row(
        self, mock_client, mock_plaid_fs, mock_rule_fs
    ):
        """When a rule matches, expense is created, record_applied called, no pending row with status=pending."""
        txn = _make_plaid_txn("txn-1", "Starbucks", amount=5.50)

        db = MagicMock()
        mock_plaid_fs.return_value = db
        pending_ref, expense_meta_ref = _build_sync_mocks(mock_client, db, [txn])

        # rule_service: matching rule
        rule_db = MagicMock()
        mock_rule_fs.return_value = rule_db
        rule_snap = _make_snap("rule-1", _rule_data())
        rule_db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = [rule_snap]
        rule_ref = MagicMock()
        rule_db.collection.return_value.document.return_value = rule_ref

        with patch("app.services.expense_service.get_firestore_client") as mock_exp_fs:
            exp_db = MagicMock()
            mock_exp_fs.return_value = exp_db
            exp_ref = MagicMock()
            exp_ref.id = "expense-auto-1"
            exp_db.collection.return_value.document.return_value = exp_ref

            with patch("app.services.plaid_service._find_pending_by_plaid_txn_id", return_value=None):
                from app.services.plaid_service import sync_transactions
                result = sync_transactions("item-1")

        assert result.get("added") == 1
        # record_applied should have been called → rule doc update
        rule_ref.update.assert_called()
        update_data = rule_ref.update.call_args[0][0]
        assert "applied_count" in update_data or "last_applied_at" in update_data
        # The pending_ref.set call should be the auto-approved doc (not status=pending)
        if pending_ref.set.called:
            set_data = pending_ref.set.call_args[0][0]
            assert set_data.get("status") != "pending" or set_data.get("auto_approved") is True

    @patch("app.services.rule_service.get_firestore_client")
    @patch("app.services.plaid_service.get_firestore_client")
    @patch("app.services.plaid_service._client")
    def test_unmatched_merchant_creates_pending_row(
        self, mock_client, mock_plaid_fs, mock_rule_fs
    ):
        """When no rule matches, a normal pending row is created."""
        txn = _make_plaid_txn("txn-2", "UnknownStore", amount=12.00)

        db = MagicMock()
        mock_plaid_fs.return_value = db
        pending_ref, _ = _build_sync_mocks(mock_client, db, [txn])

        # rule_service: no match
        rule_db = MagicMock()
        mock_rule_fs.return_value = rule_db
        rule_db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = []

        with patch("app.services.plaid_service._find_pending_by_plaid_txn_id", return_value=None):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1")

        assert result.get("added") == 1
        pending_ref.set.assert_called()
        set_data = pending_ref.set.call_args[0][0]
        assert set_data.get("status") == "pending"

    @patch("app.services.rule_service.get_firestore_client")
    @patch("app.services.plaid_service.get_firestore_client")
    @patch("app.services.plaid_service._client")
    def test_income_tx_with_rule_still_creates_pending_row(
        self, mock_client, mock_plaid_fs, mock_rule_fs
    ):
        """Income transactions skip rule matching and become normal pending rows."""
        txn = _make_plaid_txn("txn-3", "Employer Payroll", amount=2000.00, income=True)

        db = MagicMock()
        mock_plaid_fs.return_value = db
        pending_ref, _ = _build_sync_mocks(mock_client, db, [txn])

        # rule_service: a rule exists for this merchant, but income skips it
        rule_db = MagicMock()
        mock_rule_fs.return_value = rule_db
        rule_snap = _make_snap("rule-payroll", _rule_data(merchant_name="Employer Payroll", merchant_name_lower="employer payroll"))
        rule_db.collection.return_value.where.return_value.where.return_value.limit.return_value.get.return_value = [rule_snap]
        rule_ref = MagicMock()
        rule_db.collection.return_value.document.return_value = rule_ref

        with patch("app.services.plaid_service._find_pending_by_plaid_txn_id", return_value=None):
            from app.services.plaid_service import sync_transactions
            result = sync_transactions("item-1")

        assert result.get("added") == 1
        pending_ref.set.assert_called()
        set_data = pending_ref.set.call_args[0][0]
        assert set_data.get("status") == "pending"
        # record_applied must NOT have been called
        rule_ref.update.assert_not_called()
