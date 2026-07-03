/**
 * PlaidOAuthReturn — handles the OAuth redirect back from an OAuth bank (Amex,
 * Capital One, BofA, Wells Fargo, etc.).
 *
 * Flow:
 *   1. Plaid Link sent the user to the bank's OAuth login page.
 *   2. The bank redirected back here with ?oauth_state_id=... in the URL.
 *   3. We restore the link_token from sessionStorage, open Plaid Link in
 *      "OAuth resume" mode (receivedRedirectUri = current URL), and wait for
 *      onSuccess to fire exactly as in the normal flow.
 *   4. On success we exchange the public token and navigate to /settings.
 */
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlaidLink } from 'react-plaid-link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { plaidApi } from '../services/api'
import { reportPlaidExit } from '../services/plaidErrors'
import { useAuthStore } from '../store/auth'

export default function PlaidOAuthReturn() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  // Pull the saved link_token that was written in Settings before Link opened
  const linkToken = user?.id
    ? sessionStorage.getItem(`plaid_link_token_${user.id}`)
    : null

  // The full current URL (including ?oauth_state_id=...) is what Plaid needs
  const receivedRedirectUri = window.location.href

  const hasOpened = useRef(false)

  const exchangeMutation = useMutation({
    mutationFn: (public_token: string) => plaidApi.exchangePublicToken(public_token),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
      // Clean up the saved token
      if (user?.id) sessionStorage.removeItem(`plaid_link_token_${user.id}`)
      toast.success('Bank connected!')
      navigate('/settings', { replace: true })
      // If sync is still running, Settings will detect it via the items poll
      void result
    },
    onError: () => {
      toast.error('Failed to connect bank — please try again')
      navigate('/settings', { replace: true })
    },
  })

  const { open, ready } = usePlaidLink(
    linkToken
      ? {
          token: linkToken,
          receivedRedirectUri,
          onSuccess: (public_token) => {
            exchangeMutation.mutate(public_token)
          },
          onExit: (err, metadata) => {
            // OAuth banks (Chase, etc.) can fail mid-flow with a bank-side
            // error; surface it instead of silently bouncing to /settings.
            reportPlaidExit(err, metadata, 'reconnect')
            navigate('/settings', { replace: true })
          },
        }
      : {
          // Dummy — will never be opened (no token case handled below)
          token: '',
          onSuccess: () => {},
        }
  )

  useEffect(() => {
    if (!linkToken) {
      // No saved token — user navigated here directly or session expired
      navigate('/settings', { replace: true })
      return
    }
    if (ready && !hasOpened.current) {
      hasOpened.current = true
      open()
    }
  }, [ready, linkToken, navigate, open])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4" />
        <p className="text-gray-600">Completing bank connection...</p>
      </div>
    </div>
  )
}
