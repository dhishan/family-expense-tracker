"""Tests for prediction market integrations in market_data.py.

Uses unittest.mock to avoid live network calls. Mocks httpx.get / httpx.post
so tests are hermetic.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import app.services.market_data as md


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_response(data, status_code: int = 200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data
    resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# Example API responses (representative shapes from each platform)
# ---------------------------------------------------------------------------

MANIFOLD_SEARCH_RESPONSE = [
    {
        "id": "abc123",
        "question": "Will the Fed cut rates in September 2025?",
        "probability": 0.43,
        "volume": 12500.0,
        "closeTime": 1756684800000,
        "url": "https://manifold.markets/user/will-fed-cut-sep",
        "isResolved": False,
        "outcomeType": "BINARY",
        "uniqueBettorCount": 347,
    },
    {
        "id": "def456",
        "question": "Will the Fed cut rates before year-end 2025?",
        "probability": 0.71,
        "volume": 8900.0,
        "closeTime": 1767225600000,
        "url": "https://manifold.markets/user/will-fed-cut-yearend",
        "isResolved": False,
        "outcomeType": "BINARY",
        "uniqueBettorCount": 210,
    },
]

POLYMARKET_SEARCH_RESPONSE = [
    {
        "question": "Will Israel and Iran reach a ceasefire by year-end 2025?",
        "slug": "israel-iran-ceasefire-2025",
        "outcomes": '["Yes", "No"]',
        "outcomePrices": '["0.18", "0.82"]',
        "volume24hr": 45000.0,
        "liquidity": 120000.0,
        "endDate": "2025-12-31T00:00:00Z",
        "closed": False,
    },
]

POLYMARKET_MULTI_OUTCOME_RESPONSE = [
    {
        "question": "Who wins the 2026 World Cup?",
        "slug": "2026-world-cup-winner",
        "outcomes": '["Brazil", "France", "Germany", "Spain", "Other"]',
        "outcomePrices": '["0.20", "0.18", "0.15", "0.14", "0.33"]',
        "volume24hr": 99000.0,
        "liquidity": 250000.0,
        "endDate": "2026-07-20T00:00:00Z",
        "closed": False,
    },
]

KALSHI_MARKETS_RESPONSE = {
    "markets": [
        {
            "ticker": "NVDA-200-Q3-25",
            "title": "Will NVDA close above $200 before Q3 2025 ends?",
            "subtitle": "NVDA > $200",
            "yes_bid": 62,
            "yes_ask": 64,
            "volume": 500000,
            "liquidity": 80000,
            "close_time": "2025-09-30T23:59:59Z",
            "status": "open",
        },
    ]
}

KALSHI_SINGLE_MARKET_RESPONSE = {
    "market": {
        "ticker": "FED-25SEP-T4.75",
        "title": "Fed funds rate above 4.75% after September 2025 meeting?",
        "subtitle": "FOMC Sep 2025",
        "yes_bid": 38,
        "yes_ask": 40,
        "volume": 1200000,
        "liquidity": 300000,
        "close_time": "2025-09-18T18:00:00Z",
        "status": "open",
    }
}


# ---------------------------------------------------------------------------
# Manifold tests
# ---------------------------------------------------------------------------

class TestManifoldSearch:
    def test_returns_list_with_question_field(self):
        with patch("httpx.get", return_value=_mock_response(MANIFOLD_SEARCH_RESPONSE)):
            result = md.manifold_search("fed rate cut")
        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["question"] == "Will the Fed cut rates in September 2025?"
        assert result[0]["id"] == "abc123"

    def test_normalizes_probability_field(self):
        with patch("httpx.get", return_value=_mock_response(MANIFOLD_SEARCH_RESPONSE)):
            result = md.manifold_search("fed")
        assert result[0]["probability"] == 0.43
        assert result[1]["probability"] == 0.71

    def test_returns_empty_list_on_network_exception(self):
        with patch("httpx.get", side_effect=Exception("network down")):
            result = md.manifold_search("fed rate cut")
        # Should return error dict in list, not raise
        assert isinstance(result, list)
        assert len(result) == 1
        assert "error" in result[0]

    def test_passes_limit_param(self):
        with patch("httpx.get", return_value=_mock_response([])) as mock_get:
            md.manifold_search("inflation", limit=5)
        call_kwargs = mock_get.call_args
        params = call_kwargs[1]["params"] if "params" in call_kwargs[1] else call_kwargs[0][1]
        assert params["limit"] == 5


class TestManifoldMarket:
    def test_returns_single_market(self):
        single = MANIFOLD_SEARCH_RESPONSE[0]
        with patch("httpx.get", return_value=_mock_response(single)):
            result = md.manifold_market("abc123")
        assert result["id"] == "abc123"
        assert result["traders"] == 347

    def test_error_on_network_exception(self):
        with patch("httpx.get", side_effect=Exception("timeout")):
            result = md.manifold_market("bad-id")
        assert "error" in result


# ---------------------------------------------------------------------------
# Polymarket tests
# ---------------------------------------------------------------------------

class TestPolymarketSearch:
    def test_returns_list_with_question_field(self):
        with patch("httpx.get", return_value=_mock_response(POLYMARKET_SEARCH_RESPONSE)):
            result = md.polymarket_search("israel iran ceasefire")
        assert isinstance(result, list)
        assert len(result) == 1
        assert "ceasefire" in result[0]["question"].lower()

    def test_parses_outcome_prices_json_string(self):
        """outcomePrices comes as a stringified JSON array from Polymarket."""
        with patch("httpx.get", return_value=_mock_response(POLYMARKET_SEARCH_RESPONSE)):
            result = md.polymarket_search("israel iran")
        assert result[0]["yes_price"] == pytest.approx(0.18)
        assert result[0]["no_price"] == pytest.approx(0.82)

    def test_builds_url_from_slug(self):
        with patch("httpx.get", return_value=_mock_response(POLYMARKET_SEARCH_RESPONSE)):
            result = md.polymarket_search("ceasefire")
        assert result[0]["url"] == "https://polymarket.com/event/israel-iran-ceasefire-2025"

    def test_handles_multi_outcome_market(self):
        with patch("httpx.get", return_value=_mock_response(POLYMARKET_MULTI_OUTCOME_RESPONSE)):
            result = md.polymarket_search("world cup")
        # Multi-outcome markets should include raw outcomes dict
        assert "outcomes" in result[0]
        assert "Brazil" in result[0]["outcomes"]

    def test_returns_empty_list_on_network_exception(self):
        with patch("httpx.get", side_effect=Exception("timeout")):
            result = md.polymarket_search("fed cut")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_handles_list_response(self):
        """Gamma API can return plain list or wrapped dict."""
        with patch("httpx.get", return_value=_mock_response(POLYMARKET_SEARCH_RESPONSE)):
            result = md.polymarket_search("ceasefire")
        assert isinstance(result, list)

    def test_handles_dict_wrapped_response(self):
        wrapped = {"markets": POLYMARKET_SEARCH_RESPONSE}
        with patch("httpx.get", return_value=_mock_response(wrapped)):
            result = md.polymarket_search("ceasefire")
        assert isinstance(result, list)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Kalshi tests
# ---------------------------------------------------------------------------

class TestKalshiSearch:
    def test_returns_friendly_error_when_no_api_key_set(self):
        """When no Kalshi credentials are configured, return error list — do not crash."""
        # Ensure env vars are unset
        with patch.dict("os.environ", {}, clear=False):
            import os
            for key in ("KALSHI_API_KEY", "KALSHI_EMAIL", "KALSHI_PASSWORD"):
                os.environ.pop(key, None)
            result = md.kalshi_search("NVDA $200")
        assert isinstance(result, list)
        assert len(result) == 1
        assert "error" in result[0]
        assert "Kalshi" in result[0]["error"] or "not configured" in result[0]["error"].lower()

    def test_returns_markets_when_api_key_set(self):
        with patch.dict("os.environ", {"KALSHI_API_KEY": "test-key"}):
            with patch("httpx.get", return_value=_mock_response(KALSHI_MARKETS_RESPONSE)):
                result = md.kalshi_search("NVDA")
        assert isinstance(result, list)
        assert result[0]["ticker"] == "NVDA-200-Q3-25"

    def test_converts_cents_to_probability(self):
        with patch.dict("os.environ", {"KALSHI_API_KEY": "test-key"}):
            with patch("httpx.get", return_value=_mock_response(KALSHI_MARKETS_RESPONSE)):
                result = md.kalshi_search("NVDA")
        assert result[0]["yes_bid"] == pytest.approx(0.62)
        assert result[0]["yes_ask"] == pytest.approx(0.64)

    def test_returns_empty_list_on_network_exception(self):
        with patch.dict("os.environ", {"KALSHI_API_KEY": "test-key"}):
            with patch("httpx.get", side_effect=Exception("network down")):
                result = md.kalshi_search("NVDA")
        assert isinstance(result, list)
        assert "error" in result[0]


class TestKalshiMarket:
    def test_returns_single_market(self):
        with patch.dict("os.environ", {"KALSHI_API_KEY": "test-key"}):
            with patch("httpx.get", return_value=_mock_response(KALSHI_SINGLE_MARKET_RESPONSE)):
                result = md.kalshi_market("FED-25SEP-T4.75")
        assert result["ticker"] == "FED-25SEP-T4.75"
        assert result["yes_bid"] == pytest.approx(0.38)

    def test_returns_friendly_error_when_no_credentials(self):
        import os
        for key in ("KALSHI_API_KEY", "KALSHI_EMAIL", "KALSHI_PASSWORD"):
            os.environ.pop(key, None)
        result = md.kalshi_market("FED-25SEP-T4.75")
        assert "error" in result
