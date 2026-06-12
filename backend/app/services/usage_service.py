"""Persist LLM usage events to Firestore.

Collections:
  usage_events/                   — detail log, one doc per LLM call
  user_usage_summaries/{uid}/months/{YYYY-MM}  — atomic monthly counters
  chat_conversations/{conv_id}    — cost_usd / token_total incremented per turn

All Firestore writes are wrapped in try/except so they can never break the
primary chat or budget-suggestion flow.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.services import pricing

logger = logging.getLogger(__name__)


def _db():
    """Lazy import to avoid circular imports and ease testing."""
    from app.services.firestore import get_firestore_client
    return get_firestore_client()


def record_usage(
    *,
    user_id: str,
    family_id: str | None,
    source: str,
    model: str,
    conversation_id: str | None,
    turn_id: str | None,
    usage: Any,
    duration_ms: int,
) -> float:
    """Persist a single LLM-call usage event.

    Returns cost_usd (0.0 on any error).
    Wraps all Firestore writes in try/except individually so a partial failure
    doesn't lose the cost return value.
    """
    cost = pricing.compute_cost(model, usage)

    input_tokens = getattr(usage, "input_tokens", None)
    if input_tokens is None and isinstance(usage, dict):
        input_tokens = usage.get("input_tokens", 0)
    input_tokens = int(input_tokens or 0)

    output_tokens = getattr(usage, "output_tokens", None)
    if output_tokens is None and isinstance(usage, dict):
        output_tokens = usage.get("output_tokens", 0)
    output_tokens = int(output_tokens or 0)

    cache_read = getattr(usage, "cache_read_input_tokens", None)
    if cache_read is None and isinstance(usage, dict):
        cache_read = usage.get("cache_read_input_tokens", 0)
    cache_read = int(cache_read or 0)

    cache_creation = getattr(usage, "cache_creation_input_tokens", None)
    if cache_creation is None and isinstance(usage, dict):
        cache_creation = usage.get("cache_creation_input_tokens", 0)
    cache_creation = int(cache_creation or 0)

    now = datetime.now(tz=timezone.utc)
    month_key = now.strftime("%Y-%m")

    # 1. Detail event
    try:
        db = _db()
        db.collection("usage_events").add({
            "user_id": user_id,
            "family_id": family_id,
            "source": source,
            "model": model,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read,
            "cache_creation_tokens": cache_creation,
            "cost_usd": cost,
            "duration_ms": duration_ms,
            "created_at": now,
        })
    except Exception as e:
        logger.warning("usage_service: detail event write failed: %s", e)

    # 2. Monthly summary (atomic increments)
    try:
        from google.cloud.firestore import Increment  # type: ignore
        db = _db()
        summary_ref = (
            db.collection("user_usage_summaries")
            .document(user_id)
            .collection("months")
            .document(month_key)
        )
        summary_ref.set(
            {
                "user_id": user_id,
                "month": month_key,
                "total_input_tokens": Increment(input_tokens),
                "total_output_tokens": Increment(output_tokens),
                "total_cost_usd": Increment(cost),
                f"by_model.{model}.tokens": Increment(input_tokens + output_tokens),
                f"by_model.{model}.cost": Increment(cost),
                f"by_source.{source}.tokens": Increment(input_tokens + output_tokens),
                f"by_source.{source}.cost": Increment(cost),
                "updated_at": now,
            },
            merge=True,
        )
    except Exception as e:
        logger.warning("usage_service: monthly summary write failed: %s", e)

    # 3. Increment conversation doc cost (if we have a conversation_id)
    if conversation_id:
        try:
            from google.cloud.firestore import Increment  # type: ignore
            db = _db()
            db.collection("chat_conversations").document(conversation_id).set(
                {
                    "cost_usd": Increment(cost),
                    "token_total": Increment(input_tokens + output_tokens),
                },
                merge=True,
            )
        except Exception as e:
            logger.warning("usage_service: conversation cost increment failed: %s", e)

    return cost


def get_monthly_cost(user_id: str) -> float:
    """Return total_cost_usd from the current month's summary. 0.0 if none."""
    from datetime import datetime, timezone
    month_key = datetime.now(tz=timezone.utc).strftime("%Y-%m")
    try:
        db = _db()
        doc = (
            db.collection("user_usage_summaries")
            .document(user_id)
            .collection("months")
            .document(month_key)
            .get()
        )
        if doc.exists:
            return float(doc.to_dict().get("total_cost_usd", 0.0))
        return 0.0
    except Exception as e:
        logger.warning("usage_service: get_monthly_cost failed: %s", e)
        return 0.0


def get_conversation_cost(conversation_id: str) -> float:
    """Return cost_usd from a conversation doc. 0.0 if none."""
    try:
        db = _db()
        doc = db.collection("chat_conversations").document(conversation_id).get()
        if doc.exists:
            return float(doc.to_dict().get("cost_usd", 0.0))
        return 0.0
    except Exception as e:
        logger.warning("usage_service: get_conversation_cost failed: %s", e)
        return 0.0
