"""Budget suggestion via Claude Haiku.

Single-responsibility module: given a list of pending transactions and the
family's budgets, call Haiku once and return a transaction_id->budget_id map.

Design principles:
- Entirely best-effort. Every error path returns {}.
- No streaming — one synchronous messages.create call.
- Langfuse span is wrapped in try/except so instrumentation never breaks the call.
- The caller (sync_transactions) never awaits this — it's sync.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def suggest_budgets_for_batch(
    transactions: list[dict],
    budgets: list[Any],  # list[BudgetResponse] but avoid circular import
    family_members: list[dict] | None = None,
) -> dict[str, str | None]:
    """Map transaction.id -> suggested budget_id (or None if no good match).

    Each transaction dict must have:
        id, merchant_name, name, amount, plaid_category, account_type,
        account_name, date

    Each budget is a BudgetResponse (has .id, .name, .category, .beneficiary,
    .amount, .period).

    Returns {} on any error (missing API key, Haiku timeout, bad JSON, etc.).
    """
    if not transactions or not budgets:
        logger.info("suggest_budgets_for_batch: no transactions or no budgets — skipping")
        return {}

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        logger.info("suggest_budgets_for_batch: ANTHROPIC_API_KEY not set — skipping")
        return {}

    try:
        return _call_haiku(transactions, budgets, family_members or [])
    except Exception as exc:
        logger.warning("suggest_budgets_for_batch: unexpected error — %s", exc)
        return {}


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are a budget classifier. Given a list of a family's budgets and a list of bank \
transactions, return the best-matching budget_id for each transaction (or null if no \
budget reasonably matches).

Rules:
- The budget's name often encodes the intended purpose AND the beneficiary, \
e.g. "Eating Out - Nithya" means dining for Nithya.
- Match by combining: merchant, amount magnitude, Plaid category, AND the \
budget's name/category/beneficiary.
- If multiple budgets could match, pick the most specific one (matches both \
category AND beneficiary > matches only category).
- If a budget has category=null, it is a catch-all — only suggest it if no \
category-specific budget fits.
- Income transactions (negative amounts, Plaid category INCOME/TRANSFER_IN) \
should return null (no budget).
- Return strictly JSON, no prose. \
Schema: {"suggestions": [{"transaction_id": "...", "budget_id": "..." | null, \
"reason": "<short>"}, ...]}
- Include every transaction_id exactly once. reason should be 5-12 words \
explaining the choice.\
"""


def _build_user_prompt(
    transactions: list[dict],
    budgets: list[Any],
    family_members: list[dict],
) -> str:
    budget_rows = []
    for b in budgets:
        budget_rows.append({
            "id": b.id,
            "name": b.name,
            "category": b.category,
            "beneficiary_user_id": b.beneficiary,
            "amount": b.amount,
            "period": b.period,
        })

    txn_rows = []
    for t in transactions:
        pfc = t.get("plaid_category") or {}
        primary = pfc.get("primary", "") if isinstance(pfc, dict) else str(pfc)
        txn_rows.append({
            "transaction_id": t.get("id"),
            "merchant": t.get("merchant_name") or "",
            "name": t.get("name") or "",
            "amount": t.get("amount", 0),
            "plaid_category": primary,
            "account_type": t.get("account_type") or "",
            "account_name": t.get("account_name") or "",
            "date": t.get("date") or "",
        })

    lines = [
        "Budgets:",
        json.dumps(budget_rows, default=str),
        "",
        "Family members:",
        json.dumps(family_members, default=str),
        "",
        "Transactions:",
        json.dumps(txn_rows, default=str),
        "",
        "Return the suggestions JSON.",
    ]
    return "\n".join(lines)


def _strip_fences(text: str) -> str:
    """Remove optional ```json ... ``` code fences that Haiku sometimes adds."""
    stripped = re.sub(r"^```[a-z]*\n?", "", text.strip(), flags=re.IGNORECASE)
    stripped = re.sub(r"\n?```$", "", stripped.strip())
    return stripped.strip()


def _call_haiku(
    transactions: list[dict],
    budgets: list[Any],
    family_members: list[dict],
) -> dict[str, str | None]:
    import anthropic  # lazy import — only when key is present

    valid_budget_ids = {b.id for b in budgets}
    user_prompt = _build_user_prompt(transactions, budgets, family_members)

    # Langfuse (best-effort)
    lf_gen = None
    try:
        from langfuse import Langfuse  # type: ignore
        lf = Langfuse()
        lf_gen = lf.start_observation(
            name="plaid-budget-suggester",
            as_type="generation",
            model="claude-haiku-4-5",
            input={"system": _SYSTEM_PROMPT, "user": user_prompt},
            metadata={"source": "haiku-budget-suggestion"},
        )
    except Exception as lf_err:
        logger.debug("Langfuse init skipped: %s", lf_err)

    client = anthropic.Anthropic()
    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1500,
            temperature=0,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            timeout=20,
        )
    except Exception as api_err:
        logger.warning("suggest_budgets_for_batch: Haiku API error — %s", api_err)
        _safe_lf_end(lf_gen, error=str(api_err))
        return {}

    raw_text = response.content[0].text if response.content else ""
    _safe_lf_end(
        lf_gen,
        output=raw_text,
        usage={
            "input": response.usage.input_tokens if response.usage else 0,
            "output": response.usage.output_tokens if response.usage else 0,
        },
    )

    # Record usage (best-effort)
    try:
        from app.services import usage_service as _usage_svc
        _usage_svc.record_usage(
            user_id="system",
            family_id=None,
            source="haiku-budget-suggestion",
            model="claude-haiku-4-5",
            conversation_id=None,
            turn_id=None,
            usage=response.usage,
            duration_ms=0,
        )
    except Exception as _ue:
        logger.warning("usage_service record failed in budget_suggester (non-fatal): %s", _ue)

    # Parse
    try:
        payload = json.loads(_strip_fences(raw_text))
        suggestions = payload.get("suggestions", [])
    except Exception as parse_err:
        logger.warning("suggest_budgets_for_batch: JSON parse error — %s | raw=%r", parse_err, raw_text[:200])
        return {}

    result: dict[str, str | None] = {}
    for entry in suggestions:
        txn_id = entry.get("transaction_id")
        budget_id = entry.get("budget_id")
        if not txn_id:
            continue
        if budget_id is not None and budget_id not in valid_budget_ids:
            logger.warning(
                "suggest_budgets_for_batch: hallucinated budget_id %r for txn %s — dropping",
                budget_id, txn_id,
            )
            budget_id = None
        result[txn_id] = budget_id

    logger.info(
        "suggest_budgets_for_batch: %d/%d suggestions resolved",
        sum(1 for v in result.values() if v is not None),
        len(transactions),
    )
    return result


def _safe_lf_end(obs, **kwargs):
    if not obs:
        return
    try:
        if kwargs:
            obs.update(**kwargs)
        obs.end()
    except Exception as e:
        logger.debug("Langfuse end failed: %s", e)
