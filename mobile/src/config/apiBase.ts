/**
 * Resolve the API base URL with a production host allowlist.
 *
 * Why: EXPO_PUBLIC_API_BASE_URL is a build-time public env var. A
 * compromised build environment or OTA-config tamper could point the app
 * at an attacker-controlled host, leaking Google ID tokens and app
 * Bearer JWTs. In dev we allow any host; in non-dev builds we accept
 * only known production hosts (under blueelephants.org over HTTPS).
 *
 * Fail closed: throws at startup if EXPO_PUBLIC_API_BASE_URL is set to
 * a non-allowlisted host in production. The app won't boot rather than
 * silently sending credentials to an unknown server.
 */

const FALLBACK_DEV_BASE = 'http://localhost:8000'
const PROD_ALLOWLIST = [
  'https://api.expense-tracker.blueelephants.org',
  'https://api.blueelephants.org',
]

function isDevBuild(): boolean {
  return (
    __DEV__ === true ||
    process.env.NODE_ENV === 'development' ||
    process.env.EXPO_PUBLIC_ENV === 'development'
  )
}

export function resolveApiBase(): string {
  const raw = (process.env.EXPO_PUBLIC_API_BASE_URL || '').trim()
  if (!raw) return isDevBuild() ? FALLBACK_DEV_BASE : PROD_ALLOWLIST[0]

  // Dev builds may point at any LAN IP (e.g. http://192.168.1.42:8000).
  if (isDevBuild()) return raw

  // Production: HTTPS + allowlisted host only.
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') {
      throw new Error(`API base must be https in production (got ${parsed.protocol})`)
    }
    const origin = `${parsed.protocol}//${parsed.host}`
    if (!PROD_ALLOWLIST.includes(origin)) {
      throw new Error(
        `EXPO_PUBLIC_API_BASE_URL host "${origin}" is not in the production ` +
          `allowlist. If this is intentional, add it to PROD_ALLOWLIST in ` +
          `mobile/src/config/apiBase.ts.`,
      )
    }
    return raw
  } catch (e) {
    // Hard fail in prod: do not silently downgrade to a default — the
    // person tampering would expect the app to fall back somewhere.
    throw new Error(`API base config rejected: ${(e as Error).message}`)
  }
}

export const API_BASE_URL = resolveApiBase()
