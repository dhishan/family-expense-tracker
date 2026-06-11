"""Tests for Tradier market-data helpers in app.services.market_data."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_response(payload: dict, status_code: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = payload
    resp.raise_for_status = MagicMock()
    return resp


# ---------------------------------------------------------------------------
# tradier_quote
# ---------------------------------------------------------------------------

class TestTradierQuote:
    def test_returns_parsed_dict(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        payload = {
            "quotes": {
                "quote": {
                    "symbol": "AAPL",
                    "description": "Apple Inc",
                    "last": 195.5,
                    "change": 1.2,
                    "change_percentage": 0.62,
                    "bid": 195.4,
                    "ask": 195.6,
                    "volume": 50000000,
                    "high": 196.0,
                    "low": 194.0,
                    "open": 194.5,
                    "prevclose": 194.3,
                }
            }
        }
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            # Bust the lru_cache on settings so monkeypatched env is picked up
            from app.config import get_settings
            get_settings.cache_clear()
            result = market_data.tradier_quote("AAPL")

        assert result["symbol"] == "AAPL"
        assert result["last"] == 195.5
        assert result["bid"] == 195.4
        assert result["ask"] == 195.6
        assert result["change_pct"] == 0.62
        assert result["prev_close"] == 194.3

    def test_normalises_list_shape(self, monkeypatch):
        """quote may come back as a list for multi-symbol calls — take first item."""
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        payload = {
            "quotes": {
                "quote": [
                    {"symbol": "NVDA", "last": 900.0, "change": 5.0, "change_percentage": 0.56,
                     "bid": 899.0, "ask": 901.0, "volume": 1000000, "high": 905.0,
                     "low": 895.0, "open": 896.0, "prevclose": 895.0, "description": "NVIDIA"},
                ]
            }
        }
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            from app.config import get_settings
            get_settings.cache_clear()
            result = market_data.tradier_quote("NVDA")

        assert result["symbol"] == "NVDA"
        assert result["last"] == 900.0

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_quote("AAPL")
        assert "error" in result
        assert "TRADIER_TOKEN" in result["error"]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get", side_effect=Exception("network error")):
            from app.services import market_data
            result = market_data.tradier_quote("AAPL")
        assert "error" in result
        assert "network error" in result["error"]


# ---------------------------------------------------------------------------
# tradier_option_chain — shape normalisation
# ---------------------------------------------------------------------------

class TestTradierOptionChain:
    def _chain_payload(self, as_list: bool = True):
        contract = {
            "symbol": "AAPL240621C00200000",
            "description": "AAPL Jun 21 2024 $200 Call",
            "option_type": "call",
            "strike": 200.0,
            "expiration_date": "2024-06-21",
            "last": 3.5,
            "bid": 3.4,
            "ask": 3.6,
            "volume": 500,
            "open_interest": 12000,
            "greeks": {
                "delta": 0.45,
                "gamma": 0.02,
                "theta": -0.05,
                "vega": 0.30,
                "rho": 0.01,
                "mid_iv": 0.25,
                "bid_iv": 0.24,
                "ask_iv": 0.26,
            },
        }
        return {"options": {"option": [contract] if as_list else contract}}

    def test_normalises_list_shape(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get",
                   return_value=_mock_response(self._chain_payload(as_list=True))):
            from app.services import market_data
            result = market_data.tradier_option_chain("AAPL", "2024-06-21")
        assert len(result) == 1
        assert result[0]["option_type"] == "call"
        assert result[0]["greeks"]["delta"] == 0.45

    def test_normalises_dict_shape(self, monkeypatch):
        """options.option may be a dict (single contract) — normalise to list."""
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get",
                   return_value=_mock_response(self._chain_payload(as_list=False))):
            from app.services import market_data
            result = market_data.tradier_option_chain("AAPL", "2024-06-21")
        assert len(result) == 1
        assert result[0]["strike"] == 200.0

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_option_chain("AAPL", "2024-06-21")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get", side_effect=Exception("timeout")):
            from app.services import market_data
            result = market_data.tradier_option_chain("AAPL", "2024-06-21")
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# tradier_option_expirations
# ---------------------------------------------------------------------------

class TestTradierOptionExpirations:
    def test_returns_sorted_list(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        payload = {"expirations": {"date": ["2024-07-19", "2024-06-21", "2024-08-16"]}}
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.tradier_option_expirations("AAPL")
        assert result == ["2024-06-21", "2024-07-19", "2024-08-16"]

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_option_expirations("AAPL")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get", side_effect=Exception("dns fail")):
            from app.services import market_data
            result = market_data.tradier_option_expirations("AAPL")
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# tradier_option_strikes
# ---------------------------------------------------------------------------

class TestTradierOptionStrikes:
    def test_returns_sorted_floats(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        payload = {"strikes": {"strike": [210.0, 190.0, 200.0]}}
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.tradier_option_strikes("AAPL", "2024-06-21")
        assert result == [190.0, 200.0, 210.0]

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_option_strikes("AAPL", "2024-06-21")
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get", side_effect=Exception("conn refused")):
            from app.services import market_data
            result = market_data.tradier_option_strikes("AAPL", "2024-06-21")
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# tradier_historical_quotes
# ---------------------------------------------------------------------------

class TestTradierHistoricalQuotes:
    def test_returns_ohlcv_rows(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        payload = {
            "history": {
                "day": [
                    {"date": "2024-01-02", "open": 185.0, "high": 186.0, "low": 184.0, "close": 185.5, "volume": 40000000},
                    {"date": "2024-01-03", "open": 185.5, "high": 187.0, "low": 185.0, "close": 186.0, "volume": 38000000},
                ]
            }
        }
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.tradier_historical_quotes("AAPL", "2024-01-02", "2024-01-03")
        assert len(result) == 2
        assert result[0]["date"] == "2024-01-02"

    def test_rejects_oversized_range(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_historical_quotes("AAPL", "2020-01-01", "2024-12-31")
        assert "error" in result[0]
        assert "candles" in result[0]["error"]

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "")
        from app.config import get_settings
        get_settings.cache_clear()
        from app.services import market_data
        result = market_data.tradier_historical_quotes("AAPL", "2024-01-01", "2024-01-31")
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("TRADIER_TOKEN", "test-token")
        from app.config import get_settings
        get_settings.cache_clear()
        with patch("app.services.market_data._requests.get", side_effect=Exception("server error")):
            from app.services import market_data
            result = market_data.tradier_historical_quotes("AAPL", "2024-01-01", "2024-01-31")
        assert "error" in result[0]
