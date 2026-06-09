"""Portfolio chat router: streams Claude Opus responses with live SnapTrade tool calls.

POST /api/v1/chat
  Body: {messages: [{role: "user"|"assistant", content: string}]}
  Response: text/event-stream SSE

Each SSE event is: data: <json>\n\n
Event shapes:
  {"type": "text", "text": "..."}
  {"type": "tool_call", "id": "...", "name": "...", "input": {...}}
  {"type": "tool_result", "id": "...", "name": "...", "content_preview": "..."}
  {"type": "done"}
  {"type": "error", "message": "..."}
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, AsyncGenerator

import anthropic
from dotenv import load_dotenv
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()  # ensure ANTHROPIC_API_KEY + LANGFUSE_* land in os.environ for SDKs

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.services import market_data, snaptrade_service
from app.services.budget_service import get_budget_service
from app.services.expense_service import get_expense_service
from app.services.firestore import get_firestore_client

logger = logging.getLogger(__name__)

router = APIRouter()

# Reuse the system prompt from snaptrade_analyze.py verbatim.
SYSTEM_PROMPT = """You are a senior portfolio analyst. The user will give you a current brokerage portfolio (accounts, positions, recent activity) pulled live from their broker via SnapTrade.

Your job: produce a thorough, opinionated analysis. Use the web_search tool aggressively to ground every macro/market claim in current data (interest rates, inflation prints, sector rotation, Fed posture, earnings, geopolitical events, sector-specific news). Cite the date of any data you pull.

Structure your response as Markdown with these sections, in order:

## 1. Portfolio snapshot
Total value, cash %, asset class mix, top 5 positions by weight, account-level breakdown. One-paragraph plain-English read.

## 2. Concentration & risk
Single-position risk, sector/factor tilts, currency, duration if any bonds, correlation clusters. Call out anything > 10% of portfolio explicitly.

## 3. Macro context (as of today)
Use web_search. Cover: rates path, inflation trend, USD, sector leadership/laggards, any near-term catalysts (CPI, FOMC, earnings). Tie each to specific positions in the portfolio.

## 4. Sell candidates
Specific tickers the user should consider trimming or exiting, with reasoning. Distinguish "trim" vs "exit". Tax considerations if obvious from activity.

## 5. Hold / accumulate
Positions to keep or add to, with reasoning grounded in the macro view.

## 6. Watch list
Events, prints, levels (price, yield, FX) that should trigger reassessment in the next 1-3 months.

## 7. Gaps & blind spots
What is missing from this portfolio that a balanced book of this risk profile should have. Be direct.

Style: direct, plain, no filler. No emoji. No "as an AI". Quote dates and numbers. Where you are uncertain, say so. This is for the user's own decision-making, not advice.

You have additional tools for FRED macro data, Tiingo price history + fundamentals, Finnhub news + analyst targets, and SEC EDGAR filings - use them aggressively to ground claims in current data. Use EDGAR tools to pull official 10-K/10-Q financials, 8-K material events, and Form 4 insider transactions for any position under discussion."""

TOOLS: list[dict] = [
    {"type": "web_search_20260209", "name": "web_search"},
    {
        "name": "list_accounts",
        "description": "List all brokerage accounts connected via SnapTrade for the calling user.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_holdings",
        "description": "Positions across every connected account. Primary portfolio pull.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_account_balances",
        "description": "Cash + buying-power balances for a specific account.",
        "input_schema": {
            "type": "object",
            "properties": {"account_id": {"type": "string", "description": "Account UUID"}},
            "required": ["account_id"],
        },
    },
    {
        "name": "get_account_positions",
        "description": "Positions for a single account.",
        "input_schema": {
            "type": "object",
            "properties": {"account_id": {"type": "string", "description": "Account UUID"}},
            "required": ["account_id"],
        },
    },
    {
        "name": "get_activities",
        "description": (
            "Transaction history (buys, sells, dividends, deposits, transfers). "
            "days: lookback window. account_ids: optional comma-separated account UUID allowlist."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Lookback window in days"},
                "account_ids": {
                    "type": "string",
                    "description": "Optional comma-separated account UUIDs",
                },
            },
            "required": [],
        },
    },
    {
        "name": "get_cost_basis",
        "description": (
            "Per-position cost basis, unrealized P&L, and return %. "
            "Returns account, symbol, qty, avg_cost, current_price, market_value, cost_basis, "
            "unrealized_pnl, return_pct. Set include_lots=true for per-lot detail."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "include_lots": {
                    "type": "boolean",
                    "description": "Include per-lot detail (date, qty, price)",
                }
            },
            "required": [],
        },
    },
    {
        "name": "portfolio_summary",
        "description": (
            "Condensed snapshot: total value, cash %, allocation by asset class, top 25 positions "
            "with cost basis and P&L inline. Good starting point before a deeper pull."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    # --- FRED macro indicators ---
    {
        "name": "macro_indicator",
        "description": (
            "Fetch a US macroeconomic indicator from FRED. Use when discussing rates, inflation, "
            "growth, employment, dollar strength, yield curve. "
            "Common series_id values: FEDFUNDS (Fed funds rate), CPIAUCSL (CPI all urban consumers), "
            "UNRATE (unemployment rate), DGS10 (10-year treasury yield), DGS2 (2-year treasury yield), "
            "T10Y2Y (10-2 spread — recession signal when below 0), "
            "DTWEXBGS (broad dollar index), WALCL (Fed balance sheet assets in $M), M2SL (M2 money supply)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "series_id": {
                    "type": "string",
                    "description": "FRED series ID, e.g. FEDFUNDS",
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of recent observations to return",
                    "default": 1,
                },
            },
            "required": ["series_id"],
        },
    },
    {
        "name": "macro_series",
        "description": (
            "Fetch a historical time series of a FRED macro indicator. Use when you need trend "
            "data over a date range (e.g. inflation over the past 2 years, rate path since 2022). "
            "Same series_id values as macro_indicator."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "series_id": {
                    "type": "string",
                    "description": "FRED series ID, e.g. CPIAUCSL",
                },
                "observation_start": {
                    "type": "string",
                    "description": "Start date YYYY-MM-DD (optional)",
                },
                "observation_end": {
                    "type": "string",
                    "description": "End date YYYY-MM-DD (optional)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max observations to return (default 100)",
                    "default": 100,
                },
            },
            "required": ["series_id"],
        },
    },
    # --- Tiingo price and fundamentals ---
    {
        "name": "price_history",
        "description": (
            "End-of-day OHLCV price history for a stock or ETF ticker. Use when analyzing "
            "price performance, drawing trend lines, or calculating returns over a period."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "Stock or ETF symbol, e.g. AAPL, SPY",
                },
                "start": {
                    "type": "string",
                    "description": "Start date YYYY-MM-DD (default: 1 year ago)",
                },
                "end": {
                    "type": "string",
                    "description": "End date YYYY-MM-DD (default: today)",
                },
            },
            "required": ["ticker"],
        },
    },
    {
        "name": "ticker_meta",
        "description": (
            "Company metadata for a stock ticker: full name, exchange, description, "
            "earliest and latest data available. Use to confirm a ticker is valid or "
            "to retrieve the company name and exchange."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "Stock symbol, e.g. MSFT",
                },
            },
            "required": ["ticker"],
        },
    },
    # --- Finnhub real-time and analyst data ---
    {
        "name": "ticker_quote",
        "description": (
            "Current real-time price, day high/low, and previous close for a stock. "
            "Use when the user asks about current price or intraday moves."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Stock ticker symbol, e.g. NVDA",
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "ticker_news",
        "description": (
            "Recent news articles about a stock. Use when analyzing a specific position "
            "or considering buy/sell decisions. Returns headlines, summaries, and URLs."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Stock ticker symbol",
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days of news to retrieve (default 14)",
                    "default": 14,
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "ticker_recommendations",
        "description": (
            "Wall Street analyst buy/hold/sell recommendation trends for a stock, "
            "typically covering the last 4 months. Use when assessing analyst sentiment "
            "or conviction around a position."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Stock ticker symbol",
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "ticker_price_target",
        "description": (
            "Analyst consensus price target for a stock: high, low, mean, and median targets. "
            "Use when assessing upside/downside vs current price or comparing analyst conviction."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Stock ticker symbol",
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "ticker_earnings_calendar",
        "description": (
            "Upcoming earnings dates and EPS/revenue estimates for a stock. "
            "Use when identifying near-term catalysts or event risk for a position."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {
                    "type": "string",
                    "description": "Stock ticker symbol",
                },
                "days_ahead": {
                    "type": "integer",
                    "description": "How many days ahead to look (default 90)",
                    "default": 90,
                },
            },
            "required": ["symbol"],
        },
    },
    # --- Expense + budget tools ---
    {
        "name": "expense_list",
        "description": (
            "List individual expense transactions for the user's family within a date range. "
            "Use when the user asks to see their recent transactions, wants to find a specific purchase, "
            "or needs a raw list of expenses filtered by category, beneficiary, or minimum amount. "
            "Returns each expense with id, date, amount, category, merchant, beneficiary, description."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD (inclusive)"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD (inclusive)"},
                "category": {
                    "type": "string",
                    "description": "Optional category filter",
                    "enum": ["groceries", "dining", "transportation", "utilities", "entertainment",
                             "healthcare", "shopping", "travel", "education", "other"],
                },
                "beneficiary": {"type": "string", "description": "Optional beneficiary filter (user ID or 'family')"},
                "min_amount": {"type": "number", "description": "Only return expenses >= this amount"},
                "limit": {"type": "integer", "description": "Max results to return (default 200)", "default": 200},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "expense_summary",
        "description": (
            "Aggregate expense totals grouped by category, beneficiary, month, or merchant for a date range. "
            "Use when the user asks 'how much did we spend on X', 'where is our money going', "
            "'show me spending by category', or 'compare this month to last month'. "
            "Returns [{key, count, total}] sorted by total descending."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
                "group_by": {
                    "type": "string",
                    "enum": ["category", "beneficiary", "month", "merchant"],
                    "description": "Dimension to group by (default: category)",
                    "default": "category",
                },
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "expense_top_merchants",
        "description": (
            "Top merchants/vendors ranked by total spend for a date range. "
            "Use when the user asks 'where do we spend the most', 'what stores cost us most', "
            "or wants to identify recurring high-spend vendors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "Start date YYYY-MM-DD"},
                "end_date": {"type": "string", "description": "End date YYYY-MM-DD"},
                "limit": {"type": "integer", "description": "Number of top merchants to return (default 10)", "default": 10},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "budget_status",
        "description": (
            "Current budget status for all family budgets: limit, spent, remaining, and whether each is on track. "
            "Use when the user asks 'are we on track with our budgets', 'how much is left in dining', "
            "'which budgets are over limit', or any question about budget vs actual spending. "
            "Returns [{category, period_start, period_end, limit, spent, remaining, pct_used, status}]."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reference_date": {
                    "type": "string",
                    "description": "Reference date YYYY-MM-DD to determine which budget period to evaluate (default: today)",
                },
            },
            "required": [],
        },
    },
    {
        "name": "budget_burn_rate",
        "description": (
            "Historical average monthly spend for a category vs the current budget limit. "
            "Use when the user asks 'is my dining budget realistic', 'am I under-budgeting for groceries', "
            "or wants to see if a budget reflects actual spending patterns. "
            "Returns {category, avg_monthly_spend, current_limit, ratio, months_analyzed}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Expense category to analyze",
                    "enum": ["groceries", "dining", "transportation", "utilities", "entertainment",
                             "healthcare", "shopping", "travel", "education", "other"],
                },
                "lookback_months": {
                    "type": "integer",
                    "description": "Number of past months to average over (default 3)",
                    "default": 3,
                },
            },
            "required": ["category"],
        },
    },
    # --- SEC EDGAR ---
    {
        "name": "edgar_company_lookup",
        "description": (
            "Resolve a stock ticker to its SEC CIK number and official company name. "
            "Use to disambiguate before pulling filings or facts, or when the user asks about "
            "a company's SEC identity."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Stock ticker symbol, e.g. AAPL"},
            },
            "required": ["ticker"],
        },
    },
    {
        "name": "edgar_recent_filings",
        "description": (
            "Recent SEC filings for a ticker from EDGAR. Use for fundamental analysis: "
            "10-K (annual report), 10-Q (quarterly), 8-K (material events like acquisitions, "
            "leadership changes, guidance), DEF 14A (proxy/exec compensation), "
            "Form 4 (insider buy/sell transactions). Returns filing dates and document URLs."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Stock ticker symbol"},
                "form_type": {
                    "type": "string",
                    "description": "Optional filter: '10-K', '10-Q', '8-K', '4', 'DEF 14A', etc.",
                },
                "limit": {"type": "integer", "description": "Max results (default 20)", "default": 20},
            },
            "required": ["ticker"],
        },
    },
    {
        "name": "edgar_company_facts",
        "description": (
            "SEC XBRL financial facts for a company: revenue, net income, assets, liabilities, "
            "EPS, shares outstanding, and more. Data comes from the company's own filings. "
            "If concept is omitted, returns a summary of key metrics with latest values. "
            "If concept is provided (e.g. 'Revenues', 'NetIncomeLoss', 'Assets'), returns "
            "the full history of that metric across all filing periods."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Stock ticker symbol"},
                "concept": {
                    "type": "string",
                    "description": (
                        "Optional XBRL concept: 'Revenues', 'NetIncomeLoss', 'Assets', "
                        "'Liabilities', 'EarningsPerShareBasic', 'CashAndCashEquivalentsAtCarryingValue'"
                    ),
                },
            },
            "required": ["ticker"],
        },
    },
    {
        "name": "edgar_insider_transactions",
        "description": (
            "Recent Form 4 insider transaction filings (buys and sells by officers, directors, "
            "and 10%+ shareholders) for a company. Use when assessing management conviction, "
            "insider selling pressure, or unusual buying activity."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Stock ticker symbol"},
                "days": {
                    "type": "integer",
                    "description": "Lookback window in days (default 90)",
                    "default": 90,
                },
            },
            "required": ["ticker"],
        },
    },
]


_EXPENSE_TOOLS = {"expense_list", "expense_summary", "expense_top_merchants", "budget_status", "budget_burn_rate"}


def _get_family_id(user_id: str) -> str | None:
    """Look up family_id for a user from Firestore."""
    db = get_firestore_client()
    doc = db.collection("users").document(user_id).get()
    if not doc.exists:
        return None
    return doc.to_dict().get("family_id")


async def _execute_expense_tool(name: str, tool_input: dict, user_id: str) -> str:
    """Execute a read-only expense/budget tool. Returns JSON string."""
    try:
        family_id = _get_family_id(user_id)
        if not family_id:
            return json.dumps({"error": "No family configured for this user."})

        if name == "expense_list":
            from datetime import date as _date
            from app.models.expense import ExpenseFilters, ExpenseCategory
            start = _date.fromisoformat(tool_input["start_date"])
            end = _date.fromisoformat(tool_input["end_date"])
            category_str = tool_input.get("category")
            beneficiary = tool_input.get("beneficiary")
            min_amount = tool_input.get("min_amount")
            limit = min(tool_input.get("limit", 200), 500)

            filters = ExpenseFilters(
                start_date=start,
                end_date=end,
                category=ExpenseCategory(category_str) if category_str else None,
                beneficiary=beneficiary,
            )
            svc = get_expense_service()
            # Fetch up to `limit` expenses (use page_size)
            expenses, total, _ = await svc.list(family_id, filters=filters, page=1, page_size=limit)
            result = []
            for e in expenses:
                row = {
                    "id": e.id,
                    "date": e.date.isoformat(),
                    "amount": e.amount,
                    "category": e.category,
                    "merchant": e.merchant,
                    "beneficiary": e.beneficiary,
                    "description": e.description,
                }
                if min_amount is not None and e.amount < min_amount:
                    continue
                result.append(row)
            return json.dumps({"expenses": result, "total_matching": total})

        elif name == "expense_summary":
            from datetime import date as _date
            start = _date.fromisoformat(tool_input["start_date"])
            end = _date.fromisoformat(tool_input["end_date"])
            group_by = tool_input.get("group_by", "category")
            svc = get_expense_service()

            if group_by in ("category", "beneficiary"):
                summary = await svc.get_summary(family_id, start, end)
                if group_by == "category":
                    data = summary.by_category
                else:
                    data = summary.by_beneficiary
                # Build count by fetching full list
                from app.models.expense import ExpenseFilters
                expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
                counts: dict[str, int] = {}
                for e in expenses:
                    key = e.category if group_by == "category" else e.beneficiary
                    counts[key] = counts.get(key, 0) + 1
                rows = [{"key": k, "count": counts.get(k, 0), "total": round(v, 2)}
                        for k, v in sorted(data.items(), key=lambda x: -x[1])]
                return json.dumps({"group_by": group_by, "rows": rows, "total_amount": round(summary.total_amount, 2)})

            elif group_by == "merchant":
                from app.models.expense import ExpenseFilters
                expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
                agg: dict[str, dict] = {}
                for e in expenses:
                    key = e.merchant or "(no merchant)"
                    if key not in agg:
                        agg[key] = {"count": 0, "total": 0.0}
                    agg[key]["count"] += 1
                    agg[key]["total"] += e.amount
                rows = [{"key": k, "count": v["count"], "total": round(v["total"], 2)}
                        for k, v in sorted(agg.items(), key=lambda x: -x[1]["total"])]
                return json.dumps({"group_by": "merchant", "rows": rows})

            elif group_by == "month":
                from app.models.expense import ExpenseFilters
                expenses, _, _ = await svc.list(family_id, filters=ExpenseFilters(start_date=start, end_date=end), page=1, page_size=1000)
                agg: dict[str, dict] = {}
                for e in expenses:
                    key = e.date.strftime("%Y-%m")
                    if key not in agg:
                        agg[key] = {"count": 0, "total": 0.0}
                    agg[key]["count"] += 1
                    agg[key]["total"] += e.amount
                rows = [{"key": k, "count": v["count"], "total": round(v["total"], 2)}
                        for k, v in sorted(agg.items())]
                return json.dumps({"group_by": "month", "rows": rows})

            return json.dumps({"error": f"Unknown group_by: {group_by}"})

        elif name == "expense_top_merchants":
            from datetime import date as _date
            from app.models.expense import ExpenseFilters
            start = _date.fromisoformat(tool_input["start_date"])
            end = _date.fromisoformat(tool_input["end_date"])
            limit = tool_input.get("limit", 10)
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
            result = [{"merchant": k, "count": v["count"], "total": round(v["total"], 2)} for k, v in rows]
            return json.dumps({"top_merchants": result})

        elif name == "budget_status":
            from datetime import date as _date
            ref_str = tool_input.get("reference_date")
            ref_date = _date.fromisoformat(ref_str) if ref_str else _date.today()
            svc = get_budget_service()
            statuses = await svc.list_with_status(family_id, reference_date=ref_date)
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
            return json.dumps({"budgets": result, "count": len(result)})

        elif name == "budget_burn_rate":
            from datetime import date as _date
            from dateutil.relativedelta import relativedelta
            category = tool_input["category"]
            lookback = tool_input.get("lookback_months", 3)
            svc_e = get_expense_service()
            svc_b = get_budget_service()
            today = _date.today()
            monthly_totals = []
            for i in range(lookback):
                month_start = (today.replace(day=1) - relativedelta(months=i + 1))
                if today.month == 12:
                    month_end = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
                else:
                    next_month = month_start.replace(month=month_start.month + 1, day=1) if month_start.month < 12 \
                        else month_start.replace(year=month_start.year + 1, month=1, day=1)
                    month_end = next_month - timedelta(days=1)
                total = await svc_e.get_spending_for_budget(family_id, month_start, month_end, category=category)
                monthly_totals.append(total)
            avg = sum(monthly_totals) / len(monthly_totals) if monthly_totals else 0
            # Find current budget limit for this category
            budgets = await svc_b.list(family_id)
            current_limit = None
            for b in budgets:
                if b.category == category:
                    current_limit = b.amount
                    break
            ratio = (avg / current_limit) if current_limit else None
            return json.dumps({
                "category": category,
                "avg_monthly_spend": round(avg, 2),
                "current_limit": current_limit,
                "ratio": round(ratio, 2) if ratio is not None else None,
                "months_analyzed": lookback,
                "monthly_totals": [round(x, 2) for x in monthly_totals],
            })

        return json.dumps({"error": f"Unknown expense tool: {name}"})
    except Exception as exc:
        logger.exception("Expense tool %s failed", name)
        return json.dumps({"error": str(exc)})


def _execute_snaptrade_tool(name: str, tool_input: dict, user_id: str) -> str:
    """Call the appropriate snaptrade_service function and return JSON string."""
    try:
        if name == "list_accounts":
            result = snaptrade_service.list_accounts(user_id)
        elif name == "get_holdings":
            result = snaptrade_service.get_all_holdings(user_id)
        elif name == "get_account_balances":
            result = snaptrade_service.get_account_balances(user_id, tool_input["account_id"])
        elif name == "get_account_positions":
            result = snaptrade_service.get_account_positions(user_id, tool_input["account_id"])
        elif name == "get_activities":
            days = tool_input.get("days", 60)
            end = date.today()
            start = end - timedelta(days=days)
            result = snaptrade_service.get_activities(
                user_id,
                start_date=start.isoformat(),
                end_date=end.isoformat(),
                accounts=tool_input.get("account_ids"),
            )
        elif name == "get_cost_basis":
            # Reuse the cost-basis logic from mcp_server.py
            holdings = snaptrade_service.get_all_holdings(user_id)
            include_lots = tool_input.get("include_lots", False)
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
                        "account": acct_label,
                        "symbol": sym,
                        "qty": qty,
                        "avg_cost": avg_cost,
                        "current_price": price,
                        "market_value": round(mv, 2),
                        "cost_basis": round(cost, 2) if cost is not None else None,
                        "unrealized_pnl": round(pnl, 2) if pnl is not None else None,
                        "return_pct": round(ret_pct, 2) if ret_pct is not None else None,
                    }
                    if include_lots:
                        row["tax_lots"] = p.get("tax_lots") or []
                    rows.append(row)
            result = sorted(rows, key=lambda r: -(r["market_value"] or 0))
        elif name == "portfolio_summary":
            accounts = snaptrade_service.list_accounts(user_id)
            holdings = snaptrade_service.get_all_holdings(user_id)
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
                        "symbol": sym,
                        "qty": qty,
                        "price": price,
                        "market_value": mv,
                        "type": asset_type,
                        "avg_cost": avg_cost,
                        "cost_basis": round(cost, 2) if cost is not None else None,
                        "unrealized_pnl": round(pnl, 2) if pnl is not None else None,
                        "return_pct": round(ret_pct, 2) if ret_pct is not None else None,
                    })
                for b in entry.get("balances") or []:
                    amt = b.get("cash") or 0
                    cash += amt
                    total += amt
            result = {
                "as_of": date.today().isoformat(),
                "total_value": total,
                "cash": cash,
                "cash_pct": (cash / total * 100) if total else 0,
                "accounts": [
                    {
                        "institution": a.get("institution_name"),
                        "name": a.get("name"),
                        "total": ((a.get("balance") or {}).get("total") or {}).get("amount"),
                    }
                    for a in accounts
                ],
                "by_asset_class": dict(by_asset_class),
                "top_positions": sorted(positions, key=lambda x: -x["market_value"])[:25],
            }
        # --- FRED macro tools ---
        elif name == "macro_indicator":
            result = market_data.fred_observation(
                series_id=tool_input["series_id"],
                limit=tool_input.get("limit", 1),
            )
        elif name == "macro_series":
            result = market_data.fred_series(
                series_id=tool_input["series_id"],
                observation_start=tool_input.get("observation_start"),
                observation_end=tool_input.get("observation_end"),
                limit=tool_input.get("limit", 100),
            )
        # --- Tiingo price / fundamentals tools ---
        elif name == "price_history":
            result = market_data.tiingo_eod(
                ticker=tool_input["ticker"],
                start=tool_input.get("start"),
                end=tool_input.get("end"),
            )
        elif name == "ticker_meta":
            result = market_data.tiingo_meta(ticker=tool_input["ticker"])
        # --- Finnhub tools ---
        elif name == "ticker_quote":
            result = market_data.finnhub_quote(symbol=tool_input["symbol"])
        elif name == "ticker_news":
            result = market_data.finnhub_company_news(
                symbol=tool_input["symbol"],
                days=tool_input.get("days", 14),
            )
        elif name == "ticker_recommendations":
            result = market_data.finnhub_recommendations(symbol=tool_input["symbol"])
        elif name == "ticker_price_target":
            result = market_data.finnhub_price_target(symbol=tool_input["symbol"])
        elif name == "ticker_earnings_calendar":
            result = market_data.finnhub_earnings_calendar(
                symbol=tool_input["symbol"],
                days_ahead=tool_input.get("days_ahead", 90),
            )
        # --- SEC EDGAR tools ---
        elif name == "edgar_company_lookup":
            result = market_data.edgar_company_lookup(ticker=tool_input["ticker"])
        elif name == "edgar_recent_filings":
            result = market_data.edgar_recent_filings(
                ticker=tool_input["ticker"],
                form_type=tool_input.get("form_type"),
                limit=tool_input.get("limit", 20),
            )
        elif name == "edgar_company_facts":
            result = market_data.edgar_company_facts(
                ticker=tool_input["ticker"],
                concept=tool_input.get("concept"),
            )
        elif name == "edgar_insider_transactions":
            result = market_data.edgar_insider_transactions(
                ticker=tool_input["ticker"],
                days=tool_input.get("days", 90),
            )
        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

        return json.dumps(result, default=str)
    except Exception as exc:
        logger.exception("Tool %s failed", name)
        return json.dumps({"error": str(exc)})


# Per-tool size budgets for what gets fed back to Claude in conversation
# history. Numbers chosen to keep the model fully informed of recent
# results while preventing 50KB EDGAR / Tiingo dumps from dominating the
# input-token budget on turn N+1. The frontend still receives the
# 500-char preview for display purposes.
_TOOL_CONTEXT_BUDGETS: dict[str, int] = {
    # Cheap structured data — keep small budget
    "list_accounts": 4_000,
    "get_account_balances": 2_000,
    "get_account_positions": 4_000,
    "ticker_quote": 1_500,
    "ticker_price_target": 1_500,
    "ticker_recommendations": 2_000,
    "macro_indicator": 1_500,
    "budget_status": 3_000,
    "budget_burn_rate": 1_500,
    "expense_top_merchants": 3_000,
    # Bigger structured data — keep enough for analysis but cap aggressively
    "portfolio_summary": 6_000,
    "get_cost_basis": 6_000,
    "get_holdings": 8_000,
    "get_activities": 6_000,
    "expense_list": 6_000,
    "expense_summary": 4_000,
    "macro_series": 4_000,
    "price_history": 4_000,
    "ticker_meta": 2_500,
    "ticker_earnings_calendar": 3_000,
    # News / EDGAR are verbose — recent results matter more than back catalog
    "ticker_news": 4_000,
    "edgar_recent_filings": 4_000,
    "edgar_company_facts": 6_000,
    "edgar_insider_transactions": 4_000,
    "edgar_company_lookup": 1_500,
    "web_search": 8_000,  # server tool — usually fine
}
_DEFAULT_CONTEXT_BUDGET = 4_000  # chars


def _truncate_tool_result(name: str, content: str) -> str:
    """Cap the tool result going back into model context. If the payload is
    larger than the per-tool budget, keep the head + a trailing summary so
    the model knows the result was truncated and can request a more
    targeted call if needed."""
    budget = _TOOL_CONTEXT_BUDGETS.get(name, _DEFAULT_CONTEXT_BUDGET)
    if len(content) <= budget:
        return content
    head = content[: budget - 200]
    return (
        head
        + f"\n\n…[result truncated for context budget: {len(content)} chars; "
        f"showing first {budget - 200}. Call the tool with narrower filters "
        f"(date range, ticker, limit) for the full payload.]"
    )


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


async def _stream_chat(
    messages: list[dict],
    user_id: str,
    session_id: str,
) -> AsyncGenerator[str, None]:
    """Core agentic loop: stream tokens, handle tool calls, continue until end_turn."""
    # Lazy Langfuse init — skipped if env vars are absent so dev works without them.
    lf_trace = None
    try:
        from langfuse import Langfuse  # type: ignore

        lf = Langfuse()
        lf_trace = lf.trace(
            name="portfolio-chat",
            session_id=session_id,
            user_id=user_id,
        )
    except Exception:
        pass  # Langfuse optional

    client = anthropic.AsyncAnthropic()

    # Adaptive model + effort routing based on the latest user query.
    # Default to Sonnet (fast); upgrade to Opus + higher effort only for analytical asks.
    DEEP_KEYWORDS = (
        "analyze", "analysis", "risk", "concentration", "macro", "rebalance",
        "tax", "harvest", "what should i sell", "recommend", "should i", "advice",
        "evaluate", "compare", "diversif", "outlook",
    )
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "",
    ).lower()
    is_deep = any(kw in last_user for kw in DEEP_KEYWORDS)
    model_id = "claude-opus-4-7" if is_deep else "claude-sonnet-4-6"
    effort_level = "high" if is_deep else "medium"
    logger.info(f"chat routing: model={model_id} effort={effort_level} deep={is_deep}")

    # Working copy of the messages list for the agentic loop.
    msgs: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages]

    # When the model uses server-side tools like web_search_20260209 that run
    # in Anthropic's code-execution sandbox, the response carries a `container`
    # id. We MUST pass it back on every subsequent agentic-loop turn or the
    # API rejects with "container_id is required when there are pending tool
    # uses generated by code execution with tools".
    server_container_id: str | None = None

    output_text_parts: list[str] = []

    try:
        while True:
            # ---- Single Claude call (streaming) --------------------------------
            tool_use_blocks: list[dict] = []  # accumulated from this turn
            text_parts: list[str] = []
            # Track in-progress tool_use blocks
            current_tool_id: str | None = None
            current_tool_name: str | None = None
            current_tool_input_chunks: list[str] = []
            # Full content blocks to reconstruct the assistant message
            raw_content: list[dict] = []
            # Track open text block
            in_text_block = False
            current_text_content: list[str] = []

            stream_kwargs: dict[str, Any] = dict(
                model=model_id,
                max_tokens=16000,
                # Prompt caching: system + tools never change between turns
                # of the agentic loop. Auto-caches the last cacheable block,
                # so subsequent turns read the (system + tools) prefix at
                # ~10% of normal input cost.
                cache_control={"type": "ephemeral"},
                system=[{"type": "text", "text": SYSTEM_PROMPT}],
                thinking={"type": "adaptive"},
                output_config={"effort": effort_level},
                # Server-side context compaction (Anthropic beta). When the
                # conversation history grows past the trigger threshold,
                # Claude itself summarizes older tool results in-place so
                # the input-token cost per turn stays bounded. Without this,
                # 4-5 tool-heavy turns blow past the 30K input TPM limit.
                betas=["compact-2026-01-12"],
                context_management={"edits": [{"type": "compact_20260112"}]},
                tools=TOOLS,
                messages=msgs,
            )
            if server_container_id:
                # Thread the code-execution container created by server-side
                # tools (e.g. web_search_20260209) across agentic-loop turns.
                stream_kwargs["container"] = server_container_id

            async with client.beta.messages.stream(**stream_kwargs) as stream:
                async for event in stream:
                    etype = event.type

                    if etype == "content_block_start":
                        block = event.content_block
                        if block.type == "text":
                            in_text_block = True
                            current_text_content = []
                        elif block.type == "tool_use":
                            current_tool_id = block.id
                            current_tool_name = block.name
                            current_tool_input_chunks = []
                        elif block.type == "thinking":
                            # Surface a lightweight status so the UI can show
                            # the model is reasoning between tool calls.
                            yield _sse({"type": "status", "phase": "thinking"})

                    elif etype == "content_block_delta":
                        delta = event.delta
                        if getattr(delta, "type", None) == "text_delta":
                            text_parts.append(delta.text)
                            current_text_content.append(delta.text)
                            yield _sse({"type": "text", "text": delta.text})
                        elif getattr(delta, "type", None) == "input_json_delta" and current_tool_id:
                            current_tool_input_chunks.append(delta.partial_json)

                    elif etype == "content_block_stop":
                        if in_text_block:
                            raw_content.append({"type": "text", "text": "".join(current_text_content)})
                            in_text_block = False
                            current_text_content = []
                        elif current_tool_id:
                            input_str = "".join(current_tool_input_chunks)
                            try:
                                parsed_input = json.loads(input_str) if input_str else {}
                            except json.JSONDecodeError:
                                parsed_input = {}
                            raw_content.append({
                                "type": "tool_use",
                                "id": current_tool_id,
                                "name": current_tool_name,
                                "input": parsed_input,
                            })
                            tool_use_blocks.append({
                                "id": current_tool_id,
                                "name": current_tool_name,
                                "input": parsed_input,
                            })
                            current_tool_id = None
                            current_tool_name = None
                            current_tool_input_chunks = []

                final_msg = await stream.get_final_message()
                # Capture the code-execution container id so subsequent
                # turns can refer to the same container (required when web
                # search etc. leaves pending tool uses).
                container = getattr(final_msg, "container", None)
                if container is not None:
                    container_id = getattr(container, "id", None) or container.get("id") if isinstance(container, dict) else getattr(container, "id", None)
                    if container_id:
                        server_container_id = container_id

            output_text_parts.extend(text_parts)
            stop_reason = final_msg.stop_reason

            # ---- No tool calls: we are done -----------------------------------
            if stop_reason == "end_turn" or not tool_use_blocks:
                break

            # ---- Tool calls: emit events, execute, continue loop --------------
            # Use the SDK's fully-assembled content (preserves thinking blocks
            # + signatures, which Opus 4.7's adaptive thinking REQUIRES on
            # subsequent turns; manually reconstructing drops them and the
            # next turn returns empty/degraded responses).
            assistant_content = [
                block.model_dump(exclude_none=True) if hasattr(block, "model_dump") else block
                for block in final_msg.content
            ]
            msgs.append({"role": "assistant", "content": assistant_content})

            tool_results: list[dict] = []
            for tc in tool_use_blocks:
                yield _sse({
                    "type": "tool_call",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": tc["input"],
                })

                if tc["name"] in _EXPENSE_TOOLS:
                    result_content = await _execute_expense_tool(tc["name"], tc["input"], user_id)
                else:
                    result_content = _execute_snaptrade_tool(tc["name"], tc["input"], user_id)

                # Cap the version that goes back into model context. Large
                # tool payloads (portfolio_summary, edgar_company_facts,
                # ticker_news) can be tens of KB; we re-send them every
                # turn, which dominates input-token usage. Combined with
                # auto-compaction this keeps the conversation lean.
                # The FRONTEND still sees the original preview (500 chars)
                # via the SSE event — the cap only affects what's threaded
                # back into Claude's history.
                context_content = _truncate_tool_result(tc["name"], result_content)
                preview = result_content[:500]
                yield _sse({
                    "type": "tool_result",
                    "id": tc["id"],
                    "name": tc["name"],
                    "content_preview": preview,
                })
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tc["id"],
                    "content": context_content,
                })

            # Append tool results as user turn.
            msgs.append({"role": "user", "content": tool_results})

        yield _sse({"type": "done"})

        # Langfuse: log complete generation
        if lf_trace:
            try:
                lf_trace.update(
                    output={"text": "".join(output_text_parts)},
                    metadata={"turns": len(msgs)},
                )
                lf.flush()
            except Exception:
                pass

    except Exception as exc:
        logger.exception("Chat stream error for user %s", user_id)
        yield _sse({"type": "error", "message": str(exc)})
        if lf_trace:
            try:
                lf_trace.update(metadata={"error": str(exc)})
                lf.flush()  # type: ignore
            except Exception:
                pass


class ChatRequest(BaseModel):
    messages: list[dict]


@router.post("")
async def chat(
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    """Stream a Claude Opus response with live SnapTrade portfolio tools."""
    if not body.messages:
        return {"error": "messages must not be empty"}

    # Session ID: stable hash of (user_id + first user message content)
    first_content = body.messages[0].get("content", "")
    session_id = hashlib.sha256(
        f"{current_user.id}:{first_content}".encode()
    ).hexdigest()[:16]

    return StreamingResponse(
        _stream_chat(body.messages, current_user.id, session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
