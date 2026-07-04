# Family Expense Tracker - Codebase Guide

## Structure

```
family-expense-tracker/
  backend/       FastAPI on Cloud Run (prod: api.expense-tracker.blueelephants.org)
  frontend/      React + Vite + TypeScript + Tailwind
                   (prod: ui.expense-tracker.blueelephants.org, Firebase Hosting)
  mobile/        Expo React Native app (shared FastAPI backend)
  terraform/     GCP infrastructure (project personal-projects-473219, us-central1)
  Makefile       All dev/deploy commands (run `make help`)
```

## Backend

- FastAPI, Python 3.12, Firestore (named database `family-expense-tracker-dev`), Cloud Run
- Auth: Google OAuth to Firebase ID token to backend JWT (24h lifetime).
  `effective_jwt_secret()` in config.py; main.py refuses to boot production
  with a missing/default/short JWT secret.
- Local dev: `cd backend && source .venv/bin/activate && uvicorn app.main:app --reload`
  (note: the venv directory is `.venv`, not `venv`)
- Prod URL: `https://api.expense-tracker.blueelephants.org`
- Cloud Run runs with `minScale=0` (scales down overnight to save cost) and
  `cpu-throttling=false`. Background asyncio work is kept alive during a chat
  turn by the client pinging `/health` every 30s while a turn is in flight,
  NOT by a warm instance. See annotations in `terraform/main/main.tf`.
- Deploys run with `ENVIRONMENT=dev` (Terraform variable default), not
  "production". Anything gated on `environment == "production"` will NOT fire
  in the deployed service. Keep this in mind for env-gated logic.
- Sentry: `sentry_sdk` initialized in main.py (DSN from Secret Manager).
  Plaid failures are captured to Sentry; routine activity goes to Cloud Logging.
- Langfuse traces every chat turn with child spans per tool call (LLM
  observability, separate from Sentry). Import path is `langfuse.langchain`.

### Chat architecture (`backend/app/routers/chat.py` + `backend/app/services/chat_store.py`)

- Durable, Firestore-backed conversations. Every chat is stored under
  `/chat_conversations/{conv_id}/turns/{turn_id}` with the user_id
  denormalized onto every doc for security (cross-user reads get 404, not 403).
- `POST /chat/start` creates conv + turn docs, spawns generation as
  `asyncio.create_task`, returns IDs immediately.
- Generation writes every text delta / tool_call / tool_result / status
  event into the turn doc's `events` array as it streams.
- `GET /chat/conversations/{c}/turns/{t}/stream?from_seq=N` is a resumable SSE
  that polls Firestore for events with seq > N. Mobile re-opens it on AppState
  foreground with the last seen seq. 10s SSE keepalives during idle polling.
- `POST /chat` is a backwards-compat shim for old mobile bundles.
- Model routing: user-selectable smart | opus | sonnet | gpt. "smart"
  auto-routes Sonnet 4.6 by default, Opus 4.7 on explicit deep-analysis
  keywords ("deep analysis", "rebalance", "stress test"). GPT-5.5 is both a
  selectable option and the fallback when Anthropic is unavailable.
- Chat tools span expenses, budgets, Plaid, SnapTrade, market data (Alpaca,
  Tradier, Finnhub, FRED, EDGAR), and prediction markets.
- Usage metering: `routers/usage.py` + `services/usage_service.py` +
  `services/pricing.py` track per-user, per-conversation token cost; the chat
  UI displays it.

### Plaid bank integration (`backend/app/routers/plaid.py` + `services/plaid_service.py`)

- Family-scoped bank connections: link-token create, public-token exchange,
  items CRUD, reconnect (update mode) + `reconnect-complete` (update mode has
  no exchange, so the frontend must call reconnect-complete on Link onSuccess
  to clear needs_reauth and trigger a sync), webhook receiver (JWT-signature
  verified, fail-closed), and a pending-transaction review queue
  (approve / approve-split / discard / save-uncategorized).
- Redirect URIs are hard-coded and whitelisted in the Plaid dashboard:
  web `https://ui.expense-tracker.blueelephants.org/plaid-oauth-return`,
  mobile relay `https://api.expense-tracker.blueelephants.org/api/v1/plaid/oauth`
  (302s to the `expenses://` deep link). Plaid rejects query strings in
  whitelisted redirect URIs, hence two entries.
- OAuth institutions (Chase, Robinhood) require `redirect_uri` on update-mode
  link tokens too, or the bank handoff fails.
- Webhooks drive sync: TRANSACTIONS/SYNC_UPDATES_AVAILABLE triggers
  `sync_transactions` (cursor-based); ITEM/ERROR ITEM_LOGIN_REQUIRED marks
  needs_reauth. The Plaid SDK client is synchronous.
- Merchant auto-rules (`routers/rules.py` + `services/rule_service.py`)
  auto-categorize imported transactions; managed in `AutoRules.tsx` (web) and
  `mobile/app/auto-rules.tsx`.
- `_test/sandbox-connect` and `_test/reset` are E2E-only endpoints gated by
  `_assert_non_prod()`.

### SnapTrade investments (`backend/app/services/snaptrade_service.py` + `snaptrade_connections.py`)

- Read-only brokerage data behind `routers/investments.py`: accounts,
  holdings, positions, balances, cost basis, activities (buys/sells/dividends),
  holdings snapshots to Firestore. Per-connection family sharing flags.
- Connect/disconnect flows live in web Settings; mobile investments tab is
  display-only ("link from the web app").
- SnapTrade personal plan allows a single SnapTrade user; register is
  idempotent and surfaces a 409 on the plan limit.

### Hosted MCP server (`backend/app/mcp_server.py`)

- Mounted at `/mcp` (Streamable HTTP). ~39 tools mirroring the chat toolset
  (expenses, budgets, Plaid data, SnapTrade, market data, prediction markets)
  for external LLM clients (claude.ai / ChatGPT connectors).
- Auth: Google OAuth bearer tokens; rejects unverified emails.
  `routers/wellknown.py` serves RFC 9728 / RFC 8414 OAuth discovery so
  connectors can authenticate.

## Frontend (web)

- React 18, Vite, TypeScript strict, Tailwind, React Query, Zustand
- Served from Firebase Hosting (`family-expense-tracker-ble.web.app`),
  CNAME'd as `ui.expense-tracker.blueelephants.org`. CI runs
  `firebase deploy --only hosting` on push to main.
- `cd frontend && npm run dev`
- Types in `frontend/src/types/index.ts`, API client in
  `frontend/src/services/api.ts`. Investment types live in api.ts, not types/.
- Main expense view is `pages/Transactions.tsx` (`/expenses` redirects there).
- Chat page uses `/chat/start` + GET `/stream`, with an inline conversation
  sidebar (list/rename/delete).
- Plaid: `pages/Settings.tsx` (Banks & Cards section) owns connect + reconnect
  via `react-plaid-link`; `pages/PlaidOAuthReturn.tsx` resumes Link after an
  OAuth bank redirect (link_token persisted in sessionStorage across the
  bounce); `services/plaidErrors.ts` maps Link exits to toasts + Sentry.

## Mobile app

Expo SDK 53 + expo-router. Shares the FastAPI backend.

### Directory layout

```
mobile/
  app/
    _layout.tsx           Root layout (QueryClientProvider + auth guard +
                          Plaid OAuth deep-link handler)
    login.tsx             Google sign-in screen
    (tabs)/               Bottom tab navigator (6 tabs)
      index.tsx           Home dashboard
      expenses.tsx        Transactions (pending review + expense CRUD)
      budgets.tsx         Budgets CRUD
      investments.tsx     Stocks (holdings; connect is web-only)
      chat.tsx            Durable chat (resumable SSE; AppState foreground
                          listener re-attaches stream; silent reconnect 3x
                          with backoff before showing retry)
      settings.tsx        Sign out, app version, links
    chat-history.tsx      Conversation list (clock icon in chat header)
    auto-rules.tsx        Merchant auto-categorization rules
    debug.tsx             Debug log viewer
  src/
    types/index.ts        Hand-mirrored from frontend/src/types/index.ts
    services/api.ts       Axios client + all API calls; SSE via
                          react-native-sse (RN fetch can't stream)
    store/auth.ts         Zustand auth store (JWT in expo-secure-store)
    hooks/useAuth.ts      Google OAuth via expo-auth-session
    components/           ErrorBoundary, WhatsNewSheet
    config/               apiBase.ts, auth.ts
    utils/debugLog.ts     Debug logging
  __tests__/              Jest + @testing-library/react-native
  .env.example            EXPO_PUBLIC_API_BASE_URL + EXPO_PUBLIC_GOOGLE_CLIENT_ID
```

### Commands

```bash
make mobile-install   # deps
make mobile-dev       # Expo dev server
make mobile-test      # or: cd mobile && npm test
cd mobile && npx tsc --noEmit
cd mobile && npx expo export   # production bundle
```

### Type sharing convention

`mobile/src/types/index.ts` is a manual mirror of `frontend/src/types/index.ts`.
When you update types in the frontend, update the mobile copy too. No
symlinks, no codegen. Known to drift; diff them when touching shared types.

### Distribution

- OTA: `mobile-ota.yml` runs EAS Update on push to main.
- iOS: `release-ipa.yml` builds an unsigned IPA for AltStore sideloading.
  `terraform/main/anisette.tf` runs an anisette-v3 Cloud Run service so
  AltStore Classic can re-sign without a Mac.

## Tests and CI

- Backend: `backend/tests/` (16 files) covers plaid, plaid_service,
  plaid_sandbox, budgets, expenses, rules, usage, mcp_auth, market-data
  integrations. Run: `cd backend && source .venv/bin/activate && pytest`.
- Web E2E: `frontend/tests/` Playwright (`plaid.spec.ts`,
  `budget-and-expense.spec.ts`) with `global-setup.ts` minting a JWT for a
  dedicated test Google account against the SAME backend the tests target
  (API_URL) - never hardcode prod there, CI uses an ephemeral JWT secret.
- CI (`.github/workflows/ci-cd.yml`): tests, then Terraform deploy
  (`TF_ENV=dev`) + Docker push + frontend deploy on push to main. The
  `e2e-plaid` job builds the frontend against a LOCAL sandbox backend
  (`ENVIRONMENT=e2e`, `PLAID_ENV=sandbox`,
  `JWT_SECRET_KEY=ci-e2e-ephemeral-<run_id>`) and drives Plaid via the
  `_test/sandbox-connect` bypass instead of the Link iframe. Plaid Sandbox
  seeds transactions with a delay; the E2E suite is flaky when sandbox
  returns pending_count=0 on early attempts.
- `infra-deploy.yml` is manual-only Terraform.

## Infrastructure notes

- Firestore composite indexes are managed declaratively in
  `terraform/main/firestore_indexes.tf`. Add new indexes there, never via the
  console (drift + 409s on apply; if an index already exists in GCP,
  `terraform import` it into state).
- `terraform/main/observability.tf`: uptime checks on `/health`, 5xx alert
  policies, email notification channel.
- CORS origins are set in `backend/app/main.py`; new frontend domains must be
  added explicitly.
