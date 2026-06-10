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
from app.services.budget_service import get_budget_service
from app.services.expense_service import get_expense_service
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


def _get_family_id(user_id: str) -> str | None:
    """Look up family_id for a user from Firestore."""
    db = get_firestore_client()
    doc = db.collection("users").document(user_id).get()
    if not doc.exists:
        return None
    return doc.to_dict().get("family_id")


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


# ---- SEC EDGAR tools --------------------------------------------------------


@mcp.tool()
def edgar_company_lookup(ticker: str) -> dict:
    """Resolve a stock ticker to its SEC CIK number and official company name.

    Use to disambiguate before pulling filings or facts, or when the user asks about
    a company's SEC identity.
    """
    return market_data.edgar_company_lookup(ticker=ticker)


@mcp.tool()
def edgar_recent_filings(
    ticker: str,
    form_type: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Recent SEC filings for a ticker from EDGAR.

    Use for fundamental analysis: 10-K (annual), 10-Q (quarterly), 8-K (material events
    like acquisitions, leadership changes, guidance), DEF 14A (proxy/exec compensation),
    Form 4 (insider buy/sell). Returns filing dates and document URLs.
    """
    return market_data.edgar_recent_filings(ticker=ticker, form_type=form_type, limit=limit)


@mcp.tool()
def edgar_company_facts(ticker: str, concept: str | None = None) -> dict:
    """SEC XBRL financial facts for a company: revenue, net income, assets, liabilities, EPS.

    Data comes from the company's own EDGAR filings. If concept is omitted, returns a summary
    of key metrics with latest values. If concept is provided (e.g. 'Revenues', 'NetIncomeLoss',
    'Assets', 'EarningsPerShareBasic'), returns the full history of that metric across filing periods.
    """
    return market_data.edgar_company_facts(ticker=ticker, concept=concept)


@mcp.tool()
def edgar_insider_transactions(ticker: str, days: int = 90) -> list[dict]:
    """Recent Form 4 insider transaction filings for a company.

    Returns buys and sells by officers, directors, and 10%+ shareholders.
    Use when assessing management conviction, insider selling pressure, or unusual buying activity.
    """
    return market_data.edgar_insider_transactions(ticker=ticker, days=days)


# ---- Expense + budget tools ------------------------------------------------


@mcp.tool()
async def expense_list(
    start_date: str,
    end_date: str,
    category: str | None = None,
    beneficiary: str | None = None,
    min_amount: float | None = None,
    limit: int = 200,
) -> dict:
    """List expense transactions for the family within a date range.

    start_date and end_date are YYYY-MM-DD (inclusive). Optional filters:
    category (groceries, dining, transportation, etc.), beneficiary (user ID or 'family'),
    min_amount (only return expenses >= this value). limit caps results (max 500).
    Returns {expenses: [{id, date, amount, category, merchant, beneficiary, description}], total_matching}.
    """
    from datetime import date as _date
    from app.models.expense import ExpenseFilters, ExpenseCategory
    family_id = _get_family_id(_user())
    if not family_id:
        return {"error": "No family configured for this user."}
    start = _date.fromisoformat(start_date)
    end = _date.fromisoformat(end_date)
    filters = ExpenseFilters(
        start_date=start,
        end_date=end,
        category=ExpenseCategory(category) if category else None,
        beneficiary=beneficiary,
    )
    svc = get_expense_service()
    capped = min(limit, 500)
    expenses, total, _ = await svc.list(family_id, filters=filters, page=1, page_size=capped)
    result = []
    for e in expenses:
        if min_amount is not None and e.amount < min_amount:
            continue
        result.append({
            "id": e.id,
            "date": e.date.isoformat(),
            "amount": e.amount,
            "category": e.category,
            "merchant": e.merchant,
            "beneficiary": e.beneficiary,
            "description": e.description,
        })
    return {"expenses": result, "total_matching": total}


@mcp.tool()
async def expense_summary(
    start_date: str,
    end_date: str,
    group_by: str = "category",
) -> dict:
    """Aggregate expense totals grouped by category, beneficiary, month, or merchant.

    Use for questions like 'how much on groceries last month', 'where is our money going',
    or 'compare month by month'. group_by in [category, beneficiary, month, merchant].
    Returns {group_by, rows: [{key, count, total}], total_amount}.
    """
    from datetime import date as _date
    from app.models.expense import ExpenseFilters
    family_id = _get_family_id(_user())
    if not family_id:
        return {"error": "No family configured for this user."}
    start = _date.fromisoformat(start_date)
    end = _date.fromisoformat(end_date)
    svc = get_expense_service()

    if group_by in ("category", "beneficiary"):
        summary = await svc.get_summary(family_id, start, end)
        data = summary.by_category if group_by == "category" else summary.by_beneficiary
        expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
        counts: dict[str, int] = {}
        for e in expenses:
            key = e.category if group_by == "category" else e.beneficiary
            counts[key] = counts.get(key, 0) + 1
        rows = [{"key": k, "count": counts.get(k, 0), "total": round(v, 2)}
                for k, v in sorted(data.items(), key=lambda x: -x[1])]
        return {"group_by": group_by, "rows": rows, "total_amount": round(summary.total_amount, 2)}

    expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
    agg: dict[str, dict] = {}
    for e in expenses:
        if group_by == "merchant":
            key = e.merchant or "(no merchant)"
        else:  # month
            key = e.date.strftime("%Y-%m")
        if key not in agg:
            agg[key] = {"count": 0, "total": 0.0}
        agg[key]["count"] += 1
        agg[key]["total"] += e.amount

    if group_by == "month":
        rows = [{"key": k, "count": v["count"], "total": round(v["total"], 2)} for k, v in sorted(agg.items())]
    else:
        rows = [{"key": k, "count": v["count"], "total": round(v["total"], 2)}
                for k, v in sorted(agg.items(), key=lambda x: -x[1]["total"])]
    total_amount = sum(v["total"] for v in agg.values())
    return {"group_by": group_by, "rows": rows, "total_amount": round(total_amount, 2)}


@mcp.tool()
async def expense_top_merchants(
    start_date: str,
    end_date: str,
    limit: int = 10,
) -> dict:
    """Top merchants/vendors ranked by total spend for a date range.

    Use when the user asks 'where do we spend the most' or wants to identify
    high-frequency or high-value vendors. Returns {top_merchants: [{merchant, count, total}]}.
    """
    from datetime import date as _date
    from app.models.expense import ExpenseFilters
    family_id = _get_family_id(_user())
    if not family_id:
        return {"error": "No family configured for this user."}
    start = _date.fromisoformat(start_date)
    end = _date.fromisoformat(end_date)
    svc = get_expense_service()
    expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
    agg: dict[str, dict] = {}
    for e in expenses:
        key = e.merchant or "(no merchant)"
        if key not in agg:
            agg[key] = {"count": 0, "total": 0.0}
        agg[key]["count"] += 1
        agg[key]["total"] += e.amount
    rows = sorted(agg.items(), key=lambda x: -x[1]["total"])[:limit]
    return {"top_merchants": [{"merchant": k, "count": v["count"], "total": round(v["total"], 2)} for k, v in rows]}


@mcp.tool()
async def budget_status(reference_date: str | None = None) -> dict:
    """Current budget status for all family budgets: limit, spent, remaining, and on-track indicator.

    Use for questions like 'are we on budget', 'how much is left in dining', or 'which budgets are over'.
    reference_date (YYYY-MM-DD) pins the budget period; defaults to today.
    Returns {budgets: [{category, period, period_start, period_end, limit, spent, remaining, pct_used, status}]}.
    status is 'ok' (< 80%), 'warning' (>= 80%), or 'over' (> 100%).
    """
    from datetime import date as _date
    family_id = _get_family_id(_user())
    if not family_id:
        return {"error": "No family configured for this user."}
    ref = _date.fromisoformat(reference_date) if reference_date else _date.today()
    svc = get_budget_service()
    statuses = await svc.list_with_status(family_id, reference_date=ref)
    result = []
    for s in statuses:
        pct = s.percentage_used
        status_label = "over" if s.is_over_budget else ("warning" if pct >= 80 else "ok")
        result.append({
            "category": s.budget.category,
            "period": s.budget.period,
            "period_start": s.period_start.isoformat(),
            "period_end": s.period_end.isoformat(),
            "limit": s.budget.amount,
            "spent": round(s.spent, 2),
            "remaining": round(s.remaining, 2),
            "pct_used": round(pct, 1),
            "status": status_label,
        })
    return {"budgets": result, "count": len(result)}


@mcp.tool()
async def budget_burn_rate(category: str, lookback_months: int = 3) -> dict:
    """Historical average monthly spend for a category vs the current budget limit.

    Use to answer 'is my dining budget realistic', 'am I under-budgeting for groceries'.
    category: one of groceries, dining, transportation, utilities, entertainment,
    healthcare, shopping, travel, education, other.
    Returns {category, avg_monthly_spend, current_limit, ratio, months_analyzed, monthly_totals}.
    ratio > 1.0 means you're consistently overspending the budget.
    """
    from datetime import date as _date, timedelta as _td
    from dateutil.relativedelta import relativedelta
    family_id = _get_family_id(_user())
    if not family_id:
        return {"error": "No family configured for this user."}
    svc_e = get_expense_service()
    svc_b = get_budget_service()
    today = _date.today()
    monthly_totals = []
    for i in range(lookback_months):
        month_start = today.replace(day=1) - relativedelta(months=i + 1)
        next_month = month_start.replace(month=month_start.month + 1, day=1) if month_start.month < 12 \
            else month_start.replace(year=month_start.year + 1, month=1, day=1)
        month_end = next_month - _td(days=1)
        total = await svc_e.get_spending_for_budget(family_id, month_start, month_end, category=category)
        monthly_totals.append(total)
    avg = sum(monthly_totals) / len(monthly_totals) if monthly_totals else 0.0
    budgets = await svc_b.list(family_id)
    current_limit = next((b.amount for b in budgets if b.category == category), None)
    ratio = (avg / current_limit) if current_limit else None
    return {
        "category": category,
        "avg_monthly_spend": round(avg, 2),
        "current_limit": current_limit,
        "ratio": round(ratio, 2) if ratio is not None else None,
        "months_analyzed": lookback_months,
        "monthly_totals": [round(x, 2) for x in monthly_totals],
    }


# ---- Plaid bank tools -------------------------------------------------------


@mcp.tool()
def bank_accounts(refresh: bool = False) -> dict:
    """Current balances across all bank/credit accounts connected via Plaid.

    Returns accounts from ALL family members' connected banks, not just the caller's.
    Use when the user asks about account balances or wants to see all linked accounts.
    Pass refresh=True to re-fetch live balances from Plaid instead of cached values.
    Returns {accounts: [{institution_name, name, mask, type, subtype, current_balance,
    available_balance, currency, connected_by}]}.
    """
    from app.services import plaid_service
    from google.cloud import firestore  # type: ignore

    user_id = _user()
    family_id = _get_family_id(user_id)
    if not family_id:
        return {"accounts": [], "count": 0, "error": "User is not in a family"}
    db = get_firestore_client()

    if refresh:
        items = plaid_service.list_items(family_id)
        for item in items:
            access_token = plaid_service.get_access_token(item["id"], family_id)
            if not access_token:
                continue
            try:
                from plaid.model.accounts_get_request import AccountsGetRequest  # type: ignore
                resp = plaid_service._client().accounts_get(AccountsGetRequest(access_token=access_token))
                accts_data = resp.to_dict() if hasattr(resp, "to_dict") else resp
                plaid_service.upsert_accounts(item["id"], family_id, accts_data.get("accounts") or [])
            except Exception:
                pass

    acct_snaps = list(
        db.collection(plaid_service.PLAID_ACCOUNTS_COLLECTION)
        .where(filter=firestore.FieldFilter("family_id", "==", family_id))
        .stream()
    )
    accounts = []
    for snap in acct_snaps:
        a = snap.to_dict() or {}
        item_snap = db.collection(plaid_service.PLAID_ITEMS_COLLECTION).document(
            a.get("plaid_item_id", "")
        ).get()
        inst_name = ""
        connected_by = ""
        if item_snap.exists:
            item_d = item_snap.to_dict() or {}
            inst_name = item_d.get("institution_name", "")
            connected_by = item_d.get("connected_by_user_id", "")
        accounts.append({
            "institution_name": inst_name,
            "name": a.get("name", ""),
            "mask": a.get("mask"),
            "type": a.get("type", ""),
            "subtype": a.get("subtype"),
            "current_balance": a.get("current_balance"),
            "available_balance": a.get("available_balance"),
            "currency": a.get("iso_currency_code", "USD"),
            "connected_by": connected_by,
        })
    return {"accounts": accounts, "count": len(accounts)}


@mcp.tool()
async def bank_transactions(
    start_date: str | None = None,
    end_date: str | None = None,
    category: str | None = None,
    min_amount: float | None = None,
    limit: int = 100,
    include_pending: bool = False,
    account_id: str | None = None,
) -> dict:
    """Recent bank transactions from Plaid-linked accounts.

    Approved transactions are returned as expenses. Pass include_pending=True to also include
    transactions awaiting review. Default date range is last 30 days.
    Returns {approved_expenses: [...], pending_transactions: [...], total_approved, total_pending}.
    """
    from datetime import date as _date, timedelta as _td
    from app.models.expense import ExpenseFilters, ExpenseCategory
    from app.services import plaid_service

    user_id = _user()
    family_id = _get_family_id(user_id)
    if not family_id:
        return {"approved_expenses": [], "pending_transactions": [], "total_approved": 0, "total_pending": 0, "error": "User is not in a family"}
    today = _date.today()
    start = _date.fromisoformat(start_date) if start_date else (today - _td(days=30))
    end = _date.fromisoformat(end_date) if end_date else today

    approved_txns = []
    svc = get_expense_service()
    filters = ExpenseFilters(
        start_date=start,
        end_date=end,
        category=ExpenseCategory(category) if category else None,
    )
    capped = min(limit, 500)
    expenses, _, _ = await svc.list(family_id, filters=filters, page=1, page_size=capped)
    for e in expenses:
        if min_amount is not None and e.amount < min_amount:
            continue
        approved_txns.append({
            "id": e.id,
            "date": e.date.isoformat(),
            "amount": e.amount,
            "category": e.category,
            "merchant": e.merchant,
            "description": e.description,
            "source": "approved",
        })

    pending_txns = []
    if include_pending:
        # Family-scoped: all pending from all family members' connected banks
        pending_items, _ = plaid_service.list_pending_transactions(family_id, page=1, page_size=limit)
        for p in pending_items:
            if account_id and p.get("account_id") != account_id:
                continue
            amt = abs(float(p.get("amount", 0)))
            if min_amount is not None and amt < min_amount:
                continue
            pending_txns.append({
                "id": p.get("id"),
                "date": p.get("date"),
                "amount": amt,
                "category": p.get("suggested_category", "other"),
                "merchant": p.get("merchant_name"),
                "description": p.get("name"),
                "source": "pending_review",
                "account_name": p.get("account_name"),
                "institution_name": p.get("institution_name"),
                "connected_by": p.get("connected_by_user_id", ""),
            })

    return {
        "approved_expenses": approved_txns,
        "pending_transactions": pending_txns,
        "total_approved": len(approved_txns),
        "total_pending": len(pending_txns),
    }


@mcp.tool()
def bank_recurring(account_id: str | None = None) -> dict:
    """Recurring inflows and outflows detected by Plaid (subscriptions, bills, paychecks).

    Use when the user asks 'what subscriptions am I paying for', 'show my recurring charges',
    or 'what regular bills do I have'. Calls Plaid's Recurring Transactions API.
    Returns {inflow_streams: [...], outflow_streams: [...]} with merchant, average_amount,
    frequency, and last_date for each stream.
    """
    from app.services import plaid_service
    from plaid.model.transactions_recurring_get_request import TransactionsRecurringGetRequest  # type: ignore

    user_id = _user()
    family_id = _get_family_id(user_id)
    if not family_id:
        return {"inflow_streams": [], "outflow_streams": [], "inflow_count": 0, "outflow_count": 0, "error": "User is not in a family"}
    # Iterate all active items in the family
    items = plaid_service.list_items(family_id)
    all_inflow: list[dict] = []
    all_outflow: list[dict] = []

    for item in items:
        access_token = plaid_service.get_access_token(item["id"], family_id)
        if not access_token:
            continue
        try:
            req_args: dict[str, Any] = {"access_token": access_token}
            if account_id:
                req_args["account_ids"] = [account_id]
            resp = plaid_service._client().transactions_recurring_get(
                TransactionsRecurringGetRequest(**req_args)
            )
            resp_data = resp.to_dict() if hasattr(resp, "to_dict") else resp

            def _stream_summary(streams: list) -> list[dict]:
                out = []
                for s in (streams or []):
                    sd = s if isinstance(s, dict) else (s.to_dict() if hasattr(s, "to_dict") else {})
                    out.append({
                        "merchant_name": sd.get("merchant_name"),
                        "description": sd.get("description"),
                        "average_amount": sd.get("average_amount"),
                        "frequency": sd.get("frequency"),
                        "last_amount": sd.get("last_amount"),
                        "last_date": str(sd.get("last_date")) if sd.get("last_date") else None,
                        "account_id": sd.get("account_id"),
                    })
                return out

            all_inflow.extend(_stream_summary(resp_data.get("inflow_streams") or []))
            all_outflow.extend(_stream_summary(resp_data.get("outflow_streams") or []))
        except Exception as exc:
            logger.warning("bank_recurring: Plaid error for item %s: %s", item["id"], exc)

    return {
        "inflow_streams": all_inflow,
        "outflow_streams": all_outflow,
        "inflow_count": len(all_inflow),
        "outflow_count": len(all_outflow),
    }


# ---- FastAPI mount helper --------------------------------------------------

def build_mcp_app():
    """Return the Streamable HTTP ASGI app wrapped with auth middleware.
    Mount it on the main FastAPI app with `app.mount('/mcp', build_mcp_app())`."""
    asgi_app = mcp.streamable_http_app()
    asgi_app.add_middleware(McpAuthMiddleware)
    return asgi_app
