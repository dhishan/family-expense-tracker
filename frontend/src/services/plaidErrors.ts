/**
 * Shared handling for Plaid Link exit/errors.
 *
 * When a bank's OAuth flow fails (e.g. Chase's authorize endpoint returning a
 * raw `500 Internal Server Error`), Plaid Link fires onExit with a PlaidLinkError.
 * Without handling this, the user is left staring at the bank's raw error and we
 * capture nothing. This turns it into a readable toast and records the real
 * error_code to Sentry so these stop being invisible.
 */
import toast from 'react-hot-toast'
import * as Sentry from '@sentry/react'

// Loosely typed to avoid coupling to react-plaid-link's exported types.
export interface PlaidExitError {
  error_type?: string
  error_code?: string
  error_message?: string
  display_message?: string | null
}

interface ExitMetadata {
  institution?: { name?: string } | null
}

// Error codes that mean the bank (not us, not Plaid) is failing — the user
// can't fix these by retrying our flow; the bank has to recover.
const INSTITUTION_DOWN_CODES = new Set([
  'INSTITUTION_ERROR',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
  'INSTITUTION_DOWN',
  'INTERNAL_SERVER_ERROR',
])

/**
 * Report a Plaid Link exit. No-op when the user simply closed Link (err = null).
 * Shows a friendly toast and captures the real error to Sentry.
 */
export function reportPlaidExit(
  err: PlaidExitError | null,
  metadata: ExitMetadata | null | undefined,
  context: 'connect' | 'reconnect',
): void {
  if (!err) return // user dismissed Link without an error — nothing to report

  const bank = metadata?.institution?.name || 'your bank'
  const institutionDown = err.error_code ? INSTITUTION_DOWN_CODES.has(err.error_code) : false

  const message = institutionDown
    ? `${bank} is temporarily unavailable. Please try again later, or remove and re-add the connection.`
    : err.display_message ||
      err.error_message ||
      `Couldn't ${context === 'reconnect' ? 'reconnect to' : 'connect'} ${bank}. Please try again.`

  toast.error(message)

  try {
    Sentry.captureException(
      new Error(`Plaid Link ${context} failed: ${err.error_code ?? 'unknown'}`),
      {
        tags: { area: 'plaid-link', context },
        extra: {
          error_type: err.error_type,
          error_code: err.error_code,
          error_message: err.error_message,
          display_message: err.display_message,
          institution: metadata?.institution?.name,
        },
      },
    )
  } catch {
    /* Sentry optional — never let reporting throw */
  }
}
