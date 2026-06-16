"""Tiny end-to-end evaluation across the chat models.

Runs a fixed set of representative queries against each model option
(Smart / Opus / Sonnet / GPT) by invoking the underlying LLM calls
directly (no FastAPI / Firestore needed). For each (query, model) it
records latency, prompt+completion tokens, cost, and the final answer
text. The point is to know what we pay and roughly how good each model
is for our actual workload — not a research benchmark.

Run from backend/ with the venv active:

    .venv/bin/python scripts/eval_models.py

Outputs JSON + markdown summary into docs/chat-model-eval-YYYY-MM-DD.md
and prints a compact table.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import date
from pathlib import Path

# Load .env so OPENAI_API_KEY / ANTHROPIC_API_KEY are available.
ENV_PATH = Path(__file__).parent.parent / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)

import litellm

# Match the chat system prompt's scope + style guidance. Trimmed so the
# eval runs fast — the real prompt has 30 lines of cache + topic prompts
# we don't need for measuring response quality.
SYSTEM_PROMPT_EVAL = """You are a senior portfolio analyst and personal-finance assistant.
Scope: financial topics only — portfolios, expenses, budgets, markets, macro, banks, options, prediction markets.
Style: BRIEF. Lead with the answer in the first sentence. 2-4 sentences typical.
Numeric formatting: dollar amounts full <$100K ($114,154) and K-rounded above ($750K); percentages one decimal (+12.0%); no `~` decoration; tickers caps no $.
"""

QUERIES = [
    "What's the Fed funds rate right now and what does it imply for tech stocks?",
    "I have $5,000 to invest this month and a $750K portfolio heavily long AI tech. Add to NVDA or rebalance?",
    "Explain the difference between a Roth and a Traditional IRA in one paragraph.",
    "What's implied vol on AAPL look like right now?",
    "If margin rate is 5.5% and my NVDA forward upside is 30%, should I lever up?",
    "What does Polymarket say about a Fed rate cut by year end?",
    "Summarize the latest 10-Q from Tesla in two sentences.",
    "What was my Costco spending last month?",
    "Write a Python script that scrapes Hacker News.",  # off-scope — expect redirect
    "Explain options gamma to a beginner.",
]

MODELS = [
    ("smart-sonnet", "claude-sonnet-4-6"),
    ("opus", "claude-opus-4-7"),
    ("gpt-4o", "gpt-4o"),
    ("gpt-4o-mini", "gpt-4o-mini"),
]


def run_one(model: str, q: str) -> dict:
    t0 = time.time()
    # Opus 4.7 rejects `temperature` (and other sampling params). Drop them
    # for that family; keep the default 1.0 the API uses internally.
    kwargs = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_EVAL},
            {"role": "user", "content": q},
        ],
        "max_tokens": 500,
    }
    if "opus-4-7" not in model:
        kwargs["temperature"] = 0.7
    try:
        resp = litellm.completion(**kwargs)
        ans = (resp.choices[0].message.content or "").strip()
        usage = resp.usage
        # Cost via litellm. Some Anthropic responses don't carry .input_tokens
        # in the usage; fall back to prompt_tokens/completion_tokens.
        prompt_t = getattr(usage, "prompt_tokens", 0) or 0
        comp_t = getattr(usage, "completion_tokens", 0) or 0
        try:
            in_cost, out_cost = litellm.cost_per_token(
                model=model,
                prompt_tokens=prompt_t,
                completion_tokens=comp_t,
            )
            cost = float(in_cost + out_cost)
        except Exception:
            cost = 0.0
        return {
            "ok": True,
            "latency_s": round(time.time() - t0, 2),
            "prompt_tokens": prompt_t,
            "completion_tokens": comp_t,
            "cost_usd": round(cost, 6),
            "answer": ans,
        }
    except Exception as e:
        return {
            "ok": False,
            "latency_s": round(time.time() - t0, 2),
            "error": str(e)[:200],
            "answer": "",
        }


def main() -> int:
    out_path = (
        Path(__file__).parent.parent.parent
        / "docs"
        / f"chat-model-eval-{date.today().isoformat()}.md"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    results: dict[str, list[dict]] = {label: [] for label, _ in MODELS}
    for q_idx, q in enumerate(QUERIES, 1):
        print(f"\n[{q_idx}/{len(QUERIES)}] {q[:80]}")
        for label, model in MODELS:
            r = run_one(model, q)
            r["query"] = q
            results[label].append(r)
            tag = "✓" if r["ok"] else "✗"
            print(
                f"  {tag} {label:<14} {r['latency_s']:5.2f}s "
                f"in={r.get('prompt_tokens',0)} out={r.get('completion_tokens',0)} "
                f"${r.get('cost_usd', 0):.4f}"
            )

    # Aggregate
    summary_rows = []
    for label, _model in MODELS:
        rs = results[label]
        ok = [r for r in rs if r.get("ok")]
        summary_rows.append(
            {
                "model": label,
                "n_ok": len(ok),
                "n_total": len(rs),
                "avg_latency_s": round(sum(r["latency_s"] for r in ok) / max(len(ok), 1), 2),
                "total_cost_usd": round(sum(r.get("cost_usd", 0) for r in ok), 4),
                "avg_cost_per_query_usd": round(
                    sum(r.get("cost_usd", 0) for r in ok) / max(len(ok), 1), 4
                ),
            }
        )

    # Write markdown
    md = [f"# Chat model evaluation — {date.today().isoformat()}", ""]
    md.append(f"**{len(QUERIES)} queries** across **{len(MODELS)} models**.")
    md.append("")
    md.append("## Summary")
    md.append("")
    md.append("| Model | Pass | Avg latency | Total cost | Cost / query |")
    md.append("|---|---:|---:|---:|---:|")
    for s in summary_rows:
        md.append(
            f"| {s['model']} | {s['n_ok']}/{s['n_total']} | "
            f"{s['avg_latency_s']}s | ${s['total_cost_usd']} | "
            f"${s['avg_cost_per_query_usd']} |"
        )
    md.append("")
    md.append("## Per-query answers")
    for i, q in enumerate(QUERIES):
        md.append(f"\n### Q{i+1}. {q}")
        for label, _m in MODELS:
            r = results[label][i]
            md.append(f"\n**{label}** — {r['latency_s']}s, ${r.get('cost_usd',0):.4f}")
            if not r["ok"]:
                md.append(f"> ERROR: {r.get('error', 'unknown')}")
            else:
                md.append("\n```")
                md.append(r["answer"])
                md.append("```")

    out_path.write_text("\n".join(md))
    print(f"\nWrote {out_path}")

    # Also dump raw JSON
    json_path = out_path.with_suffix(".json")
    json_path.write_text(json.dumps({"results": results, "summary": summary_rows}, indent=2))
    print(f"Wrote {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
