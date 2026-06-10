"""Tests for plaid_service Firestore helpers.

These tests mock the Firestore client so no real GCP connection is needed.
They verify the ownership-check contract: get_item and list_items must
only return docs belonging to the requesting family_id.

Phase 3: ownership is family-scoped, not user-scoped.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.services.plaid_service import (
    PLAID_ACCOUNTS_COLLECTION,
    PLAID_ITEMS_COLLECTION,
    delete_item,
    get_item,
    list_items,
    upsert_item,
)


def _make_snap(doc_id: str, data: dict) -> MagicMock:
    """Build a fake Firestore DocumentSnapshot."""
    snap = MagicMock()
    snap.exists = True
    snap.id = doc_id
    snap.to_dict.return_value = dict(data)
    snap.reference = MagicMock()
    return snap


def _make_missing_snap() -> MagicMock:
    snap = MagicMock()
    snap.exists = False
    snap.to_dict.return_value = {}
    return snap


# ---------------------------------------------------------------------------
# get_item
# ---------------------------------------------------------------------------


class TestGetItem:
    def test_returns_doc_when_family_matches(self):
        item_id = "item_abc"
        family_id = "fam-001"
        stored = {
            "family_id": family_id,
            "connected_by_user_id": "user_1",
            "plaid_item_id": item_id,
            "institution_name": "Chase",
            "plaid_access_token": "access-sandbox-secret",
            "status": "active",
        }
        snap = _make_snap(item_id, stored)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            result = get_item(item_id, family_id)

        assert result is not None
        assert result["id"] == item_id
        assert result["institution_name"] == "Chase"
        # Access token must never be returned to callers.
        assert "plaid_access_token" not in result

    def test_returns_none_when_family_mismatches(self, caplog):
        item_id = "item_abc"
        family_id = "fam-001"
        requester_family = "fam-002"
        stored = {
            "family_id": family_id,
            "connected_by_user_id": "user_1",
            "plaid_item_id": item_id,
            "institution_name": "Chase",
            "plaid_access_token": "access-sandbox-secret",
            "status": "active",
        }
        snap = _make_snap(item_id, stored)

        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = snap

        import logging
        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            with caplog.at_level(logging.WARNING, logger="app.services.plaid_service"):
                result = get_item(item_id, requester_family)

        assert result is None
        assert any("Cross-family" in r.message for r in caplog.records)

    def test_returns_none_when_doc_missing(self):
        mock_db = MagicMock()
        mock_db.collection.return_value.document.return_value.get.return_value = (
            _make_missing_snap()
        )

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            result = get_item("nonexistent_item", "fam-001")

        assert result is None


# ---------------------------------------------------------------------------
# list_items
# ---------------------------------------------------------------------------


class TestListItems:
    def test_returns_only_matching_family_items(self):
        family_id = "fam-001"
        items = [
            {"family_id": family_id, "connected_by_user_id": "user_1",
             "plaid_item_id": "item_1", "institution_name": "Chase",
             "plaid_access_token": "tok_1", "status": "active"},
            {"family_id": family_id, "connected_by_user_id": "user_2",
             "plaid_item_id": "item_2", "institution_name": "BofA",
             "plaid_access_token": "tok_2", "status": "active"},
        ]
        snaps = [_make_snap(d["plaid_item_id"], d) for d in items]

        mock_query = MagicMock()
        mock_query.stream.return_value = iter(snaps)

        mock_collection = MagicMock()
        mock_collection.where.return_value.order_by.return_value = mock_query

        mock_db = MagicMock()
        mock_db.collection.return_value = mock_collection

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            result = list_items(family_id)

        assert len(result) == 2
        ids = {r["id"] for r in result}
        assert ids == {"item_1", "item_2"}
        # Access token must never be returned.
        for r in result:
            assert "plaid_access_token" not in r

    def test_returns_empty_list_when_no_items(self):
        mock_query = MagicMock()
        mock_query.stream.return_value = iter([])

        mock_collection = MagicMock()
        mock_collection.where.return_value.order_by.return_value = mock_query

        mock_db = MagicMock()
        mock_db.collection.return_value = mock_collection

        with patch("app.services.plaid_service.get_firestore_client", return_value=mock_db):
            result = list_items("fam-nobody")

        assert result == []
