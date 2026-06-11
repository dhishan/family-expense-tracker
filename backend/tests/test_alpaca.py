"""Tests for Alpaca market-data helpers in app.services.market_data."""
from __future__ import annotations

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


def _clear_settings():
    from app.config import get_settings
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# _parse_occ_symbol
# ---------------------------------------------------------------------------

class TestParseOccSymbol:
    def test_call_contract(self):
        from app.services.market_data import _parse_occ_symbol
        result = _parse_occ_symbol("TSLA240621C00250000")
        assert result is not None
        assert result["root"] == "TSLA"
        assert result["expiration_date"] == "2024-06-21"
        assert result["option_type"] == "call"
        assert result["strike"] == 250.0

    def test_put_contract(self):
        from app.services.market_data import _parse_occ_symbol
        result = _parse_occ_symbol("AAPL240119P00150000")
        assert result is not None
        assert result["root"] == "AAPL"
        assert result["expiration_date"] == "2024-01-19"
        assert result["option_type"] == "put"
        assert result["strike"] == 150.0

    def test_invalid_returns_none(self):
        from app.services.market_data import _parse_occ_symbol
        assert _parse_occ_symbol("NOTANOCC") is None
        assert _parse_occ_symbol("") is None

    def test_fractional_strike(self):
        from app.services.market_data import _parse_occ_symbol
        # strike bytes = 00000500 => 0.5
        result = _parse_occ_symbol("SPY240621C00000500")
        assert result is not None
        assert result["strike"] == 0.5


# ---------------------------------------------------------------------------
# alpaca_quote
# ---------------------------------------------------------------------------

class TestAlpacaQuote:
    def test_returns_parsed_dict(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        quote_payload = {"quotes": {"AAPL": {"bp": 195.4, "ap": 195.6, "bs": 100, "as": 200, "t": "2024-06-01T10:00:00Z"}}}
        trade_payload = {"trades": {"AAPL": {"p": 195.5, "s": 500}}}

        responses = [_mock_response(quote_payload), _mock_response(trade_payload)]
        with patch("app.services.market_data._requests.get", side_effect=responses):
            from app.services import market_data
            result = market_data.alpaca_quote("AAPL")

        assert result["symbol"] == "AAPL"
        assert result["bid"] == 195.4
        assert result["ask"] == 195.6
        assert result["last_price"] == 195.5
        assert result["bid_size"] == 100

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "")
        _clear_settings()
        from app.services import market_data
        result = market_data.alpaca_quote("AAPL")
        assert "error" in result
        assert "APCA_API_KEY_ID" in result["error"]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()
        with patch("app.services.market_data._requests.get", side_effect=Exception("network error")):
            from app.services import market_data
            result = market_data.alpaca_quote("AAPL")
        assert "error" in result
        assert "network error" in result["error"]


# ---------------------------------------------------------------------------
# alpaca_bars
# ---------------------------------------------------------------------------

class TestAlpacaBars:
    def test_returns_ohlcv_rows(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        payload = {
            "bars": {
                "AAPL": [
                    {"t": "2024-01-02T05:00:00Z", "o": 185.0, "h": 186.0, "l": 184.0, "c": 185.5, "v": 40000000},
                    {"t": "2024-01-03T05:00:00Z", "o": 185.5, "h": 187.0, "l": 185.0, "c": 186.0, "v": 38000000},
                ]
            }
        }
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.alpaca_bars("AAPL")

        assert len(result) == 2
        assert result[0]["open"] == 185.0
        assert result[0]["close"] == 185.5
        assert result[0]["volume"] == 40000000

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "")
        _clear_settings()
        from app.services import market_data
        result = market_data.alpaca_bars("AAPL")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()
        with patch("app.services.market_data._requests.get", side_effect=Exception("timeout")):
            from app.services import market_data
            result = market_data.alpaca_bars("AAPL")
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# alpaca_option_expirations
# ---------------------------------------------------------------------------

def _snapshot_payload(occ_symbols: list[str], next_page_token: str | None = None) -> dict:
    """Build a canned Alpaca options/snapshots response."""
    snapshots = {sym: {"latestQuote": {}, "latestTrade": {}, "greeks": {}} for sym in occ_symbols}
    payload: dict = {"snapshots": snapshots}
    if next_page_token:
        payload["next_page_token"] = next_page_token
    return payload


class TestAlpacaOptionExpirations:
    def test_returns_sorted_unique_expirations(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        payload = _snapshot_payload([
            "AAPL240719C00200000",
            "AAPL240621C00200000",
            "AAPL240621P00200000",  # same exp as above — should deduplicate
            "AAPL240816C00200000",
        ])
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.alpaca_option_expirations("AAPL")

        assert result == ["2024-06-21", "2024-07-19", "2024-08-16"]

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "")
        _clear_settings()
        from app.services import market_data
        result = market_data.alpaca_option_expirations("AAPL")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()
        with patch("app.services.market_data._requests.get", side_effect=Exception("dns fail")):
            from app.services import market_data
            result = market_data.alpaca_option_expirations("AAPL")
        assert "error" in result[0]

    def test_paginates_through_multiple_pages(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        page1 = _snapshot_payload(["AAPL240621C00200000"], next_page_token="page2token")
        page2 = _snapshot_payload(["AAPL240719C00200000"])  # no next_page_token

        with patch("app.services.market_data._requests.get", side_effect=[
            _mock_response(page1), _mock_response(page2)
        ]):
            from app.services import market_data
            result = market_data.alpaca_option_expirations("AAPL")

        assert "2024-06-21" in result
        assert "2024-07-19" in result


# ---------------------------------------------------------------------------
# alpaca_option_chain
# ---------------------------------------------------------------------------

class TestAlpacaOptionChain:
    def _make_snapshot_payload(self) -> dict:
        return _snapshot_payload.__func__(  # call the module-level helper
            ["AAPL240621C00200000", "AAPL240621P00190000"]
        ) if False else {
            "snapshots": {
                "AAPL240621C00200000": {
                    "latestQuote": {"bp": 3.4, "ap": 3.6},
                    "latestTrade": {"p": 3.5, "s": 500},
                    "impliedVolatility": 0.25,
                    "openInterest": 12000,
                    "greeks": {
                        "delta": 0.45, "gamma": 0.02, "theta": -0.05, "vega": 0.30, "rho": 0.01
                    },
                },
                "AAPL240621P00190000": {
                    "latestQuote": {"bp": 2.1, "ap": 2.3},
                    "latestTrade": {"p": 2.2, "s": 300},
                    "impliedVolatility": 0.28,
                    "openInterest": 8000,
                    "greeks": {
                        "delta": -0.35, "gamma": 0.02, "theta": -0.04, "vega": 0.28, "rho": -0.01
                    },
                },
                # Different expiration — should be filtered out
                "AAPL240719C00200000": {
                    "latestQuote": {}, "latestTrade": {}, "greeks": {},
                },
            }
        }

    def test_filters_to_requested_expiration(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        with patch("app.services.market_data._requests.get",
                   return_value=_mock_response(self._make_snapshot_payload())):
            from app.services import market_data
            result = market_data.alpaca_option_chain("AAPL", "2024-06-21")

        assert len(result) == 2
        exp_dates = {r["expiration_date"] for r in result}
        assert exp_dates == {"2024-06-21"}

    def test_sorted_by_strike_ascending(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        with patch("app.services.market_data._requests.get",
                   return_value=_mock_response(self._make_snapshot_payload())):
            from app.services import market_data
            result = market_data.alpaca_option_chain("AAPL", "2024-06-21")

        strikes = [r["strike"] for r in result]
        assert strikes == sorted(strikes)

    def test_includes_greeks_when_requested(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        with patch("app.services.market_data._requests.get",
                   return_value=_mock_response(self._make_snapshot_payload())):
            from app.services import market_data
            result = market_data.alpaca_option_chain("AAPL", "2024-06-21", greeks=True)

        call = next(r for r in result if r["option_type"] == "call")
        assert "greeks" in call
        assert call["greeks"]["delta"] == 0.45
        assert call["greeks"]["mid_iv"] == 0.25

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "")
        _clear_settings()
        from app.services import market_data
        result = market_data.alpaca_option_chain("AAPL", "2024-06-21")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()
        with patch("app.services.market_data._requests.get", side_effect=Exception("timeout")):
            from app.services import market_data
            result = market_data.alpaca_option_chain("AAPL", "2024-06-21")
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# alpaca_option_strikes
# ---------------------------------------------------------------------------

class TestAlpacaOptionStrikes:
    def test_returns_sorted_unique_strikes(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()

        payload = {
            "snapshots": {
                "AAPL240621C00210000": {"latestQuote": {}, "latestTrade": {}, "greeks": {}},
                "AAPL240621C00190000": {"latestQuote": {}, "latestTrade": {}, "greeks": {}},
                "AAPL240621P00200000": {"latestQuote": {}, "latestTrade": {}, "greeks": {}},
                "AAPL240621C00200000": {"latestQuote": {}, "latestTrade": {}, "greeks": {}},
            }
        }
        with patch("app.services.market_data._requests.get", return_value=_mock_response(payload)):
            from app.services import market_data
            result = market_data.alpaca_option_strikes("AAPL", "2024-06-21")

        assert result == [190.0, 200.0, 210.0]

    def test_returns_error_when_unconfigured(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "")
        _clear_settings()
        from app.services import market_data
        result = market_data.alpaca_option_strikes("AAPL", "2024-06-21")
        assert isinstance(result, list)
        assert "error" in result[0]

    def test_returns_error_on_request_exception(self, monkeypatch):
        monkeypatch.setenv("APCA_API_KEY_ID", "test-key")
        monkeypatch.setenv("APCA_API_SECRET_KEY", "test-secret")
        _clear_settings()
        with patch("app.services.market_data._requests.get", side_effect=Exception("conn refused")):
            from app.services import market_data
            result = market_data.alpaca_option_strikes("AAPL", "2024-06-21")
        assert "error" in result[0]
