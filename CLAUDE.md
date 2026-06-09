# Family Expense Tracker - Codebase Guide

## Structure

```
family-expense-tracker/
  backend/       FastAPI on Cloud Run (prod: api.expense-tracker.blueelephants.org)
  frontend/      React + Vite + TypeScript + Tailwind
                   (prod: ui.expense-tracker.blueelephants.org → Firebase Hosting)
  mobile/        Expo React Native app (shared FastAPI backend)
  terraform/     GCP infrastructure
  Makefile       All dev/deploy commands (run `make help`)
```

## Backend

- FastAPI, Python 3.12, Firestore, Cloud Run
- Auth: Google OAuth -> Firebase ID token -> backend JWT
- `cd backend && . venv/bin/activate && uvicorn app.main:app --reload`
- Prod URL: `https://api.expense-tracker.blueelephants.org`
- **Cloud Run is configured with `min_instances=1` + `cpu_throttling=false`** so the chat's background generation asyncio tasks survive the HTTP response completing. See `terraform/main/main.tf` annotations for why.

### Chat architecture (`backend/app/routers/chat.py` + `backend/app/services/chat_store.py`)

- Durable, Firestore-backed conversations. Every chat is stored under
  `/chat_conversations/{conv_id}/turns/{turn_id}` with the user_id
  denormalized onto every doc for security (cross-user reads → 404, not 403).
- `POST /chat/start` creates conv + turn docs, spawns generation as
  `asyncio.create_task`, returns IDs immediately.
- Generation writes every text delta / tool_call / tool_result / status
  event into the turn doc's `events` array as it streams.
- `GET /chat/conversations/{c}/turns/{t}/stream?from_seq=N` is a
  resumable SSE that polls Firestore for events with seq > N. Mobile
  re-opens it on AppState foreground with the last seen seq so chats
  pick up exactly where they left off after the app is backgrounded.
- 10s SSE keepalive comments during the idle poll loop so iOS / LB don't
  drop the connection during the model's thinking phase between tool batches.
- `POST /chat` is a backwards-compat shim for old mobile bundles that still
  hit the old SSE endpoint — internally routes into the same `_generate_turn`.
- Adaptive routing: Sonnet 4.6 + medium effort by default; Opus 4.7 +
  high effort only on explicit "deep analysis" / "rebalance" / "stress test"
  keywords. The system prompt enforces brief conversational answers unless
  the long-form template is explicitly requested.

## Frontend (web)

- React 18, Vite, TypeScript strict, Tailwind CSS, React Query, Zustand
- **Served from Firebase Hosting** (`family-expense-tracker-ble.web.app`),
  CNAME'd as `ui.expense-tracker.blueelephants.org`. CI runs
  `firebase deploy --only hosting` on push to `main`.
- `cd frontend && npm run dev`
- Types in `frontend/src/types/index.ts`, API in `frontend/src/services/api.ts`
- Chat page uses the new `/chat/start` + GET `/stream` flow; tracks
  `conversationId` in state so subsequent sends continue the same conv.

## Mobile app

Expo SDK 53 + expo-router. Shares the FastAPI backend.

### Directory layout

```
mobile/
  app/
    _layout.tsx           Root layout (QueryClientProvider + auth guard)
    login.tsx             Google sign-in screen
    (tabs)/
      _layout.tsx         Bottom tab navigator (5 tabs)
      index.tsx           Dashboard
      expenses.tsx        Expenses CRUD
      budgets.tsx         Budgets CRUD
      investments.tsx     Holdings + accounts (read-only)
      chat.tsx            Durable chat (POST /chat/start + resumable
                          GET /stream; AppState foreground listener
                          re-attaches stream on app return; silent
                          reconnect 3× with backoff before showing the
                          retry button)
      settings.tsx        Sign out, app version, links
    chat-history.tsx      Recent conversations list (history UI). Reachable
                          via the clock icon in the chat header.
  src/
    types/index.ts        Shared types - mirrored from frontend/src/types/index.ts
    services/api.ts       Axios client + all API calls. chatApi exposes
                          start() / openStream(fromSeq) / listConversations /
                          getConversation / deleteConversation. SSE uses
                          react-native-sse (RN's fetch can't stream).
    store/auth.ts         Zustand auth store (JWT in expo-secure-store)
    hooks/useAuth.ts      Google OAuth hook via expo-auth-session
  __tests__/              Jest + @testing-library/react-native tests
  .env.example            Copy to .env; set EXPO_PUBLIC_API_BASE_URL + EXPO_PUBLIC_GOOGLE_CLIENT_ID
```

### Develop

```bash
# Install deps
make mobile-install

# Start Expo dev server (scan QR with Expo Go app or run in simulator)
make mobile-dev

# Start everything at once (backend + web + mobile)
make dev-all
```

### Test

```bash
make mobile-test
# or
cd mobile && npm test
```

### TypeScript check

```bash
cd mobile && npx tsc --noEmit
```

### Production bundle

```bash
cd mobile && npx expo export
```

### Type sharing convention

`mobile/src/types/index.ts` is a manual mirror of `frontend/src/types/index.ts`.
When you update types in the frontend, update the mobile copy too.
Both files are kept in sync by hand - no symlinks, no codegen - to avoid cross-workspace import issues.

### Environment config

Copy `.env.example` to `.env` in `mobile/`:

```
EXPO_PUBLIC_API_BASE_URL=http://localhost:8000   # or prod URL
EXPO_PUBLIC_GOOGLE_CLIENT_ID=your-google-oauth-client-id
```

For the iOS simulator pointing at local backend: the simulator uses localhost, so
`http://localhost:8000` works. For a physical device, use your machine's LAN IP.

### Manual setup steps (one-time, not automated)

1. **Google OAuth client ID (native)** - Create an iOS + Android OAuth client at
   console.cloud.google.com -> APIs & Services -> Credentials. Set the redirect URI to
   the Expo scheme: `family-expense-tracker://`. Set `EXPO_PUBLIC_GOOGLE_CLIENT_ID`.

2. **EAS setup** - Run `eas init` in `mobile/` and update `app.json` with the real
   `extra.eas.projectId`. Requires an Expo account.

3. **Apple Developer account** - Required for `eas build --platform ios` and TestFlight
   distribution. Not needed for Expo Go development.

4. **Android keystore** - EAS manages this automatically on first build if not provided.

### Build (CI/CD)

Builds run via EAS. See `eas.json` (create after EAS init). Trigger:
```bash
make mobile-build-ios      # requires Apple Dev account
make mobile-build-android  # generates APK/AAB
```

Do NOT run `eas build` locally until Apple Developer credentials are configured.
