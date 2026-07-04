# Code and Security Review - 2026-07-03

Full-repo review: backend quality, security (delta against docs/security-review-2026-06-15.md), web + mobile clients, and CLAUDE.md accuracy. Four parallel reviewers, findings verified against code with file:line references.

## Priority 0 - fix immediately

### 1. [Critical] `_test/reset` and `_test/sandbox-connect` are live in production
`backend/app/routers/plaid.py:1222,1228,1375` + `terraform/main/variables.tf:13-17`

`_assert_non_prod()` only blocks when environment is `production` or `prod`. Terraform deploys with `ENVIRONMENT=dev` (the variable default), so the guard never fires. Any authenticated family member can call `POST /api/v1/plaid/_test/reset` and permanently wipe every Plaid item, account, and pending transaction for their family. Pure Firestore deletes, no confirmation, no audit entry.

Fix: invert the guard to fail closed - allow test endpoints only when environment is explicitly in `("sandbox", "test", "e2e", "development")`. Unrecognized strings (including `dev`) must block.

### 2. [High] `.env.test` holds a live Google refresh token and is not gitignored
Repo root. Contains `GOOGLE_TEST_REFRESH_TOKEN=1//06...` (real token). `.gitignore` covered `.env`, `.env.local`, `.env.*.local` but not `.env.test`. One `git add .` away from leaking a credential that converts to a backend JWT with full data access.

Status: `.gitignore` now covers `.env.test` (fixed in this review). Remaining action: **revoke the refresh token** and re-issue; treat it as compromised. Move E2E creds to CI-injected secrets only.

### 3. [High] Plaid webhook notification handlers are broken in production
`backend/app/routers/plaid.py:729,765`

`_handle_item_login_required` and `_handle_pending_expiration` call `asyncio.get_event_loop().run_until_complete(...)` from inside the running uvicorn loop. That raises `RuntimeError` every time and the bare `except` logs it as a warning. Net effect: ITEM_LOGIN_REQUIRED and PENDING_EXPIRATION never write the "reconnect your bank" notification. Fix: make both handlers async and await them (they are near-identical - collapse into one `_handle_item_auth_event`).

## Priority 1 - high value

### 4. [High, still open since June 15] Prompt injection via raw tool output
`backend/app/routers/chat.py` tool executors. Merchant names, account labels, news headlines, filings flow into `tool_result` blocks with no untrusted-data envelope and no system-prompt instruction to treat them as data. Fix: wrap tool payloads in a data envelope and add one system-prompt line declaring envelope contents non-instructional.

### 5. [High] Blocking Plaid SDK + sync HTTP calls stall the event loop
`plaid.py` (12+ call sites), `chat.py:2664-2675` tool executors, `_get_family_id` sync Firestore RPC from async. The background `_bg_sync` coroutines run fully synchronous `sync_transactions()` on the loop - a slow Plaid sync freezes every in-flight SSE chat stream. Fix: `asyncio.to_thread(...)` around every sync call.

### 6. [High] Chat turn events can exceed Firestore's 1MB doc limit
`services/chat_store.py:49` defines `MAX_EVENTS = 800` but `append_event` never enforces it - unconditional ArrayUnion. Long tool-heavy turns will start failing writes silently. Fix: enforce the cap or move events to a subcollection.

### 7. [Medium] `email_verified` unchecked in the regular login path
`backend/app/auth/google.py:25-41`. The MCP auth path checks `email_verified`; `/auth/google` does not. Mirror the MCP guard.

### 8. [Medium] Token usage double-counted on multi-tool turns
`chat.py:2614-2633` (per loop iteration) plus `chat.py:2744-2758` (per turn). Cost reporting inflated for any turn with tool calls. Record once after the loop.

### 9. [High, web] Plaid Link opened during render
`frontend/src/pages/Settings.tsx:175-176`. `if (linkToken && ready) openLink()` runs in the component body - re-render loops can open overlapping Plaid sessions. Move both calls into `useEffect`.

### 10. [Medium, mobile] Logout does not sign out of Google
`mobile/src/store/auth.ts:79-83`. `logout()` clears the JWT but never `GoogleSignin.signOut()`; next launch silently re-authenticates via `signInSilently()`. Logout is effectively a no-op on devices with a cached Google session.

## Priority 2 - correctness and hygiene

11. [Medium] CORS: `https://blueelephants.org` only added when environment == production, which never matches (see finding 1's env mismatch). Align the env string or add the origin unconditionally.
12. [Medium] Holdings fetch error renders as "no positions" - `Investments.tsx:351-356` does not destructure `error`; broken sync is indistinguishable from an empty portfolio.
13. [Medium] `MerchantRule` type drift: frontend `merchant_name` vs mobile `merchant`; mobile has `family_id`, frontend has `last_applied_at`. Align to the backend schema.
14. [Medium] Web has no `getActivities` in `investmentsApi` while backend exposes `GET /investments/activities`; `Investments.tsx:417` invalidates an orphaned `['investments','activities']` key nothing subscribes to.
15. [Medium] Silent failure swallows: `plaid.py:1202` budget alerts (`except: pass`, no log), `chat.py:2371` `finalize_turn` failure can leave turns in `streaming` forever (mobile polls the full 1800s), `chat.py:1604` stale balances with no signal.
16. [Medium] N+1 Firestore: `list_items` fetches accounts per item (`plaid.py:360-393`); budget dashboard issues 1+3N reads (`budget_service.py:421-494`). Batch by family and aggregate in memory, or use Firestore `sum()` aggregations.
17. [Low, still open] SnapTrade `custom_redirect` attacker-controlled (`investments.py:14-35`). Validate against an allowlist.
18. [Low] `approve_split` re-implements `_approve_pending` resolution logic in 4 blocks (`plaid.py:1052-1214`); extract shared helpers.
19. [Low] `__import__` inline hacks and ~9 redundant `datetime` reimports in `plaid.py`/`chat.py`; fire-and-forget title task not pinned in `_BG_TASKS` (`chat.py:2723`); AppState listener churn in mobile chat (`chat.tsx:636-650`); duplicated `ConnectModal` across Investments/Settings; dead `_showJoinModal` state.
20. [Low] Empty `pbcopy` file at repo root (deleted in this review; now gitignored).

## Test gaps (ranked)

1. Webhook success paths - `SYNC_UPDATES_AVAILABLE` dispatch and `ITEM_LOGIN_REQUIRED` transition have zero coverage; this is exactly why finding 3 shipped broken.
2. `chat_store.py` has no tests at all - the durable-streaming core (append_event, finalize_turn, resume-from-seq) is unverified.
3. Plaid pending-to-posted predecessor linking and auto-rule application untested.

## June 15 review resolution

Fixed: JWT secret env var (Critical), usage IDOR, Google token audience binding, mobile deep-link validation. Partial: web JWT lifetime cut 7d to 24h but still in localStorage. Still open: prompt injection (finding 4), SnapTrade custom_redirect (finding 17).

## CLAUDE.md

Rewritten as part of this review. Was materially stale: wrong venv path (`venv` vs `.venv`), false `min_instances=1` claim (minScale is 0 since the overnight-scaledown change), 5-vs-6 tab mismatch, GPT-5.5 routing omitted, and zero documentation for Plaid, SnapTrade, the hosted MCP server, auto-rules, usage metering, CI/E2E design, Firestore index management, or observability.

## Actions taken in this review

- `.gitignore`: added `.env.test` and `pbcopy`
- Deleted the stray empty `pbcopy` file
- Rewrote `CLAUDE.md`

## Recommended next actions (in order)

1. Fix `_assert_non_prod` fail-closed (finding 1) and deploy
2. Revoke the exposed test refresh token (finding 2)
3. Fix the webhook handlers (finding 3) with a success-path test
4. `asyncio.to_thread` sweep (finding 5)
5. `useEffect` fix for Plaid Link (finding 9) and mobile Google sign-out (finding 10)
