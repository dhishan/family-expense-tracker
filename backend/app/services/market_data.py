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
