# Plaid Haiku Budget Suggester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `sync_transactions` pulls new pending transactions from Plaid, call Claude Haiku 4.5 once per batch to suggest a `budget_id` for each transaction, then write that suggestion back to Firestore so the Approve modal pre-fills it.

**Architecture:** A new `suggest_budgets_for_batch()` helper (in `backend/app/services/budget_suggester.py`) builds a single Haiku call with all new pending transactions + the family's budgets, parses the JSON response, validates budget IDs against the real list, and returns a `{transaction_id: budget_id}` map. `sync_transactions` in `plaid_service.py` collects Firestore doc IDs for newly-written rows, calls the helper, then batch-updates `suggested_budget_id` on each doc. Both frontends already pre-fill `suggested_budget_id` in the Approve modal - no frontend changes needed.

**Tech Stack:** Python 3.12, FastAPI, anthropic SDK (sync `anthropic.Anthropic`), Firestore, Langfuse (optional instrumentation), pytest, React + TypeScript (frontend), Expo React Native (mobile).

---

## File map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `backend/app/services/budget_suggester.py` | `suggest_budgets_for_batch()` - all Haiku + Langfuse logic |
| Modify | `backend/app/services/plaid_service.py` | Wire suggester into `sync_transactions` after writing pending rows |
| Create | `backend/tests/test_budget_suggester.py` | Unit tests for `suggest_budgets_for_batch` |
| Modify | `backend/tests/test_plaid.py` | Integration test: `sync_transactions` writes `suggested_budget_id` |

Frontend: No changes needed - both `frontend/src/pages/Transactions.tsx` and `mobile/app/(tabs)/expenses.tsx` already read `tx.suggested_budget_id` and pre-fill the Approve modal.

---

## Task 1: Create `budget_suggester.py` with the core helper

**Files:**
- Create: `backend/app/services/budget_suggester.py`

- [ ] **Step 1.1: Create the file**

```python
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
```

- [ ] **Step 1.2: Verify the file parses without import errors**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/backend && source .venv/bin/activate && python -c "from app.services.budget_suggester import suggest_budgets_for_batch; print('OK')"
```

Expected: `OK`

- [ ] **Step 1.3: Commit**

```bash
git add backend/app/services/budget_suggester.py
git commit -m "feat: add budget_suggester.py — Haiku-powered batch budget suggestion"
```

---

## Task 2: Write the unit tests for `budget_suggester.py`

**Files:**
- Create: `backend/tests/test_budget_suggester.py`

- [ ] **Step 2.1: Write the failing tests first**

```python
"""Unit tests for app.services.budget_suggester.

All tests mock anthropic.Anthropic so no real API key or network is needed.
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Ensure test env vars are set before any app imports
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("GCP_PROJECT_ID", "test-project")
os.environ.setdefault("FIRESTORE_DATABASE", "test-database")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")


def _make_budget(id: str, name: str, category: str | None = "dining"):
    """Build a minimal BudgetResponse-like object."""
    b = SimpleNamespace()
    b.id = id
    b.name = name
    b.category = category
    b.beneficiary = None
    b.amount = 200.0
    b.period = "monthly"
    return b


def _make_txn(id: str, merchant: str = "Starbucks", amount: float = 6.42):
    return {
        "id": id,
        "merchant_name": merchant,
        "name": merchant.upper(),
        "amount": amount,
        "plaid_category": {"primary": "FOOD_AND_DRINK"},
        "account_type": "credit",
        "account_name": "Chase Sapphire",
        "date": "2026-06-10",
    }


def _make_haiku_response(suggestions: list[dict]) -> MagicMock:
    """Build a mock anthropic response with the given suggestions payload."""
    content_block = MagicMock()
    content_block.text = json.dumps({"suggestions": suggestions})
    usage = MagicMock()
    usage.input_tokens = 100
    usage.output_tokens = 50
    resp = MagicMock()
    resp.content = [content_block]
    resp.usage = usage
    return resp


# ---------------------------------------------------------------------------
# 1. Empty inputs
# ---------------------------------------------------------------------------


class TestEmptyInputs:
    def test_no_transactions_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        budgets = [_make_budget("b1", "Dining")]
        result = suggest_budgets_for_batch([], budgets)
        assert result == {}

    def test_no_budgets_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        txns = [_make_txn("t1")]
        result = suggest_budgets_for_batch(txns, [])
        assert result == {}

    def test_both_empty_returns_empty(self):
        from app.services.budget_suggester import suggest_budgets_for_batch
        result = suggest_budgets_for_batch([], [])
        assert result == {}


# ---------------------------------------------------------------------------
# 2. Missing API key
# ---------------------------------------------------------------------------


class TestMissingApiKey:
    def test_skips_when_no_api_key(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        from app.services.budget_suggester import suggest_budgets_for_batch
        txns = [_make_txn("t1")]
        budgets = [_make_budget("b1", "Dining")]
        with patch("anthropic.Anthropic") as mock_cls:
            result = suggest_budgets_for_batch(txns, budgets)
        mock_cls.assert_not_called()
        assert result == {}


# ---------------------------------------------------------------------------
# 3. Happy path — parses JSON and returns expected dict
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_parses_json_response_correctly(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001"), _make_txn("txn-002", "Whole Foods", 52.0)]
        budgets = [
            _make_budget("bud-dining", "Eating Out", "dining"),
            _make_budget("bud-grocery", "Groceries", "groceries"),
        ]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-001", "budget_id": "bud-dining", "reason": "Starbucks matches dining"},
            {"transaction_id": "txn-002", "budget_id": "bud-grocery", "reason": "Whole Foods matches groceries"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-001"] == "bud-dining"
        assert result["txn-002"] == "bud-grocery"

    def test_null_budget_id_in_response_preserved(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-income", "Payroll", -3000.0)]
        budgets = [_make_budget("b1", "Dining")]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-income", "budget_id": None, "reason": "Income — no budget"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-income"] is None


# ---------------------------------------------------------------------------
# 4. Hallucinated budget_id dropped
# ---------------------------------------------------------------------------


class TestHallucinatedId:
    def test_drops_hallucinated_budget_id(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("bud-real", "Real Budget")]

        mock_resp = _make_haiku_response([
            {"transaction_id": "txn-001", "budget_id": "bud-fake-hallucinated", "reason": "Wrong id"},
        ])

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        # The hallucinated id should be replaced with None, not kept.
        assert result["txn-001"] is None


# ---------------------------------------------------------------------------
# 5. API failure → returns {}
# ---------------------------------------------------------------------------


class TestApiFailure:
    def test_handles_api_error_gracefully(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("b1", "Dining")]

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.side_effect = RuntimeError("API down")
            result = suggest_budgets_for_batch(txns, budgets)

        assert result == {}

    def test_handles_malformed_json_gracefully(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("b1", "Dining")]

        bad_content = MagicMock()
        bad_content.text = "not json at all { broken"
        mock_resp = MagicMock()
        mock_resp.content = [bad_content]
        mock_resp.usage = MagicMock(input_tokens=0, output_tokens=0)

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result == {}

    def test_handles_json_fences(self, monkeypatch):
        """Haiku sometimes wraps response in ```json fences - strip them."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        from app.services.budget_suggester import suggest_budgets_for_batch

        txns = [_make_txn("txn-001")]
        budgets = [_make_budget("bud-dining", "Dining")]

        content_block = MagicMock()
        content_block.text = '```json\n{"suggestions": [{"transaction_id": "txn-001", "budget_id": "bud-dining", "reason": "match"}]}\n```'
        mock_resp = MagicMock()
        mock_resp.content = [content_block]
        mock_resp.usage = MagicMock(input_tokens=10, output_tokens=20)

        with patch("anthropic.Anthropic") as mock_cls:
            mock_cls.return_value.messages.create.return_value = mock_resp
            result = suggest_budgets_for_batch(txns, budgets)

        assert result["txn-001"] == "bud-dining"
```

- [ ] **Step 2.2: Run the tests — confirm they FAIL (module doesn't exist yet if running before Task 1, or confirm they pass if after)**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/backend && source .venv/bin/activate && pytest tests/test_budget_suggester.py -v 2>&1 | head -60
```

Expected output after Task 1 is complete: all tests PASS.

- [ ] **Step 2.3: Commit**

```bash
git add backend/tests/test_budget_suggester.py
git commit -m "test: add unit tests for budget_suggester suggest_budgets_for_batch"
```

---

## Task 3: Wire `suggest_budgets_for_batch` into `sync_transactions`

**Files:**
- Modify: `backend/app/services/plaid_service.py` — `sync_transactions` function (lines ~605-688)

The key insight: `sync_transactions` is a **sync** function. `BudgetService.list` is `async`. We must call it via `asyncio.run()` (safe since we're not already in an event loop here — this is called from a webhook path, not a FastAPI async route).

- [ ] **Step 3.1: Locate the insertion point**

The section after the main while loop ends (after the `removed` block, before `update_item_cursor`) is where we add the suggestion logic. Specifically, after the `while has_more and iterations < _SYNC_LOOP_CAP:` loop finishes but BEFORE `update_item_cursor(...)`.

We also need to collect newly-written doc IDs during the `added` loop. Add a list `new_doc_refs: list[tuple[str, dict]]` that accumulates `(firestore_doc_id, txn_doc)` for each freshly written row.

- [ ] **Step 3.2: Modify the `added` loop to collect new doc refs**

Find this block in `sync_transactions` (around line 626-639):

```python
        # --- Process added ---
        for txn in added_txns:
            txn_id = _plaid_txn_id(txn)
            if not txn_id:
                continue
            acct_id = _get_attr(txn, "account_id") or ""
            acct_name = account_map.get(acct_id, "")
            doc = _txn_to_doc(txn, family_id, connected_by_user_id, plaid_item_id, acct_name, institution_name)
            # Dedupe by plaid_transaction_id: check if a doc already exists.
            existing = _find_pending_by_plaid_txn_id(db, family_id, txn_id)
            if existing:
                # Already in our system — skip to avoid duplicates.
                continue
            db.collection(PLAID_PENDING_COLLECTION).document().set(doc)
            added_count += 1
```

Replace with:

```python
        # --- Process added ---
        for txn in added_txns:
            txn_id = _plaid_txn_id(txn)
            if not txn_id:
                continue
            acct_id = _get_attr(txn, "account_id") or ""
            acct_name = account_map.get(acct_id, "")
            doc = _txn_to_doc(txn, family_id, connected_by_user_id, plaid_item_id, acct_name, institution_name)
            # Dedupe by plaid_transaction_id: check if a doc already exists.
            existing = _find_pending_by_plaid_txn_id(db, family_id, txn_id)
            if existing:
                # Already in our system — skip to avoid duplicates.
                continue
            new_ref = db.collection(PLAID_PENDING_COLLECTION).document()
            new_ref.set(doc)
            new_pending_rows.append({"firestore_id": new_ref.id, "txn_doc": doc})
            added_count += 1
```

Also, initialise `new_pending_rows` before the while loop:

```python
    new_pending_rows: list[dict] = []  # {firestore_id, txn_doc} for budget suggestion
```

- [ ] **Step 3.3: Add budget suggestion block after the while loop**

After the while loop ends (before `update_item_cursor(plaid_item_id, cursor, _now())`), add:

```python
    # --- Budget suggestion (best-effort, never blocks sync) ---
    try:
        import asyncio
        from app.services.budget_service import BudgetService
        from app.services.budget_suggester import suggest_budgets_for_batch

        if new_pending_rows and family_id:
            budgets = asyncio.run(BudgetService().list(family_id))
            if budgets:
                # Build transaction dicts from stored docs
                txn_dicts = []
                for row in new_pending_rows:
                    d = row["txn_doc"]
                    txn_dicts.append({
                        "id": row["firestore_id"],
                        "merchant_name": d.get("merchant_name"),
                        "name": d.get("name"),
                        "amount": d.get("amount", 0),
                        "plaid_category": d.get("plaid_category"),
                        "account_type": "",  # not stored in pending doc; not needed
                        "account_name": d.get("account_name", ""),
                        "date": d.get("date", ""),
                    })
                suggestions = suggest_budgets_for_batch(txn_dicts, budgets)
                if suggestions:
                    batch = db.batch()
                    n_updated = 0
                    for row in new_pending_rows:
                        fs_id = row["firestore_id"]
                        if fs_id in suggestions and suggestions[fs_id] is not None:
                            ref = db.collection(PLAID_PENDING_COLLECTION).document(fs_id)
                            batch.update(ref, {"suggested_budget_id": suggestions[fs_id]})
                            n_updated += 1
                    if n_updated:
                        batch.commit()
                        logger.info(
                            "sync_transactions: wrote suggested_budget_id for %d/%d rows (item=%s)",
                            n_updated, len(new_pending_rows), plaid_item_id,
                        )
    except Exception as suggest_exc:
        logger.warning(
            "sync_transactions: budget suggestion failed (non-fatal) — %s", suggest_exc
        )
```

- [ ] **Step 3.4: Verify the import does not break the module**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/backend && source .venv/bin/activate && python -c "from app.services.plaid_service import sync_transactions; print('OK')"
```

Expected: `OK`

- [ ] **Step 3.5: Commit**

```bash
git add backend/app/services/plaid_service.py
git commit -m "feat: wire Haiku budget suggestion into sync_transactions"
```

---

## Task 4: Add integration test for `sync_transactions` writing `suggested_budget_id`

**Files:**
- Modify: `backend/tests/test_plaid.py` — add `TestSyncTransactionsBudgetSuggestion` class at the end

- [ ] **Step 4.1: Read the existing test_plaid.py to find the sync_transactions test class**

```bash
grep -n "class TestSync\|sync_transactions\|def test_sync" /Users/dhishan/Projects/family-expense-tracker/backend/tests/test_plaid.py | head -30
```

- [ ] **Step 4.2: Append the new test class**

Add to the end of `backend/tests/test_plaid.py`:

```python
# ---------------------------------------------------------------------------
# TestSyncTransactionsBudgetSuggestion
# ---------------------------------------------------------------------------


class TestSyncTransactionsBudgetSuggestion:
    """Integration test: sync_transactions writes suggested_budget_id when
    suggest_budgets_for_batch returns a non-empty result."""

    def _make_plaid_txn(self, txn_id: str) -> MagicMock:
        txn = MagicMock()
        txn.transaction_id = txn_id
        txn.account_id = "acct-001"
        txn.merchant_name = "Starbucks"
        txn.name = "STARBUCKS 1234"
        txn.amount = 6.42
        txn.iso_currency_code = "USD"
        txn.date = "2026-06-10"
        txn.authorized_date = "2026-06-10"
        txn.pending = False
        pfc = MagicMock()
        pfc.to_dict.return_value = {"primary": "FOOD_AND_DRINK"}
        pfc.primary = "FOOD_AND_DRINK"
        txn.personal_finance_category = pfc
        return txn

    def test_writes_suggested_budget_id_on_added_txns(self):
        """sync_transactions should batch-update suggested_budget_id after adding rows."""
        from unittest.mock import MagicMock, patch, call
        from types import SimpleNamespace
        import json

        ITEM_ID = "item-suggest-001"
        FAMILY_ID = "fam-suggest"
        BUDGET_ID = "bud-dining-001"

        # --- Firestore mock ---
        db = MagicMock()

        # Item doc
        item_data = {
            "family_id": FAMILY_ID,
            "connected_by_user_id": "user-1",
            "plaid_access_token": "access-sandbox",
            "plaid_item_id": ITEM_ID,
            "institution_name": "Chase",
            "cursor": None,
            "status": "active",
        }
        item_snap = MagicMock()
        item_snap.exists = True
        item_snap.to_dict.return_value = item_data

        # Account doc
        acct_snap = MagicMock()
        acct_snap.id = "acct-001"
        acct_snap.to_dict.return_value = {
            "account_id": "acct-001",
            "name": "Checking",
            "plaid_item_id": ITEM_ID,
        }

        # Pending transaction: does not exist yet (no dedupe hit)
        no_existing = MagicMock()
        no_existing.__iter__ = MagicMock(return_value=iter([]))

        # Firestore new doc reference
        new_doc_ref = MagicMock()
        new_doc_ref.id = "pending-doc-abc"

        # Batch for budget suggestion write-back
        batch_mock = MagicMock()

        def collection_side_effect(name):
            coll = MagicMock()
            if name == "plaid_items":
                coll.document.return_value.get.return_value = item_snap
            elif name == "plaid_accounts":
                coll.where.return_value.stream.return_value = iter([acct_snap])
            elif name == "plaid_pending_transactions":
                coll.where.return_value.where.return_value.limit.return_value.stream.return_value = iter([])
                coll.document.return_value = new_doc_ref
            return coll

        db.collection.side_effect = collection_side_effect
        db.batch.return_value = batch_mock

        # --- Plaid client mock ---
        plaid_txn = self._make_plaid_txn("plaid-txn-123")
        resp_body = {
            "added": [plaid_txn],
            "modified": [],
            "removed": [],
            "next_cursor": "cursor-v2",
            "has_more": False,
        }
        resp = MagicMock()
        resp.to_dict.return_value = resp_body

        # --- Budget mock (BudgetService.list) ---
        budget = SimpleNamespace(
            id=BUDGET_ID,
            name="Eating Out",
            category="dining",
            beneficiary=None,
            amount=200.0,
            period="monthly",
        )

        # --- suggest_budgets_for_batch mock ---
        # Returns a suggestion for the Firestore doc ID
        suggestion_result = {"pending-doc-abc": BUDGET_ID}

        with patch("app.services.plaid_service.get_firestore_client", return_value=db), \
             patch("app.services.plaid_service._client") as mock_plaid_client, \
             patch("app.services.plaid_service.update_item_cursor"), \
             patch("app.services.budget_service.BudgetService.list", new=AsyncMock(return_value=[budget])), \
             patch("app.services.budget_suggester.suggest_budgets_for_batch", return_value=suggestion_result):

            mock_plaid_client.return_value.transactions_sync.return_value = resp
            from app.services.plaid_service import sync_transactions
            result = sync_transactions(ITEM_ID)

        assert result["added"] == 1
        # Verify batch.update was called with the suggested budget_id
        batch_mock.update.assert_called_once()
        update_call_args = batch_mock.update.call_args
        assert update_call_args[0][1] == {"suggested_budget_id": BUDGET_ID}
        batch_mock.commit.assert_called()
```

- [ ] **Step 4.3: Run all plaid + budget_suggester tests**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/backend && source .venv/bin/activate && pytest tests/test_budget_suggester.py tests/test_plaid.py -v 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add backend/tests/test_plaid.py
git commit -m "test: integration test — sync_transactions writes suggested_budget_id"
```

---

## Task 5: Run the full backend test suite and verify TypeScript compiles

**Files:** None modified — verification only.

- [ ] **Step 5.1: Run full backend tests**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/backend && source .venv/bin/activate && pytest tests/test_plaid.py tests/test_plaid_service.py tests/test_budgets.py tests/test_budget_suggester.py -v 2>&1 | tail -40
```

Expected: All PASSED, 0 failures.

- [ ] **Step 5.2: TypeScript check — frontend**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 5.3: Build check — frontend**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/frontend && npm run build 2>&1 | tail -10
```

Expected: Build succeeds.

- [ ] **Step 5.4: TypeScript check — mobile**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/mobile && npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 5.5: Commit if any fixups were needed**

If the above steps required any fixups, commit them now:

```bash
git add -p
git commit -m "fix: resolve TypeScript or test issues from budget suggestion wiring"
```

---

## Task 6: Push to main and deploy

**Files:** None modified.

- [ ] **Step 6.1: Push to main**

```bash
git push origin main
```

- [ ] **Step 6.2: Watch CI**

```bash
gh run list --limit 5
# Get the run ID from the most recent run, then:
gh run watch <RUN_ID> --exit-status
```

Expected: CI passes.

- [ ] **Step 6.3: Fire mobile OTA update**

```bash
cd /Users/dhishan/Projects/family-expense-tracker/mobile && npx eas update --branch preview --message "approve modal: pre-fill budget from Haiku suggestion"
```

Note the OTA group ID printed in the output.

- [ ] **Step 6.4: Smoke test (manual)**

After CI deploys:
1. Open the app or visit the deployed frontend.
2. Trigger a Plaid sandbox sync (via the webhook or the "Sync now" button if it exists).
3. Check Firestore `plaid_pending_transactions` — at least one doc should have a non-null `suggested_budget_id`.
4. Open the Approve modal for that transaction — the budget chip should be pre-selected.

If you cannot run this manually, note it in the report.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task covering it |
|-----------------|-----------------|
| `suggest_budgets_for_batch` helper | Task 1 |
| Single Haiku call per batch | Task 1 (`_call_haiku` builds one request) |
| Best-effort: missing API key → skip | Task 1 + Task 2 test 2 |
| Best-effort: malformed JSON → skip | Task 1 + Task 2 test 5 |
| Best-effort: API failure → skip | Task 1 + Task 2 test 5 |
| timeout=20 on Anthropic call | Task 1 (`timeout=20` param) |
| Hallucinated budget_id dropped | Task 1 + Task 2 test 4 |
| Wire into `sync_transactions` | Task 3 |
| Collect newly-added doc IDs | Task 3 step 3.2 |
| Fetch budgets via `BudgetService.list` | Task 3 step 3.3 |
| Batch-update `suggested_budget_id` | Task 3 step 3.3 |
| Never fail sync | Task 3 step 3.3 (outer try/except) |
| Langfuse span | Task 1 (`_call_haiku` - lf_gen) |
| 6 unit tests | Task 2 (covers all 5 cases + JSON fence stripping) |
| Integration test | Task 4 |
| Frontend prefill (web) | Already implemented at line 338 of Transactions.tsx - NO CHANGE NEEDED |
| Frontend prefill (mobile) | Already implemented at line 155 of expenses.tsx - NO CHANGE NEEDED |
| `model: claude-haiku-4-5` | Task 1 |
| `max_tokens: 1500`, `temperature: 0` | Task 1 |
| System prompt structure | Task 1 (`_SYSTEM_PROMPT`) |
| User prompt structure | Task 1 (`_build_user_prompt`) |

**Placeholder scan:** No TBDs, all code blocks are complete.

**Type consistency:**
- `suggest_budgets_for_batch` signature uses `list[Any]` for budgets (to avoid circular import) and accesses `.id`, `.name`, `.category`, `.beneficiary`, `.amount`, `.period` — all present on `BudgetResponse`.
- `new_pending_rows` is `list[dict]` with keys `firestore_id` and `txn_doc` — used consistently in Task 3.
- The integration test correctly patches `app.services.budget_suggester.suggest_budgets_for_batch` (not the module-level import inside plaid_service) — this is the correct patch target since plaid_service imports it at call time inside the try block.

**Note on `asyncio.run` in `sync_transactions`:** `sync_transactions` is a sync function called from a FastAPI route handler or webhook. If it's called inside an already-running event loop (e.g., if FastAPI runs the route in a threadpool that has its own loop), `asyncio.run()` will raise. The safer pattern is to use `BudgetService` synchronously or to wrap in `asyncio.new_event_loop()`. An alternative: make `BudgetService.list` callable synchronously by factoring out the Firestore query. The plan above uses `asyncio.run()` which works when called from a plain sync context. If CI shows `RuntimeError: This event loop is already running`, the fix is:

```python
import asyncio, concurrent.futures
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
    budgets = ex.submit(asyncio.run, BudgetService().list(family_id)).result()
```

Add this fix in Task 3 step 3.3 if the initial version fails.
