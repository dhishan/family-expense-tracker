# Family Expense Tracker - Codebase Guide

## Structure

```
family-expense-tracker/
  backend/       FastAPI on Cloud Run (prod: api.expense-tracker.blueelephants.org)
  frontend/      React + Vite + TypeScript + Tailwind (prod: ui.expense-tracker.blueelephants.org)
  mobile/        Expo React Native app (shared FastAPI backend)
  terraform/     GCP infrastructure
  Makefile       All dev/deploy commands (run `make help`)
```

## Backend

- FastAPI, Python 3.12, Firestore, Cloud Run
- Auth: Google OAuth -> Firebase ID token -> backend JWT
- `cd backend && . venv/bin/activate && uvicorn app.main:app --reload`
- Prod URL: `https://api.expense-tracker.blueelephants.org`

## Frontend (web)

- React 18, Vite, TypeScript strict, Tailwind CSS, React Query, Zustand
- `cd frontend && npm run dev`
- Types in `frontend/src/types/index.ts`, API in `frontend/src/services/api.ts`

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
      chat.tsx            SSE chat with AI
      settings.tsx        Sign out, app version, links
  src/
    types/index.ts        Shared types - mirrored from frontend/src/types/index.ts
    services/api.ts       Axios client + all API calls (mirrors frontend pattern)
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
