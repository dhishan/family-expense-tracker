"""SnapTrade MCP server — exposes brokerage portfolio as tools to Claude Desktop/Code.

Tools:
  list_accounts         -> connected brokerage accounts (Robinhood, E*TRADE, ...)
  get_holdings          -> positions across all accounts
  get_account_balances  -> per-account balances
  get_account_positions -> per-account positions
  get_activities        -> transaction history (buys/sells/divs)
  portfolio_summary     -> condensed snapshot (top positions, allocation, cash %)

The internal user ID is read from env var SNAPTRADE_USER_ID (set in the MCP client
config), so the model doesn't need to pass it on every call.

Run standalone (for debugging):
  SNAPTRADE_USER_ID=iamdhishan .venv/bin/python -m scripts.snaptrade_mcp
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv()

from app.services import snaptrade_service  # noqa: E402

USER_ID = os.environ.get("SNAPTRADE_USER_ID")
if not USER_ID:
    raise SystemExit("SNAPTRADE_USER_ID env var is required")

mcp = FastMCP("snaptrade")


@mcp.tool()
def list_accounts() -> list[dict]:
    """List all brokerage accounts connected via SnapTrade (Robinhood, E*TRADE, etc.).
    Returns institution name, account name, total balance, sync status."""
    return snaptrade_service.list_accounts(USER_ID)


@mcp.tool()
def get_holdings() -> list[dict]:
    """Get all positions across every connected account. Includes symbol, quantity,
    price, market value, asset class. Use this as the primary portfolio pull."""
    return snaptrade_service.get_all_holdings(USER_ID)


@mcp.tool()
def get_account_balances(account_id: str) -> list[dict]:
    """Get cash + buying-power balances for a specific account (use list_accounts to find IDs)."""
    return snaptrade_service.get_account_balances(USER_ID, account_id)


@mcp.tool()
def get_account_positions(account_id: str) -> list[dict]:
    """Get positions for a single account. Use get_holdings for the full cross-account view."""
    return snaptrade_service.get_account_positions(USER_ID, account_id)


@mcp.tool()
def get_activities(days: int = 60, account_ids: str | None = None) -> list[dict]:
    """Transaction history (buys, sells, dividends, deposits, transfers).
    days: lookback window (default 60).
    account_ids: optional comma-separated list to scope to specific accounts."""
    end = date.today()
    start = end - timedelta(days=days)
    return snaptrade_service.get_activities(
        USER_ID, start_date=start.isoformat(), end_date=end.isoformat(), accounts=account_ids,
    )


@mcp.tool()
def get_cost_basis(include_lots: bool = False) -> list[dict]:
    """Cost basis, unrealized P&L, and % return for every position across all accounts.
    Returns one row per position with: account, symbol, qty, avg_cost, current_price,
    market_value, cost_basis, unrealized_pnl, return_pct. Set include_lots=true to also
    return per-lot detail (acquisition date, quantity, price) where the broker provides it.
    Use this for sell-candidate analysis, tax-loss harvesting, and lot-level decisions."""
    holdings = snaptrade_service.get_all_holdings(USER_ID)
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
    return sorted(rows, key=lambda r: -(r["market_value"] or 0))


@mcp.tool()
def portfolio_summary() -> dict[str, Any]:
    """Condensed portfolio snapshot: total value, cash %, allocation by asset class,
    top positions sorted by market value. Cheaper / smaller than get_holdings."""
    accounts = snaptrade_service.list_accounts(USER_ID)
    holdings = snaptrade_service.get_all_holdings(USER_ID)
    by_symbol: dict[str, float] = defaultdict(float)
    by_asset_class: dict[str, float] = defaultdict(float)
    total = 0.0
    cash = 0.0
    positions: list[dict] = []

    for acct in holdings:
        for p in acct.get("positions") or []:
            sym_node = (p.get("symbol") or {}).get("symbol") or {}
            sym = sym_node.get("symbol") or "?"
            qty = p.get("units") or 0
            price = p.get("price") or 0
            mv = qty * price
            asset_type = (sym_node.get("type") or {}).get("description") or "Equity"
            by_symbol[sym] += mv
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
        for b in acct.get("balances") or []:
            amt = b.get("cash") or 0
            cash += amt
            total += amt

    if not total:
        for a in accounts:
            total += ((a.get("balance") or {}).get("total") or {}).get("amount") or 0

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


if __name__ == "__main__":
    mcp.run()
