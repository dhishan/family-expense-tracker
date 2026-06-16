// Google OAuth client IDs. These are PUBLIC values (they appear in every
// signed-in URL) — not secrets. Hardcoded so the CI release builds, which
// don't inject EXPO_PUBLIC_* env vars, can still configure GoogleSignin.
//
// Without this, GoogleSignin.configure({iosClientId: ''}) crashes the app
// the first time the user taps Sign in with Google. See fitness-coach's
// mobile/src/config.ts for the same pattern.
//
// If you ever rotate the OAuth client (rare — only on a project move),
// update both values here and any .env that overrides them.

export const IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
  '610355955735-ffiuug604t6htcamdstdbvm2km2fvpj0.apps.googleusercontent.com'

export const WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
  '610355955735-0uv0l16rbkr6bd345c34ck690s892kn6.apps.googleusercontent.com'
