"""Financial market data service wrapping FRED, Tiingo, Finnhub, and SEC EDGAR APIs.

All functions are synchronous (blocking httpx) since they are called from
the chat agentic loop tool dispatcher and the hosted MCP server, neither of
which require async for tool execution.

API keys are read lazily from os.environ so the module imports cleanly even
when keys are absent (e.g. in unit tests that do not hit the real APIs).
"""
from __future__ import annotations

import os
from datetime import date, timedelta
from typing import Optional

import httpx

_TIMEOUT = 10.0  # seconds
_EDGAR_UA = "Family Expense Tracker iamdhishan@gmail.com"
_EDGAR_HEADERS = {"User-Agent": _EDGAR_UA, "Accept-Encoding": "gzip,deflate"}

# Module-level cache for the CIK-ticker map (~1 MB, fetched once per process).
_cik_map: dict[str, dict] | None = None  # keyed by uppercase ticker


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


# ---------------------------------------------------------------------------
# SEC EDGAR — free, no API key required
# ---------------------------------------------------------------------------

def _edgar_cik_map() -> dict[str, dict]:
    """Return (and cache) the SEC CIK-to-ticker map.

    Fetches https://www.sec.gov/files/company_tickers.json once per process.
    The returned dict is keyed by uppercase ticker symbol.
    """
    global _cik_map
    if _cik_map is not None:
        return _cik_map

    resp = httpx.get(
        "https://www.sec.gov/files/company_tickers.json",
        headers=_EDGAR_HEADERS,
        timeout=15.0,
    )
    resp.raise_for_status()
    raw = resp.json()  # {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
    mapping: dict[str, dict] = {}
    for entry in raw.values():
        ticker = (entry.get("ticker") or "").upper()
        if ticker:
            mapping[ticker] = {
                "ticker": ticker,
                "cik": entry["cik_str"],
                "title": entry.get("title", ""),
            }
    _cik_map = mapping
    return _cik_map


def edgar_company_lookup(ticker: str) -> dict:
    """Resolve a ticker to its SEC CIK number and company name.

    Args:
        ticker: Stock symbol, e.g. AAPL.

    Returns:
        Dict with ticker, cik (int), title. Error dict if not found.
    """
    try:
        mapping = _edgar_cik_map()
        key = ticker.upper()
        if key not in mapping:
            return {"error": f"Ticker {ticker!r} not found in SEC EDGAR company list"}
        return mapping[key]
    except Exception as exc:
        return {"error": str(exc), "ticker": ticker}


def edgar_recent_filings(
    ticker: str,
    form_type: Optional[str] = None,
    limit: int = 20,
) -> list[dict]:
    """Recent SEC filings for a company.

    Args:
        ticker: Stock symbol, e.g. AAPL.
        form_type: Optional filter, e.g. "10-K", "10-Q", "8-K", "4", "DEF 14A".
        limit: Max filings to return (default 20).

    Returns:
        List of {form, filingDate, accessionNumber, primaryDocument, reportDate, url} dicts.
    """
    try:
        info = edgar_company_lookup(ticker)
        if "error" in info:
            return [info]  # type: ignore[list-item]

        cik = info["cik"]
        cik_padded = f"{cik:010d}"

        resp = httpx.get(
            f"https://data.sec.gov/submissions/CIK{cik_padded}.json",
            headers=_EDGAR_HEADERS,
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()

        recent = data.get("filings", {}).get("recent", {})
        forms = recent.get("form", [])
        filing_dates = recent.get("filingDate", [])
        accession_numbers = recent.get("accessionNumber", [])
        primary_docs = recent.get("primaryDocument", [])
        report_dates = recent.get("reportDate", [])

        results: list[dict] = []
        for i, form in enumerate(forms):
            if form_type and form.upper() != form_type.upper():
                continue
            acc = accession_numbers[i] if i < len(accession_numbers) else ""
            acc_nodash = acc.replace("-", "")
            primary_doc = primary_docs[i] if i < len(primary_docs) else ""
            url = (
                f"https://www.sec.gov/Archives/edgar/full-index/"
                f"{filing_dates[i][:4]}/QTR{(int(filing_dates[i][5:7]) - 1) // 3 + 1}/"
            ) if not acc_nodash else (
                f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{primary_doc}"
            )
            results.append({
                "form": form,
                "filingDate": filing_dates[i] if i < len(filing_dates) else "",
                "accessionNumber": acc,
                "primaryDocument": primary_doc,
                "reportDate": report_dates[i] if i < len(report_dates) else "",
                "url": url,
            })
            if len(results) >= limit:
                break

        return results
    except Exception as exc:
        return [{"error": str(exc), "ticker": ticker}]


def edgar_company_facts(ticker: str, concept: Optional[str] = None) -> dict:
    """SEC XBRL financial facts for a company (revenue, earnings, assets, etc.).

    Args:
        ticker: Stock symbol, e.g. AAPL.
        concept: Optional XBRL concept name to filter to, e.g. "Revenues",
                 "NetIncomeLoss", "Assets", "EarningsPerShareBasic".
                 If omitted, returns a summary of available concepts with their latest values.

    Returns:
        If concept provided: full history for that concept with units and filing dates.
        Otherwise: dict with entity name, cik, and summary of top concepts.
    """
    try:
        info = edgar_company_lookup(ticker)
        if "error" in info:
            return info

        cik = info["cik"]
        cik_padded = f"{cik:010d}"

        resp = httpx.get(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik_padded}.json",
            headers=_EDGAR_HEADERS,
            timeout=20.0,
        )
        resp.raise_for_status()
        data = resp.json()

        entity_name = data.get("entityName", info["title"])
        facts = data.get("facts", {})
        us_gaap = facts.get("us-gaap", {})
        dei = facts.get("dei", {})

        if concept:
            # Search in us-gaap first, then dei
            concept_data = us_gaap.get(concept) or dei.get(concept)
            if not concept_data:
                # Case-insensitive fallback
                concept_lower = concept.lower()
                for k, v in us_gaap.items():
                    if k.lower() == concept_lower:
                        concept_data = v
                        break
            if not concept_data:
                available = sorted(us_gaap.keys())[:30]
                return {
                    "error": f"Concept {concept!r} not found",
                    "available_concepts_sample": available,
                    "ticker": ticker,
                }
            return {
                "ticker": ticker,
                "entity": entity_name,
                "concept": concept,
                "label": concept_data.get("label", concept),
                "description": concept_data.get("description", ""),
                "units": concept_data.get("units", {}),
            }

        # Summary: pull latest value for a curated set of key concepts
        key_concepts = [
            "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
            "NetIncomeLoss", "Assets", "Liabilities",
            "StockholdersEquity", "CashAndCashEquivalentsAtCarryingValue",
            "EarningsPerShareBasic", "EarningsPerShareDiluted",
            "CommonStockSharesOutstanding",
        ]
        summary: dict[str, dict] = {}
        for c in key_concepts:
            cdata = us_gaap.get(c)
            if not cdata:
                continue
            units = cdata.get("units", {})
            # Try USD first, then shares, then pure
            for unit_key in ("USD", "shares", "USD/shares"):
                entries = units.get(unit_key, [])
                if entries:
                    # Get the most recent 10-K or 10-Q entry
                    annual = [e for e in entries if e.get("form") in ("10-K", "10-Q")]
                    latest = annual[-1] if annual else entries[-1]
                    summary[c] = {
                        "label": cdata.get("label", c),
                        "unit": unit_key,
                        "value": latest.get("val"),
                        "end": latest.get("end"),
                        "form": latest.get("form"),
                    }
                    break

        return {
            "ticker": ticker,
            "entity": entity_name,
            "cik": cik,
            "available_concepts": len(us_gaap),
            "key_facts": summary,
        }
    except Exception as exc:
        return {"error": str(exc), "ticker": ticker}


def edgar_insider_transactions(ticker: str, days: int = 90) -> list[dict]:
    """Recent Form 4 insider transaction filings for a company.

    Args:
        ticker: Stock symbol, e.g. AAPL.
        days: Lookback window in days (default 90).

    Returns:
        List of Form 4 filings: {form, filingDate, accessionNumber, url}.
        Each entry is a Form 4 filing URL the model can fetch for details.
    """
    try:
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        filings = edgar_recent_filings(ticker, form_type="4", limit=50)
        # Filter to the requested date window
        recent = [
            f for f in filings
            if "error" not in f and f.get("filingDate", "") >= cutoff
        ]
        return recent if recent else [{"message": f"No Form 4 filings in the last {days} days for {ticker}"}]
    except Exception as exc:
        return [{"error": str(exc), "ticker": ticker}]


# ---------------------------------------------------------------------------
# Prediction Markets
# ---------------------------------------------------------------------------

# --- Manifold Markets (play money, no auth required) ---

def manifold_search(query: str, limit: int = 10) -> list[dict]:
    """Search Manifold Markets for prediction markets matching a query.

    Manifold uses play money (mana), so prices reflect crowd sentiment rather
    than real-money positioning. Good signal for political, tech, and macro
    questions.

    Args:
        query: Search term, e.g. "fed rate cut September".
        limit: Max markets to return (default 10).

    Returns:
        List of {id, question, probability, volume, close_time, url, is_resolved} dicts.
    """
    try:
        resp = httpx.get(
            "https://api.manifold.markets/v0/search-markets",
            params={"term": query, "limit": limit},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        markets = resp.json()
        return [_normalize_manifold(m) for m in markets]
    except Exception as exc:
        return [{"error": str(exc), "query": query}]


def manifold_market(id_or_slug: str) -> dict:
    """Fetch a specific Manifold market by ID or slug.

    Args:
        id_or_slug: Manifold market ID or URL slug.

    Returns:
        {id, question, probability, volume, close_time, url, is_resolved, traders}
    """
    try:
        resp = httpx.get(
            f"https://api.manifold.markets/v0/market/{id_or_slug}",
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return _normalize_manifold(resp.json())
    except Exception as exc:
        return {"error": str(exc), "id_or_slug": id_or_slug}


def _normalize_manifold(m: dict) -> dict:
    return {
        "id": m.get("id"),
        "question": m.get("question"),
        "probability": m.get("probability"),
        "volume": m.get("volume"),
        "close_time": m.get("closeTime"),
        "url": m.get("url"),
        "is_resolved": m.get("isResolved", False),
        "outcome_type": m.get("outcomeType"),
        "traders": m.get("uniqueBettorCount"),
    }


# --- Polymarket (real-money USDC, US-restricted in many states) ---

def polymarket_search(query: str, limit: int = 10) -> list[dict]:
    """Search Polymarket for prediction markets matching a query.

    Polymarket is a real-money USDC market (US users restricted in many states).
    Prices are 0-1 representing implied probability (e.g. 0.62 = 62%).

    Args:
        query: Search term, e.g. "israel iran ceasefire".
        limit: Max markets to return (default 10).

    Returns:
        List of {question, slug, url, yes_price, no_price, volume_24h, liquidity,
                 end_date, closed} dicts.
    """
    try:
        resp = httpx.get(
            "https://gamma-api.polymarket.com/markets",
            params={"q": query, "active": "true", "closed": "false", "limit": limit},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        markets = resp.json()
        # gamma-api may return a list or a dict with "markets" key
        if isinstance(markets, dict):
            markets = markets.get("markets", [])
        return [_normalize_polymarket(m) for m in markets[:limit]]
    except Exception as exc:
        return [{"error": str(exc), "query": query}]


def polymarket_market(slug: str) -> dict:
    """Fetch a specific Polymarket market by slug.

    Args:
        slug: Polymarket market slug (from the URL, e.g. "will-fed-cut-rates-in-september").

    Returns:
        {question, slug, url, yes_price, no_price, volume_24h, liquidity, end_date, closed}
    """
    try:
        resp = httpx.get(
            "https://gamma-api.polymarket.com/markets",
            params={"slug": slug},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list) and data:
            return _normalize_polymarket(data[0])
        if isinstance(data, dict) and "markets" in data:
            markets = data["markets"]
            if markets:
                return _normalize_polymarket(markets[0])
        return {"error": f"No market found for slug: {slug}"}
    except Exception as exc:
        return {"error": str(exc), "slug": slug}


def _normalize_polymarket(m: dict) -> dict:
    import json as _json

    outcomes_raw = m.get("outcomes", [])
    prices_raw = m.get("outcomePrices", [])

    # outcomePrices may be a JSON-encoded string
    if isinstance(prices_raw, str):
        try:
            prices_raw = _json.loads(prices_raw)
        except Exception:
            prices_raw = []

    if isinstance(outcomes_raw, str):
        try:
            outcomes_raw = _json.loads(outcomes_raw)
        except Exception:
            outcomes_raw = []

    # Build outcome->price mapping
    outcome_map = {}
    for i, outcome in enumerate(outcomes_raw):
        price = prices_raw[i] if i < len(prices_raw) else None
        try:
            price = float(price) if price is not None else None
        except (TypeError, ValueError):
            price = None
        outcome_map[outcome] = price

    # Extract yes/no prices for binary markets; fall back to full map
    yes_price = outcome_map.get("Yes") or outcome_map.get("UP") or (
        list(outcome_map.values())[0] if outcome_map else None
    )
    no_price = outcome_map.get("No") or outcome_map.get("DOWN") or (
        list(outcome_map.values())[1] if len(outcome_map) > 1 else None
    )

    slug = m.get("slug") or m.get("conditionId") or ""
    url = f"https://polymarket.com/event/{slug}" if slug else ""

    result: dict = {
        "question": m.get("question"),
        "slug": slug,
        "url": url,
        "yes_price": yes_price,
        "no_price": no_price,
        "volume_24h": m.get("volume24hr") or m.get("volume24h"),
        "liquidity": m.get("liquidity"),
        "end_date": m.get("endDate") or m.get("closeTime"),
        "closed": m.get("closed", False),
    }

    # For multi-outcome markets also include raw map
    if len(outcome_map) > 2:
        result["outcomes"] = outcome_map

    return result


# --- Kalshi (CFTC-regulated real-money US prediction market) ---

import base64 as _base64
import time as _time

from cryptography.hazmat.primitives import hashes as _hashes, serialization as _serialization
from cryptography.hazmat.primitives.asymmetric import padding as _padding

from app.config import get_settings


def _kalshi_private_key():
    """Load the RSA private key from the base64-encoded PEM in settings."""
    pem_bytes = _base64.b64decode(get_settings().kalshi_private_key_b64)
    return _serialization.load_pem_private_key(pem_bytes, password=None)


def _kalshi_sign(method: str, path: str) -> tuple[str, str, str]:
    """Return (key_id, timestamp_ms_str, base64_signature) for a Kalshi API call.

    Kalshi uses RSA-PSS with SHA-256. The message is:
        timestamp_ms_string + METHOD_UPPERCASE + /trade-api/v2/path
    """
    settings = get_settings()
    ts = str(int(_time.time() * 1000))
    message = (ts + method.upper() + path).encode()
    key = _kalshi_private_key()
    sig = key.sign(
        message,
        _padding.PSS(
            mgf=_padding.MGF1(_hashes.SHA256()),
            salt_length=_padding.PSS.DIGEST_LENGTH,
        ),
        _hashes.SHA256(),
    )
    return settings.kalshi_key_id, ts, _base64.b64encode(sig).decode()


def _kalshi_headers(method: str, path: str) -> dict:
    """Return the three Kalshi auth headers, or raise RuntimeError if unconfigured."""
    settings = get_settings()
    if not settings.kalshi_key_id or not settings.kalshi_private_key_b64:
        raise RuntimeError(
            "Kalshi is not configured; set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_B64"
        )
    key_id, ts, sig = _kalshi_sign(method, path)
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": sig,
    }


def kalshi_search(query: str, limit: int = 10) -> list[dict]:
    """Search Kalshi for CFTC-regulated prediction markets matching a query.

    Kalshi is a US real-money regulated prediction market. Prices are in cents
    (0-100); this function converts them to 0-1 probability.

    Returns friendly error if Kalshi credentials are not configured.

    Args:
        query: Search term, e.g. "NVDA $200".
        limit: Max markets to return (default 10).

    Returns:
        List of {ticker, title, yes_bid, yes_ask, volume, close_time, status} dicts.
    """
    _path = "/trade-api/v2/markets"
    try:
        headers = _kalshi_headers("GET", _path)
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        resp = httpx.get(
            f"https://api.elections.kalshi.com{_path}",
            params={"limit": limit, "status": "open"},
            headers=headers,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        markets = data.get("markets", [])
        # Filter by query string (case-insensitive substring)
        query_lower = query.lower()
        filtered = [
            m for m in markets
            if query_lower in (m.get("title") or "").lower()
            or query_lower in (m.get("subtitle") or "").lower()
        ]
        # If no match, return top results anyway
        result_markets = filtered[:limit] if filtered else markets[:limit]
        return [_normalize_kalshi(m) for m in result_markets]
    except Exception as exc:
        return [{"error": str(exc), "query": query}]


def kalshi_market(ticker: str) -> dict:
    """Fetch a specific Kalshi market by ticker.

    Args:
        ticker: Kalshi market ticker, e.g. "NVDA-200-Q3".

    Returns:
        {ticker, title, yes_bid, yes_ask, volume, close_time, status}
    """
    _path = f"/trade-api/v2/markets/{ticker}"
    try:
        headers = _kalshi_headers("GET", _path)
    except RuntimeError as exc:
        return {"error": str(exc)}
    try:
        resp = httpx.get(
            f"https://api.elections.kalshi.com{_path}",
            headers=headers,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        m = data.get("market", data)
        return _normalize_kalshi(m)
    except Exception as exc:
        return {"error": str(exc), "ticker": ticker}


def _normalize_kalshi(m: dict) -> dict:
    def _cents_to_prob(v) -> Optional[float]:
        if v is None:
            return None
        try:
            return round(float(v) / 100, 4)
        except (TypeError, ValueError):
            return None

    return {
        "ticker": m.get("ticker"),
        "title": m.get("title"),
        "subtitle": m.get("subtitle"),
        "yes_bid": _cents_to_prob(m.get("yes_bid")),
        "yes_ask": _cents_to_prob(m.get("yes_ask")),
        "volume": m.get("volume"),
        "liquidity": m.get("liquidity"),
        "close_time": m.get("close_time") or m.get("closeTime"),
        "status": m.get("status"),
    }


# ---------------------------------------------------------------------------
# Alpaca — options chains, Greeks, quotes, OHLCV bars
# ---------------------------------------------------------------------------

import re as _re
import requests as _requests  # noqa: E402

_ALPACA_DATA_BASE = "https://data.alpaca.markets"

_OCC_RE = _re.compile(
    r"^(?P<root>[A-Z]+)(?P<yy>\d{2})(?P<mm>\d{2})(?P<dd>\d{2})(?P<type>[CP])(?P<strike>\d{8})$"
)


def _parse_occ_symbol(occ: str) -> dict | None:
    """Parse an OCC option symbol into components.

    Format: <root><YYMMDD><C|P><strike*1000>
    Example: TSLA240621C00250000 -> TSLA, 2024-06-21, call, $250.000
    """
    m = _OCC_RE.match(occ)
    if not m:
        return None
    yy, mm, dd = m.group("yy"), m.group("mm"), m.group("dd")
    year = 2000 + int(yy)
    return {
        "root": m.group("root"),
        "expiration_date": f"{year:04d}-{mm}-{dd}",
        "option_type": "call" if m.group("type") == "C" else "put",
        "strike": int(m.group("strike")) / 1000,
    }


def _alpaca_headers() -> dict:
    """Return Alpaca auth headers. Raises RuntimeError if unconfigured."""
    s = get_settings()
    if not s.apca_api_key_id or not s.apca_api_secret_key:
        raise RuntimeError(
            "Alpaca not configured; set APCA_API_KEY_ID and APCA_API_SECRET_KEY"
        )
    return {
        "APCA-API-KEY-ID": s.apca_api_key_id,
        "APCA-API-SECRET-KEY": s.apca_api_secret_key,
    }


def alpaca_quote(symbol: str) -> dict:
    """Latest NBBO quote + last trade for a stock symbol via Alpaca.

    Args:
        symbol: Stock or ETF ticker, e.g. AAPL.

    Returns:
        Dict with symbol, bid, ask, bid_size, ask_size, last_price, last_volume, timestamp.
    """
    try:
        headers = _alpaca_headers()
    except RuntimeError as exc:
        return {"error": str(exc)}
    try:
        sym = symbol.upper()
        quote_resp = _requests.get(
            f"{_ALPACA_DATA_BASE}/v2/stocks/quotes/latest",
            params={"symbols": sym},
            headers=headers,
            timeout=_TIMEOUT,
        )
        quote_resp.raise_for_status()
        q = (quote_resp.json().get("quotes") or {}).get(sym, {})

        trade_resp = _requests.get(
            f"{_ALPACA_DATA_BASE}/v2/stocks/trades/latest",
            params={"symbols": sym},
            headers=headers,
            timeout=_TIMEOUT,
        )
        trade_resp.raise_for_status()
        t = (trade_resp.json().get("trades") or {}).get(sym, {})

        return {
            "symbol": sym,
            "bid": q.get("bp"),
            "ask": q.get("ap"),
            "bid_size": q.get("bs"),
            "ask_size": q.get("as"),
            "last_price": t.get("p"),
            "last_volume": t.get("s"),
            "timestamp": q.get("t"),
        }
    except Exception as exc:
        return {"error": str(exc), "symbol": symbol}


def alpaca_bars(
    symbol: str,
    timeframe: str = "1Day",
    start: str | None = None,
    end: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """OHLCV bars for a stock symbol via Alpaca.

    Args:
        symbol: Stock or ETF ticker, e.g. AAPL.
        timeframe: One of 1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month (default 1Day).
        start: Start date/time in ISO 8601 format (optional).
        end: End date/time in ISO 8601 format (optional).
        limit: Max bars to return (default 100).

    Returns:
        List of {timestamp, open, high, low, close, volume} dicts.
    """
    try:
        headers = _alpaca_headers()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        sym = symbol.upper()
        params: dict = {"symbols": sym, "timeframe": timeframe, "limit": limit}
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        resp = _requests.get(
            f"{_ALPACA_DATA_BASE}/v2/stocks/bars",
            params=params,
            headers=headers,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        bars = (resp.json().get("bars") or {}).get(sym, [])
        return [
            {
                "timestamp": b.get("t"),
                "open": b.get("o"),
                "high": b.get("h"),
                "low": b.get("l"),
                "close": b.get("c"),
                "volume": b.get("v"),
            }
            for b in bars
        ]
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]


def _alpaca_options_snapshots_all(symbol: str) -> list[dict]:
    """Fetch all option snapshots for a symbol, paginating through all pages.

    Returns the raw list of snapshot dicts from the Alpaca API (capped at 20 pages).
    """
    headers = _alpaca_headers()
    sym = symbol.upper()
    url = f"{_ALPACA_DATA_BASE}/v1beta1/options/snapshots/{sym}"
    params: dict = {"feed": "indicative", "limit": 1000}
    all_snapshots: list[dict] = []
    for _ in range(20):
        resp = _requests.get(url, params=params, headers=headers, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        snapshots = data.get("snapshots") or {}
        for occ_sym, snap in snapshots.items():
            snap["_occ"] = occ_sym
            all_snapshots.append(snap)
        next_token = data.get("next_page_token")
        if not next_token:
            break
        params["page_token"] = next_token
    return all_snapshots


def alpaca_option_expirations(symbol: str) -> list:
    """Available option expiration dates for a symbol via Alpaca.

    Args:
        symbol: Stock ticker, e.g. AAPL.

    Returns:
        Sorted list of unique YYYY-MM-DD expiration date strings.
    """
    try:
        _alpaca_headers()  # validate config early
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        snapshots = _alpaca_options_snapshots_all(symbol)
        expirations: set[str] = set()
        for snap in snapshots:
            parsed = _parse_occ_symbol(snap.get("_occ", ""))
            if parsed:
                expirations.add(parsed["expiration_date"])
        return sorted(expirations)
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]


def alpaca_option_chain(symbol: str, expiration: str, greeks: bool = True) -> list[dict]:
    """Full option chain for a symbol and expiration date via Alpaca.

    Args:
        symbol: Stock ticker, e.g. NVDA.
        expiration: Expiration date in YYYY-MM-DD format.
        greeks: If True, include delta, gamma, theta, vega, rho, mid_iv.

    Returns:
        List of option contracts sorted by strike ascending. Each dict has:
        symbol, underlying, expiration_date, strike, option_type (call/put),
        last, bid, ask, volume, open_interest, greeks (if requested).
    """
    try:
        _alpaca_headers()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        snapshots = _alpaca_options_snapshots_all(symbol)
        results: list[dict] = []
        for snap in snapshots:
            occ = snap.get("_occ", "")
            parsed = _parse_occ_symbol(occ)
            if not parsed or parsed["expiration_date"] != expiration:
                continue
            q = snap.get("latestQuote") or {}
            tr = snap.get("latestTrade") or {}
            entry: dict = {
                "symbol": occ,
                "underlying": parsed["root"],
                "expiration_date": parsed["expiration_date"],
                "strike": parsed["strike"],
                "option_type": parsed["option_type"],
                "last": tr.get("p"),
                "bid": q.get("bp"),
                "ask": q.get("ap"),
                "volume": tr.get("s"),
                "open_interest": snap.get("openInterest"),
            }
            if greeks:
                g = snap.get("greeks") or {}
                entry["greeks"] = {
                    "delta": g.get("delta"),
                    "gamma": g.get("gamma"),
                    "theta": g.get("theta"),
                    "vega": g.get("vega"),
                    "rho": g.get("rho"),
                    "mid_iv": snap.get("impliedVolatility"),
                }
            results.append(entry)
        return sorted(results, key=lambda x: (x.get("strike") or 0))
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol, "expiration": expiration}]


def alpaca_option_strikes(symbol: str, expiration: str) -> list:
    """Available strike prices for a symbol and expiration date via Alpaca.

    Args:
        symbol: Stock ticker, e.g. TSLA.
        expiration: Expiration date in YYYY-MM-DD format.

    Returns:
        Sorted list of unique strike prices (floats).
    """
    try:
        _alpaca_headers()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        chain = alpaca_option_chain(symbol, expiration, greeks=False)
        if chain and "error" in chain[0]:
            return chain
        strikes = sorted({c["strike"] for c in chain if "strike" in c})
        return strikes
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol, "expiration": expiration}]


# ---------------------------------------------------------------------------
# Tradier — options chains with real Greeks (paid OPRA feed via brokerage).
#
# Why over Alpaca: Alpaca's free indicative feed returns None for
# delta/gamma/theta/vega. Tradier ships actual Greeks at the brokerage
# tier (free with a funded account, or via standalone Market Data sub).
#
# Auth: Bearer <token>.  Base URL flips by env (sandbox/production).
# ---------------------------------------------------------------------------

_TRADIER_PROD_BASE = "https://api.tradier.com/v1"
_TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1"


def _tradier_token_and_base() -> tuple[str, str]:
    """Return (token, base_url) for the configured Tradier environment.

    Honors TRADIER_TOKEN_SANDBOX when TRADIER_ENV=sandbox so CI runs
    end-to-end against the sandbox without touching the production token.
    """
    s = get_settings()
    env = (s.tradier_env or "sandbox").lower()
    if env == "production":
        token = s.tradier_token
        base = _TRADIER_PROD_BASE
    else:
        token = s.tradier_token_sandbox or s.tradier_token
        base = _TRADIER_SANDBOX_BASE
    if not token:
        raise RuntimeError(
            f"Tradier token missing for env={env}. "
            "Set TRADIER_TOKEN (prod) or TRADIER_TOKEN_SANDBOX (sandbox)."
        )
    return token, base


def _tradier_headers() -> dict:
    token, _ = _tradier_token_and_base()
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }


def tradier_quote(symbol: str) -> dict:
    """Real-time equity quote. Returns last/bid/ask/volume/day OHLC."""
    try:
        _, base = _tradier_token_and_base()
    except RuntimeError as exc:
        return {"error": str(exc)}
    try:
        r = httpx.get(
            f"{base}/markets/quotes",
            headers=_tradier_headers(),
            params={"symbols": symbol, "greeks": "false"},
            timeout=10,
        )
        r.raise_for_status()
        q = (r.json() or {}).get("quotes", {}).get("quote") or {}
        if isinstance(q, list):
            q = q[0] if q else {}
        return {
            "symbol": q.get("symbol", symbol.upper()),
            "last": q.get("last"),
            "bid": q.get("bid"),
            "ask": q.get("ask"),
            "volume": q.get("volume"),
            "open": q.get("open"),
            "high": q.get("high"),
            "low": q.get("low"),
            "prev_close": q.get("prevclose"),
            "change": q.get("change"),
            "change_percent": q.get("change_percentage"),
        }
    except Exception as exc:
        return {"error": str(exc), "symbol": symbol}


def tradier_option_expirations(symbol: str) -> list:
    """All option expiration dates for a symbol (YYYY-MM-DD strings)."""
    try:
        _, base = _tradier_token_and_base()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        r = httpx.get(
            f"{base}/markets/options/expirations",
            headers=_tradier_headers(),
            params={"symbol": symbol, "includeAllRoots": "true", "strikes": "false"},
            timeout=10,
        )
        r.raise_for_status()
        dates = (r.json() or {}).get("expirations", {}).get("date") or []
        if isinstance(dates, str):
            dates = [dates]
        return list(dates)
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol}]


def tradier_option_strikes(symbol: str, expiration: str) -> list:
    """All strike prices for a symbol+expiration."""
    try:
        _, base = _tradier_token_and_base()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        r = httpx.get(
            f"{base}/markets/options/strikes",
            headers=_tradier_headers(),
            params={"symbol": symbol, "expiration": expiration},
            timeout=10,
        )
        r.raise_for_status()
        strikes = (r.json() or {}).get("strikes", {}).get("strike") or []
        return list(strikes)
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol, "expiration": expiration}]


def tradier_option_chain(symbol: str, expiration: str, greeks: bool = True) -> list[dict]:
    """Full option chain. With greeks=True, each contract row includes
    real delta/gamma/theta/vega/rho/mid_iv from Tradier's OPRA feed.
    """
    try:
        _, base = _tradier_token_and_base()
    except RuntimeError as exc:
        return [{"error": str(exc)}]
    try:
        r = httpx.get(
            f"{base}/markets/options/chains",
            headers=_tradier_headers(),
            params={
                "symbol": symbol,
                "expiration": expiration,
                "greeks": "true" if greeks else "false",
            },
            timeout=15,
        )
        r.raise_for_status()
        options = (r.json() or {}).get("options", {}).get("option") or []
        if isinstance(options, dict):
            options = [options]
        out: list[dict] = []
        for o in options:
            g = o.get("greeks") or {}
            out.append({
                "symbol": o.get("symbol"),
                "underlying": o.get("underlying"),
                "expiration": o.get("expiration_date") or expiration,
                "strike": o.get("strike"),
                "option_type": o.get("option_type"),  # 'call' | 'put'
                "bid": o.get("bid"),
                "ask": o.get("ask"),
                "last": o.get("last"),
                "volume": o.get("volume"),
                "open_interest": o.get("open_interest"),
                "greeks": {
                    "delta": g.get("delta"),
                    "gamma": g.get("gamma"),
                    "theta": g.get("theta"),
                    "vega": g.get("vega"),
                    "rho": g.get("rho"),
                    "mid_iv": g.get("mid_iv"),
                    "bid_iv": g.get("bid_iv"),
                    "ask_iv": g.get("ask_iv"),
                } if greeks else None,
            })
        return out
    except Exception as exc:
        return [{"error": str(exc), "symbol": symbol, "expiration": expiration}]
