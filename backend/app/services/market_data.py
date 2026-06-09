"""Financial market data service wrapping FRED, Tiingo, and Finnhub APIs.

All functions are synchronous (blocking httpx) since they are called from
the chat agentic loop tool dispatcher and the hosted MCP server, neither of
which require async for tool execution.

API keys are read lazily from os.environ so the module imports cleanly even
when keys are absent (e.g. in unit tests that do not hit the real APIs).
"""
from __future__ import annotations

import os
from datetime import date, timedelta

import httpx

_TIMEOUT = 10.0  # seconds


# ---------------------------------------------------------------------------
# FRED — Federal Reserve Economic Data
# ---------------------------------------------------------------------------

def _fred_api_key() -> str:
    key = os.environ.get("FRED_API_KEY", "")
    if not key:
        raise RuntimeError(
            "FRED_API_KEY is not set. "
            "Sign up at https://fred.stlouisfed.org/docs/api/api_key.html (free, instant)."
        )
    return key


def fred_observation(series_id: str, limit: int = 1) -> dict:
    """Return the most recent observation(s) for a FRED series.

    Args:
        series_id: FRED series identifier, e.g. FEDFUNDS, CPIAUCSL, UNRATE.
        limit: Number of most-recent observations to return (default 1).

    Returns:
        Dict with keys: series_id, observations (list of {date, value}).
    """
    try:
        resp = httpx.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={
                "series_id": series_id,
                "api_key": _fred_api_key(),
                "file_type": "json",
                "sort_order": "desc",
                "limit": limit,
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        obs = data.get("observations", [])
        # Return in chronological order
        obs_sorted = list(reversed(obs))
        return {"series_id": series_id, "observations": obs_sorted}
    except RuntimeError:
        raise
    except Exception as exc:
        return {"error": str(exc), "series_id": series_id}


def fred_series(
    series_id: str,
    observation_start: str | None = None,
    observation_end: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Return historical observations for a FRED series.

    Args:
        series_id: FRED series identifier.
        observation_start: Start date in YYYY-MM-DD format (optional).
        observation_end: End date in YYYY-MM-DD format (optional).
        limit: Maximum number of observations (default 100).

    Returns:
        List of {date, value} dicts in chronological order.
    """
    try:
        params: dict = {
            "series_id": series_id,
            "api_key": _fred_api_key(),
            "file_type": "json",
            "sort_order": "asc",
            "limit": limit,
        }
        if observation_start:
            params["observation_start"] = observation_start
        if observation_end:
            params["observation_end"] = observation_end

        resp = httpx.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params=params,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("observations", [])
    except RuntimeError:
        raise
    except Exception as exc:
        return [{"error": str(exc)}]


# ---------------------------------------------------------------------------
# Tiingo — price history and fundamentals
# ---------------------------------------------------------------------------

def _tiingo_headers() -> dict:
    key = os.environ.get("TIINGO_API_KEY", "")
    if not key:
        raise RuntimeError(
            "TIINGO_API_KEY is not set. "
            "Sign up at https://www.tiingo.com (free, key in dashboard)."
        )
    return {"Authorization": f"Token {key}", "Content-Type": "application/json"}


def tiingo_eod(
    ticker: str,
    start: str | None = None,
    end: str | None = None,
) -> list[dict]:
    """End-of-day OHLCV price history for a ticker.

    Args:
        ticker: Stock symbol, e.g. AAPL, SPY.
        start: Start date YYYY-MM-DD (default: 1 year ago).
        end: End date YYYY-MM-DD (default: today).

    Returns:
        List of {date, open, high, low, close, volume, adjClose, ...} dicts.
    """
    if not start:
        start = (date.today() - timedelta(days=365)).isoformat()
    if not end:
        end = date.today().isoformat()
    try:
        resp = httpx.get(
            f"https://api.tiingo.com/tiingo/daily/{ticker.upper()}/prices",
            params={"startDate": start, "endDate": end},
            headers=_tiingo_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except RuntimeError:
        raise
    except Exception as exc:
        return [{"error": str(exc), "ticker": ticker}]


def tiingo_meta(ticker: str) -> dict:
    """Company metadata: name, exchange, description, first/last data date.

    Args:
        ticker: Stock symbol.

    Returns:
        Dict with name, description, exchange, startDate, endDate fields.
    """
    try:
        resp = httpx.get(
            f"https://api.tiingo.com/tiingo/daily/{ticker.upper()}",
            headers=_tiingo_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except RuntimeError:
        raise
    except Exception as exc:
        return {"error": str(exc), "ticker": ticker}


# ---------------------------------------------------------------------------
# Finnhub — news, sentiment, analyst data
# ---------------------------------------------------------------------------

def _finnhub_key() -> str:
    key = os.environ.get("FINNHUB_API_KEY", "")
    if not key:
        raise RuntimeError(
            "FINNHUB_API_KEY is not set. "
            "Sign up at https://finnhub.io (free, key in dashboard)."
        )
    return key


def finnhub_quote(symbol: str) -> dict:
    """Current price, day high/low, previous close for a symbol.

    Args:
        symbol: Stock ticker, e.g. AAPL.

    Returns:
        Dict with c (current), h (high), l (low), pc (prev close), t (timestamp).
    """
    try:
        resp = httpx.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": symbol.upper(), "token": _finnhub_key()},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        data["symbol"] = symbol.upper()
        return data
    except RuntimeError:
        raise
    except Exception as exc:
        return {"error": str(exc), "symbol": symbol}


def finnhub_company_news(symbol: str, days: int = 14) -> list[dict]:
    """Recent news articles for a company.

    Args:
        symbol: Stock ticker.
        days: Number of days of history (default 14).

    Returns:
        List of {datetime, headline, summary, url, source} dicts.
    """
    try:
        end = date.today()
        start = end - timedelta(days=days)
        resp = httpx.get(
            "https://finnhub.io/api/v1/company-news",
            params={
                "symbol": symbol.upper(),
                "from": start.isoformat(),
                "to": end.isoformat(),
                "token": _finnhub_key(),
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except RuntimeError:
        raise
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]


def finnhub_recommendations(symbol: str) -> list[dict]:
    """Analyst buy/hold/sell recommendation trends (typically last 4 months).

    Args:
        symbol: Stock ticker.

    Returns:
        List of {period, strongBuy, buy, hold, sell, strongSell} dicts.
    """
    try:
        resp = httpx.get(
            "https://finnhub.io/api/v1/stock/recommendation",
            params={"symbol": symbol.upper(), "token": _finnhub_key()},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except RuntimeError:
        raise
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]


def finnhub_price_target(symbol: str) -> dict:
    """Analyst consensus price target for a stock.

    Args:
        symbol: Stock ticker.

    Returns:
        Dict with targetHigh, targetLow, targetMean, targetMedian, lastUpdated.
    """
    try:
        resp = httpx.get(
            "https://finnhub.io/api/v1/stock/price-target",
            params={"symbol": symbol.upper(), "token": _finnhub_key()},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        data["symbol"] = symbol.upper()
        return data
    except RuntimeError:
        raise
    except Exception as exc:
        return {"error": str(exc), "symbol": symbol}


def finnhub_earnings_calendar(symbol: str, days_ahead: int = 90) -> list[dict]:
    """Upcoming earnings dates for a company.

    Args:
        symbol: Stock ticker.
        days_ahead: How far ahead to look (default 90 days).

    Returns:
        List of {date, symbol, epsEstimate, revenueEstimate, ...} dicts.
    """
    try:
        start = date.today()
        end = start + timedelta(days=days_ahead)
        resp = httpx.get(
            "https://finnhub.io/api/v1/calendar/earnings",
            params={
                "from": start.isoformat(),
                "to": end.isoformat(),
                "symbol": symbol.upper(),
                "token": _finnhub_key(),
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        # Returns {"earningsCalendar": [...]}
        return data.get("earningsCalendar", data)
    except RuntimeError:
        raise
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]
