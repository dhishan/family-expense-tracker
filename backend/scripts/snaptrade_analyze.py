"""Portfolio analysis: SnapTrade pull + Claude Opus 4.7 commentary.

Pulls the current portfolio (accounts, holdings, balances, recent activity) from
SnapTrade, then asks Claude to analyze it against current macro conditions using
the server-side web_search tool to fetch live market context.

Output: positions summary table + Claude's structured commentary covering
allocation, risks, sell candidates, things to watch, and macro context.

Usage:
  export ANTHROPIC_API_KEY=...
  python -m scripts.snaptrade_analyze --user-id <uid>
  python -m scripts.snaptrade_analyze --user-id <uid> --activity-days 90
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta

import anthropic
from dotenv import load_dotenv

from app.services import snaptrade_service

load_dotenv()  # picks up backend/.env when run from backend/


MODEL = "claude-opus-4-7"

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

Style: direct, plain, no filler. No emoji. No "as an AI". Quote dates and numbers. Where you are uncertain, say so. This is for the user's own decision-making, not advice."""


def summarize_holdings(accounts: list[dict], holdings: list[dict]) -> dict:
    by_symbol: dict[str, float] = defaultdict(float)
    by_asset_class: dict[str, float] = defaultdict(float)
    total = 0.0
    cash = 0.0
    positions: list[dict] = []

    for entry in holdings:
        acct = entry.get("account") or {}
        for p in entry.get("positions") or []:
            sym_node = (p.get("symbol") or {}).get("symbol") or {}
            sym = sym_node.get("symbol") or "?"
            qty = p.get("units") or 0
            price = p.get("price") or 0
            mv = (qty or 0) * (price or 0)
            asset_type = (sym_node.get("type") or {}).get("description") or "Equity"
            by_symbol[sym] += mv
            by_asset_class[asset_type] += mv
            total += mv
            positions.append({"symbol": sym, "qty": qty, "price": price, "market_value": mv, "type": asset_type})
        for b in entry.get("balances") or []:
            amt = b.get("cash") or 0
            cash += amt
            total += amt

    if not total:
        for a in accounts:
            bal = a.get("balance") or {}
            t = (bal.get("total") or {}).get("amount") or 0
            total += t

    return {
        "total_value": total,
        "cash": cash,
        "cash_pct": (cash / total * 100) if total else 0,
        "positions": sorted(positions, key=lambda x: -x["market_value"]),
        "by_symbol": dict(sorted(by_symbol.items(), key=lambda kv: -kv[1])),
        "by_asset_class": dict(by_asset_class),
    }


def print_summary(summary: dict, accounts: list[dict]) -> None:
    print(f"\n=== Portfolio Snapshot ===")
    print(f"Total value: ${summary['total_value']:,.2f}")
    print(f"Cash:        ${summary['cash']:,.2f} ({summary['cash_pct']:.1f}%)")
    print(f"\nAccounts ({len(accounts)}):")
    for a in accounts:
        bal = (a.get("balance") or {}).get("total") or {}
        print(f"  {a.get('institution_name'):<20} {a.get('name', ''):<30} ${bal.get('amount', 0):,.2f}")
    print(f"\nTop positions:")
    for p in summary["positions"][:15]:
        pct = (p["market_value"] / summary["total_value"] * 100) if summary["total_value"] else 0
        print(f"  {p['symbol']:<8} {p['qty']:>10.4f} @ ${p['price']:>10.2f} = ${p['market_value']:>12,.2f} ({pct:>5.1f}%) [{p['type']}]")


def build_user_prompt(summary: dict, accounts: list[dict], activities: list[dict]) -> str:
    today = date.today().isoformat()
    payload = {
        "as_of": today,
        "accounts": [
            {
                "institution": a.get("institution_name"),
                "name": a.get("name"),
                "balance": (a.get("balance") or {}).get("total"),
                "type": a.get("raw_type") or a.get("account_category"),
            }
            for a in accounts
        ],
        "summary": {
            "total_value": summary["total_value"],
            "cash": summary["cash"],
            "cash_pct": summary["cash_pct"],
            "by_asset_class": summary["by_asset_class"],
        },
        "positions": summary["positions"],
        "recent_activities_count": len(activities),
        "recent_activities": activities[:200],
    }
    return (
        "Here is my current portfolio pulled live from SnapTrade today "
        f"({today}). Analyze it per the system prompt, using web_search for current macro data.\n\n"
        f"```json\n{json.dumps(payload, indent=2, default=str)}\n```"
    )


def run_claude(user_prompt: str) -> None:
    client = anthropic.Anthropic()
    print("\n=== Claude analysis (streaming) ===\n")
    with client.messages.stream(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        tools=[{"type": "web_search_20260209", "name": "web_search"}],
        messages=[{"role": "user", "content": user_prompt}],
    ) as stream:
        for event in stream:
            if event.type == "content_block_delta" and getattr(event.delta, "type", None) == "text_delta":
                print(event.delta.text, end="", flush=True)
            elif event.type == "content_block_start":
                block = event.content_block
                if block.type == "server_tool_use" and block.name == "web_search":
                    print(f"\n  [searching: {block.input.get('query', '?')!r}]", flush=True)
        final = stream.get_final_message()
    print(f"\n\n--- usage: in={final.usage.input_tokens} out={final.usage.output_tokens} ---")


def main() -> int:
    p = argparse.ArgumentParser(description="Portfolio analysis via SnapTrade + Claude")
    p.add_argument("--user-id", required=True)
    p.add_argument("--activity-days", type=int, default=60, help="Days of activity history to include")
    p.add_argument("--no-llm", action="store_true", help="Print portfolio summary only, skip Claude")
    args = p.parse_args()

    if not args.no_llm and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: set ANTHROPIC_API_KEY (or pass --no-llm).", file=sys.stderr)
        return 2

    accounts = snaptrade_service.list_accounts(args.user_id)
    holdings = snaptrade_service.get_all_holdings(args.user_id)
    end = date.today()
    start = end - timedelta(days=args.activity_days)
    try:
        activities = snaptrade_service.get_activities(
            args.user_id, start_date=start.isoformat(), end_date=end.isoformat()
        )
    except Exception as e:
        print(f"WARN: activities pull failed ({e}); continuing without.", file=sys.stderr)
        activities = []

    summary = summarize_holdings(accounts, holdings)
    print_summary(summary, accounts)

    if args.no_llm:
        return 0

    run_claude(build_user_prompt(summary, accounts, activities))
    return 0


if __name__ == "__main__":
    sys.exit(main())
