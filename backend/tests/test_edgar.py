"""Tests for SEC EDGAR integration in market_data.py.

Uses pytest + unittest.mock to avoid live network calls. The module-level
_cik_map cache is reset between tests that need to control it.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import app.services.market_data as md


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MOCK_TICKERS_JSON = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "MSFT", "title": "Microsoft Corporation"},
    "2": {"cik_str": 1018724, "ticker": "AMZN", "title": "Amazon.com, Inc."},
}

MOCK_SUBMISSIONS = {
    "cik": "0000320193",
    "entityType": "operating",
    "sic": "3571",
    "sicDescription": "Electronic Computers",
    "name": "Apple Inc.",
    "filings": {
        "recent": {
            "accessionNumber": [
                "0000320193-24-000123",
                "0000320193-24-000456",
                "0000320193-23-000789",
            ],
            "filingDate": ["2024-11-01", "2024-08-02", "2024-05-03"],
            "form": ["10-K", "10-Q", "10-Q"],
            "primaryDocument": ["aapl-20240928.htm", "aapl-20240629.htm", "aapl-20240330.htm"],
            "reportDate": ["2024-09-28", "2024-06-29", "2024-03-30"],
        }
    },
}

MOCK_COMPANY_FACTS = {
    "cik": "0000320193",
    "entityName": "Apple Inc.",
    "facts": {
        "us-gaap": {
            "Revenues": {
                "label": "Revenues",
                "description": "Total revenues",
                "units": {
                    "USD": [
                        {"end": "2023-09-30", "val": 383285000000, "form": "10-K", "accn": "0000320193-23-000106"},
                        {"end": "2024-09-28", "val": 391035000000, "form": "10-K", "accn": "0000320193-24-000123"},
                    ]
                },
            },
            "NetIncomeLoss": {
                "label": "Net Income (Loss)",
                "description": "Net income or loss",
                "units": {
                    "USD": [
                        {"end": "2024-09-28", "val": 93736000000, "form": "10-K", "accn": "0000320193-24-000123"},
                    ]
                },
            },
        },
        "dei": {},
    },
}


def _mock_response(data: dict, status_code: int = 200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data
    resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# _edgar_cik_map — cache behavior
# ---------------------------------------------------------------------------

class TestEdgarCikMap:
    def setup_method(self):
        # Reset module-level cache before each test.
        md._cik_map = None

    def test_cache_miss_fetches_and_populates(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_TICKERS_JSON)) as mock_get:
            result = md._edgar_cik_map()

        mock_get.assert_called_once()
        assert "AAPL" in result
        assert result["AAPL"]["cik"] == 320193
        assert result["AAPL"]["title"] == "Apple Inc."
        assert md._cik_map is result  # cache populated

    def test_cache_hit_skips_network(self):
        # Pre-populate cache
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}

        with patch("httpx.get") as mock_get:
            result = md._edgar_cik_map()

        mock_get.assert_not_called()
        assert result["AAPL"]["cik"] == 320193

    def test_tickers_normalized_to_uppercase(self):
        raw = {"0": {"cik_str": 320193, "ticker": "aapl", "title": "Apple Inc."}}
        with patch("httpx.get", return_value=_mock_response(raw)):
            result = md._edgar_cik_map()

        assert "AAPL" in result
        assert "aapl" not in result


# ---------------------------------------------------------------------------
# edgar_company_lookup
# ---------------------------------------------------------------------------

class TestEdgarCompanyLookup:
    def setup_method(self):
        md._cik_map = None

    def test_known_ticker(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}
        result = md.edgar_company_lookup("AAPL")
        assert result["cik"] == 320193
        assert result["title"] == "Apple Inc."

    def test_lowercase_input_normalised(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}
        result = md.edgar_company_lookup("aapl")
        assert result["cik"] == 320193

    def test_unknown_ticker_returns_error(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}
        result = md.edgar_company_lookup("FAKEXYZ")
        assert "error" in result
        assert "FAKEXYZ" in result["error"]


# ---------------------------------------------------------------------------
# edgar_recent_filings
# ---------------------------------------------------------------------------

class TestEdgarRecentFilings:
    def setup_method(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}

    def test_returns_filings_no_filter(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_SUBMISSIONS)):
            result = md.edgar_recent_filings("AAPL")

        assert len(result) == 3
        assert result[0]["form"] == "10-K"
        assert result[0]["filingDate"] == "2024-11-01"
        assert "accessionNumber" in result[0]
        assert "url" in result[0]

    def test_form_type_filter(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_SUBMISSIONS)):
            result = md.edgar_recent_filings("AAPL", form_type="10-K")

        assert len(result) == 1
        assert result[0]["form"] == "10-K"

    def test_form_type_filter_no_match(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_SUBMISSIONS)):
            result = md.edgar_recent_filings("AAPL", form_type="4")

        assert result == []

    def test_limit_respected(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_SUBMISSIONS)):
            result = md.edgar_recent_filings("AAPL", limit=2)

        assert len(result) == 2

    def test_unknown_ticker_returns_error_list(self):
        md._cik_map = {}
        result = md.edgar_recent_filings("FAKEXYZ")
        assert len(result) == 1
        assert "error" in result[0]

    def test_form_type_case_insensitive(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_SUBMISSIONS)):
            result = md.edgar_recent_filings("AAPL", form_type="10-k")

        assert len(result) == 1
        assert result[0]["form"] == "10-K"


# ---------------------------------------------------------------------------
# edgar_company_facts
# ---------------------------------------------------------------------------

class TestEdgarCompanyFacts:
    def setup_method(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}

    def test_summary_mode(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_COMPANY_FACTS)):
            result = md.edgar_company_facts("AAPL")

        assert result["ticker"] == "AAPL"
        assert result["entity"] == "Apple Inc."
        assert "key_facts" in result
        assert "Revenues" in result["key_facts"]
        assert result["key_facts"]["Revenues"]["value"] == 391035000000

    def test_specific_concept(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_COMPANY_FACTS)):
            result = md.edgar_company_facts("AAPL", concept="Revenues")

        assert result["concept"] == "Revenues"
        assert "units" in result
        assert "USD" in result["units"]

    def test_missing_concept_returns_error_with_available(self):
        with patch("httpx.get", return_value=_mock_response(MOCK_COMPANY_FACTS)):
            result = md.edgar_company_facts("AAPL", concept="NonexistentConcept")

        assert "error" in result
        assert "available_concepts_sample" in result

    def test_unknown_ticker(self):
        md._cik_map = {}
        result = md.edgar_company_facts("FAKEXYZ")
        assert "error" in result


# ---------------------------------------------------------------------------
# edgar_insider_transactions
# ---------------------------------------------------------------------------

class TestEdgarInsiderTransactions:
    def setup_method(self):
        md._cik_map = {"AAPL": {"ticker": "AAPL", "cik": 320193, "title": "Apple Inc."}}

    def test_filters_form_4_only(self):
        from datetime import date, timedelta
        recent_date = (date.today() - timedelta(days=10)).isoformat()
        older_date = (date.today() - timedelta(days=20)).isoformat()
        submissions = {
            "filings": {
                "recent": {
                    "accessionNumber": ["0000320193-26-000111", "0000320193-26-000222"],
                    "filingDate": [recent_date, older_date],
                    "form": ["4", "10-Q"],
                    "primaryDocument": ["form4.xml", "10q.htm"],
                    "reportDate": [recent_date, older_date],
                }
            }
        }
        with patch("httpx.get", return_value=_mock_response(submissions)):
            result = md.edgar_insider_transactions("AAPL", days=90)

        assert len(result) == 1
        assert result[0]["form"] == "4"

    def test_no_filings_returns_message(self):
        # Submissions with no Form 4 filings
        submissions = {
            "filings": {
                "recent": {
                    "accessionNumber": ["0000320193-24-000123"],
                    "filingDate": ["2024-11-01"],
                    "form": ["10-K"],
                    "primaryDocument": ["10k.htm"],
                    "reportDate": ["2024-09-28"],
                }
            }
        }
        with patch("httpx.get", return_value=_mock_response(submissions)):
            result = md.edgar_insider_transactions("AAPL", days=90)

        assert len(result) == 1
        assert "message" in result[0] or "error" not in result[0]
