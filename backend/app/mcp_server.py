"""Hosted SnapTrade MCP server, mounted on the FastAPI app at /mcp.

Auth strategy (in priority order):
  1. Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` header (Phase B — production).
  2. Bearer token = our own JWT issued by /api/v1/auth/google (Phase A fallback).
  3. `X-Mcp-User-Id` header (LOCAL DEV ONLY — gated by ENVIRONMENT=development).

The resolved internal user_id is stashed in a ContextVar so the tool functions
can read it without each tool re-implementing auth.

Tools mirror the local snaptrade_mcp.py: list_accounts, get_holdings,
get_cost_basis, get_account_balances, get_account_positions, get_activities,
portfolio_summary.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from contextvars import ContextVar
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException, Request, status
from mcp.server.fastmcp import FastMCP
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.auth.cloudflare import CloudflareAuthError, verify_access_jwt
from app.auth.dependencies import decode_token
from app.config import get_settings
from app.services import market_data, snaptrade_service
from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)
settings = get_settings()

# Context for the current authenticated user; set per-request by the middleware.
_current_user_id: ContextVar[str | None] = ContextVar("mcp_user_id", default=None)


def _resolve_user_id_by_email(email: str) -> str:
    """Look up the internal user_id (Google UID) by email in the `users` collection.

    Users are created by /api/v1/auth/google on first sign-in, keyed by Google UID
    with `email` as a field. CF Access verifies the user has signed in with Google,
    so the email match is sufficient to identify them.
    """
    db = get_firestore_client()
    matches = list(db.collection("users").where("email", "==", email).limit(1).stream())
    if not matches:
        raise HTTPException(
            status_code=403,
            detail=(
                f"User {email} authenticated with Cloudflare Access but has no account "
                "in the expense tracker. Sign in to the web app once to create your account."
            ),
        )
    return matches[0].id


def _resolve_user_id_from_request(request: Request) -> str:
    """Validate auth headers and return the internal user_id (Google UID).

    Auth priority (in order):
      1. Cloudflare Access JWT in Cf-Access-Jwt-Assertion header (production path)
      2. Our own JWT bearer token (fallback, e.g. for service-to-service)
      3. X-Mcp-User-Id header (LOCAL DEV ONLY — gated by ENVIRONMENT=development)

    Raises HTTPException(401/403) on any failure.
    """
    # 1. Cloudflare Access JWT (production)
    cf_jwt = request.headers.get("cf-access-jwt-assertion")
    if cf_jwt:
        try:
            claims = verify_access_jwt(cf_jwt)
        except CloudflareAuthError as e:
            raise HTTPException(status_code=401, detail=f"Cloudflare Access JWT invalid: {e}")
        email = claims.get("email")
        if not email:
            raise HTTPException(status_code=401, detail="Cloudflare JWT missing email claim")
        return _resolve_user_id_by_email(email)

    # 2. Bearer token: our own app JWT
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
        try:
            payload = decode_token(token)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=401, detail=f"Invalid bearer token: {e}")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Token missing subject")
        return user_id

    # 3. Local-dev escape hatch — header-based user injection
    if settings.environment == "development":
        dev_user = request.headers.get("x-mcp-user-id")
        if dev_user:
            return dev_user

    raise HTTPException(
        status_code=401,
        detail="MCP requires Cloudflare Access JWT or Bearer token (or X-Mcp-User-Id in dev).",
    )


class McpAuthMiddleware(BaseHTTPMiddleware):
    """Resolves the user from auth headers and stashes in ContextVar.

    Also emits a structured `mcp_request` log on every authenticated request so
    Cloud Logging / Langfuse can derive usage metrics.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            user_id = _resolve_user_id_from_request(request)
        except HTTPException as e:
            return JSONResponse({"error": e.detail}, status_code=e.status_code)

        # Structured log — picked up by GCP log-based metric `mcp_tool_calls`.
        logger.info(
            "mcp_request",
            extra={
                "json_fields": {
                    "event": "mcp_request",
                    "user_id": user_id,
                    "path": request.url.path,
                    "method": request.method,
                }
            },
        )

        token = _current_user_id.set(user_id)
        try:
            return await call_next(request)
        finally:
            _current_user_id.reset(token)


def _user() -> str:
    uid = _current_user_id.get()
    if not uid:
        # Should be impossible: middleware rejects unauth requests before we get here.
        raise RuntimeError("MCP tool called outside authenticated context")
    return uid


# ---- MCP server + tools ----------------------------------------------------

mcp = FastMCP("snaptrade-hosted", streamable_http_path="/")


@mcp.tool()
def list_accounts() -> list[dict]:
    """List all brokerage accounts connected via SnapTrade for the calling user."""
    return snaptrade_service.list_accounts(_user())


@mcp.tool()
def get_holdings() -> list[dict]:
    """Positions across every connected account. Primary portfolio pull."""
    return snaptrade_service.get_all_holdings(_user())


@mcp.tool()
def get_account_balances(account_id: str) -> list[dict]:
    """Cash + buying-power balances for a specific account."""
    return snaptrade_service.get_account_balances(_user(), account_id)


@mcp.tool()
def get_account_positions(account_id: str) -> list[dict]:
    """Positions for a single account."""
    return snaptrade_service.get_account_positions(_user(), account_id)


@mcp.tool()
def get_activities(days: int = 60, account_ids: str | None = None) -> list[dict]:
    """Transaction history (buys, sells, dividends, deposits, transfers).
    days: lookback window. account_ids: optional comma-separated account UUID allowlist."""
    end = date.today()
    start = end - timedelta(days=days)
    return snaptrade_service.get_activities(
        _user(), start_date=start.isoformat(), end_date=end.isoformat(), accounts=account_ids,
    )


@mcp.tool()
def get_cost_basis(include_lots: bool = False) -> list[dict]:
    """Per-position cost basis, unrealized P&L, and return %.
    Returns: account, symbol, qty, avg_cost, current_price, market_value, cost_basis,
    unrealized_pnl, return_pct. Set include_lots=true for per-lot detail (date, qty, price)."""
    holdings = snaptrade_service.get_all_holdings(_user())
    rows: list[dict] = []
    for entry in holdings:
        acct = entry.get("account") or {}
        acct_label = f"{acct.get('institution_name')}/{acct.get('name')}"
        for p in entry.get("positions") or []:
            sym = ((p.get("symbol") or {}).get("symbol") or {}).get("symbol") or "?"
            qty = p.get("units") or 0
            price = p.get("price") or 0
            avg_cost = p.get("average_purchase_price")
            mv = qty * price
            cost = (qty * avg_cost) if avg_cost is not None else None
            pnl = p.get("open_pnl")
            if pnl is None and cost is not None:
                pnl = mv - cost
            ret_pct = (pnl / cost * 100) if (cost and pnl is not None) else None
            row = {
                "account": acct_label, "symbol": sym, "qty": qty,
                "avg_cost": avg_cost, "current_price": price,
                "market_value": round(mv, 2),
                "cost_basis": round(cost, 2) if cost is not None else None,
                "unrealized_pnl": round(pnl, 2) if pnl is not None else None,
                "return_pct": round(ret_pct, 2) if ret_pct is not None else None,
            }
            if include_lots:
                row["tax_lots"] = p.get("tax_lots") or []
            rows.append(row)
    return sorted(rows, key=lambda r: -(r["market_value"] or 0))


@mcp.tool()
def portfolio_summary() -> dict[str, Any]:
    """Condensed snapshot: total value, cash %, allocation by asset class, top 25 positions
    with cost basis and P&L inline. Smaller payload than get_holdings; good starting point."""
    accounts = snaptrade_service.list_accounts(_user())
    holdings = snaptrade_service.get_all_holdings(_user())
    by_asset_class: dict[str, float] = defaultdict(float)
    total = 0.0
    cash = 0.0
    positions: list[dict] = []

    for entry in holdings:
        for p in entry.get("positions") or []:
            sym_node = (p.get("symbol") or {}).get("symbol") or {}
            sym = sym_node.get("symbol") or "?"
            qty = p.get("units") or 0
            price = p.get("price") or 0
            mv = qty * price
            asset_type = (sym_node.get("type") or {}).get("description") or "Equity"
            by_asset_class[asset_type] += mv
            total += mv
            avg_cost = p.get("average_purchase_price")
            pnl = p.get("open_pnl")
            cost = (qty * avg_cost) if avg_cost is not None else None
            ret_pct = (pnl / cost * 100) if (cost and pnl is not None) else None
            positions.append({
                "symbol": sym, "qty": qty, "price": price, "market_value": mv, "type": asset_type,
                "avg_cost": avg_cost, "cost_basis": round(cost, 2) if cost is not None else None,
                "unrealized_pnl": round(pnl, 2) if pnl is not None else None,
                "return_pct": round(ret_pct, 2) if ret_pct is not None else None,
            })
        for b in entry.get("balances") or []:
            amt = b.get("cash") or 0
            cash += amt
            total += amt

    return {
        "as_of": date.today().isoformat(),
        "total_value": total,
        "cash": cash,
        "cash_pct": (cash / total * 100) if total else 0,
        "accounts": [
            {"institution": a.get("institution_name"), "name": a.get("name"),
             "total": ((a.get("balance") or {}).get("total") or {}).get("amount")}
            for a in accounts
        ],
        "by_asset_class": dict(by_asset_class),
        "top_positions": sorted(positions, key=lambda x: -x["market_value"])[:25],
    }


# ---- Financial market data tools -------------------------------------------


@mcp.tool()
def macro_indicator(series_id: str, limit: int = 1) -> dict:
    """Fetch a US macroeconomic indicator from FRED.

    Use when discussing rates, inflation, growth, employment, dollar strength, yield curve.
    Common series_id values: FEDFUNDS (Fed funds rate), CPIAUCSL (CPI all urban consumers),
    UNRATE (unemployment rate), DGS10 (10-year treasury yield), DGS2 (2-year treasury yield),
    T10Y2Y (10-2 spread, recession signal when below 0), DTWEXBGS (broad dollar index),
    WALCL (Fed balance sheet assets in $M), M2SL (M2 money supply).
    """
    return market_data.fred_observation(series_id=series_id, limit=limit)


@mcp.tool()
def macro_series(
    series_id: str,
    observation_start: str | None = None,
    observation_end: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Fetch a historical time series of a FRED macro indicator.

    Use when you need trend data over a date range (e.g. inflation over the past 2 years,
    rate path since 2022). Same series_id values as macro_indicator.
    """
    return market_data.fred_series(
        series_id=series_id,
        observation_start=observation_start,
        observation_end=observation_end,
        limit=limit,
    )


@mcp.tool()
def price_history(
    ticker: str,
    start: str | None = None,
    end: str | None = None,
) -> list[dict]:
    """End-of-day OHLCV price history for a stock or ETF ticker.

    Use when analyzing price performance, drawing trend lines, or calculating returns.
    start and end are YYYY-MM-DD; defaults to the past year up to today.
    """
    return market_data.tiingo_eod(ticker=ticker, start=start, end=end)


@mcp.tool()
def ticker_meta(ticker: str) -> dict:
    """Company metadata: full name, exchange, description, earliest/latest data available.

    Use to confirm a ticker is valid or to retrieve the company name and exchange.
    """
    return market_data.tiingo_meta(ticker=ticker)


@mcp.tool()
def ticker_quote(symbol: str) -> dict:
    """Current real-time price, day high/low, and previous close for a stock.

    Use when the user asks about current price or intraday moves.
    Returns c (current), h (high), l (low), pc (prev close), t (timestamp).
    """
    return market_data.finnhub_quote(symbol=symbol)


@mcp.tool()
def ticker_news(symbol: str, days: int = 14) -> list[dict]:
    """Recent news articles about a stock.

    Use when analyzing a specific position or considering buy/sell decisions.
    Returns headlines, summaries, and article URLs.
    """
    return market_data.finnhub_company_news(symbol=symbol, days=days)


@mcp.tool()
def ticker_recommendations(symbol: str) -> list[dict]:
    """Wall Street analyst buy/hold/sell recommendation trends (last ~4 months).

    Use when assessing analyst sentiment or conviction around a position.
    Returns strongBuy, buy, hold, sell, strongSell counts per period.
    """
    return market_data.finnhub_recommendations(symbol=symbol)


@mcp.tool()
def ticker_price_target(symbol: str) -> dict:
    """Analyst consensus price target: high, low, mean, and median targets.

    Use when assessing upside/downside vs current price or comparing analyst conviction.
    """
    return market_data.finnhub_price_target(symbol=symbol)


@mcp.tool()
def ticker_earnings_calendar(symbol: str, days_ahead: int = 90) -> list[dict]:
    """Upcoming earnings dates and EPS/revenue estimates for a stock.

    Use when identifying near-term catalysts or event risk for a position.
    """
    return market_data.finnhub_earnings_calendar(symbol=symbol, days_ahead=days_ahead)


# ---- FastAPI mount helper --------------------------------------------------

def build_mcp_app():
    """Return the Streamable HTTP ASGI app wrapped with auth middleware.
    Mount it on the main FastAPI app with `app.mount('/mcp', build_mcp_app())`."""
    asgi_app = mcp.streamable_http_app()
    asgi_app.add_middleware(McpAuthMiddleware)
    return asgi_app
