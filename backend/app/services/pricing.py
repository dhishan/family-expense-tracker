"""LiteLLM-based token cost computation.

Import-only usage of LiteLLM — the hot path continues to use AsyncAnthropic
directly. This module is a thin wrapper for cost lookups only.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def compute_cost(model: str, usage: Any) -> float:
    """Cost in USD for one Anthropic stream's usage block.

    Works for any provider supported by LiteLLM's price table.
    Unknown model returns 0.0 (logged) so writes never explode.

    Args:
        model: LiteLLM-compatible model string, e.g. "claude-sonnet-4-6"
        usage: Any object with input_tokens / output_tokens attributes
               (Anthropic SDK Usage, or a plain dict-like with those keys),
               or a plain dict with those keys.
    """
    try:
        import litellm  # type: ignore

        input_tokens = getattr(usage, "input_tokens", None)
        if input_tokens is None and isinstance(usage, dict):
            input_tokens = usage.get("input_tokens", 0)
        input_tokens = input_tokens or 0

        output_tokens = getattr(usage, "output_tokens", None)
        if output_tokens is None and isinstance(usage, dict):
            output_tokens = usage.get("output_tokens", 0)
        output_tokens = output_tokens or 0

        cache_read = getattr(usage, "cache_read_input_tokens", None)
        if cache_read is None and isinstance(usage, dict):
            cache_read = usage.get("cache_read_input_tokens", 0)
        cache_read = cache_read or 0

        cache_creation = getattr(usage, "cache_creation_input_tokens", None)
        if cache_creation is None and isinstance(usage, dict):
            cache_creation = usage.get("cache_creation_input_tokens", 0)
        cache_creation = cache_creation or 0

        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model,
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            cache_read_input_tokens=cache_read,
            cache_creation_input_tokens=cache_creation,
        )
        return float(prompt_cost + completion_cost)
    except Exception:
        logger.warning("LiteLLM cost lookup failed for model=%s", model)
        return 0.0
