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
from typing import AsyncGenerator

import anthropic
from dotenv import load_dotenv
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()  # ensure ANTHROPIC_API_KEY + LANGFUSE_* land in os.environ for SDKs

from app.auth.dependencies import get_current_user
from app.models.user import User
from app.services import market_data, snaptrade_service

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

You have additional tools for FRED macro data, Tiingo price history + fundamentals, and Finnhub news + analyst targets - use them aggressively to ground claims in current data."""

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
]


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
        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

        return json.dumps(result, default=str)
    except Exception as exc:
        logger.exception("Tool %s failed", name)
        return json.dumps({"error": str(exc)})


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

            async with client.messages.stream(
                model=model_id,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                thinking={"type": "adaptive"},
                output_config={"effort": effort_level},
                tools=TOOLS,  # type: ignore[arg-type]
                messages=msgs,
            ) as stream:
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
                        # thinking blocks: silently consumed

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

                result_content = _execute_snaptrade_tool(tc["name"], tc["input"], user_id)
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
                    "content": result_content,
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
