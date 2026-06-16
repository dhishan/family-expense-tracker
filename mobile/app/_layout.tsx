import { useEffect } from 'react'
import { ActivityIndicator, Linking, View, Keyboard } from 'react-native'
import { Stack, router } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import * as SecureStore from 'expo-secure-store'
import { useAuthStore } from '@/store/auth'
import { create, open } from 'react-native-plaid-link-sdk'
import { WhatsNewSheet } from '@/components/WhatsNewSheet'
import '../global.css'

const PLAID_LINK_TOKEN_KEY = 'plaid_link_token'

/**
 * Resume a Plaid OAuth flow when the app is opened via expenses://plaid-oauth
 * deep link. Hardened: strict URL parsing, require oauth_state_id query param,
 * link_token stored in expo-secure-store (not AsyncStorage).
 */
async function handlePlaidOAuthDeepLink(url: string): Promise<void> {
  // Strict URL validation — `startsWith` accepts crafted prefixes like
  // `expenses://plaid-oauthsomething/`. Parse and check protocol + host/path
  // + required state param exactly.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'expenses:') return
  // Expo uses scheme://path; host/pathname both reachable depending on iOS vs Android.
  const pathish = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '')
  if (!pathish.startsWith('plaid-oauth')) return
  // Plaid OAuth resume requires this query param. Without it, this is a
  // malformed callback (or a hostile app firing a guessed scheme).
  const stateId = parsed.searchParams.get('oauth_state_id')
  if (!stateId || stateId.length < 8 || stateId.length > 256) return

  const token = await SecureStore.getItemAsync(PLAID_LINK_TOKEN_KEY).catch(() => null)
  if (!token) return
  create({ token })
  open({
    onSuccess: async (success: { publicToken: string }) => {
      try {
        await SecureStore.deleteItemAsync(PLAID_LINK_TOKEN_KEY).catch(() => {})
        const { plaidApi } = await import('@/services/api')
        await plaidApi.exchangePublicToken(success.publicToken)
      } catch {
        // exchange error — user will see the connection as missing and can retry
      }
    },
    onExit: () => {},
  })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

export default function RootLayout() {
  const { token, isLoading, loadToken } = useAuthStore()

  useEffect(() => {
    loadToken()
  }, [loadToken])

  // Handle Plaid OAuth deep links (expenses://plaid-oauth?oauth_state_id=...)
  useEffect(() => {
    // App already open — foreground URL events
    const sub = Linking.addEventListener('url', ({ url }) => {
      void handlePlaidOAuthDeepLink(url)
    })
    // App launched cold from the deep link
    Linking.getInitialURL().then((url) => {
      if (url) void handlePlaidOAuthDeepLink(url)
    })
    return () => sub.remove()
  }, [])

  // Route based on auth state once loadToken finishes. While it runs we
  // show a loading view so the user doesn't briefly see empty tab content.
  useEffect(() => {
    if (isLoading) return
    if (!token) {
      router.replace('/login')
    } else {
      // Make sure we're in the tabs group (and not stuck on /login after
      // a successful silent re-auth)
      router.replace('/(tabs)')
    }
  }, [token, isLoading])

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" />
      {isLoading ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#2563eb',
          }}
        >
          <ActivityIndicator size="large" color="#ffffff" />
        </View>
      ) : (
        <View style={{ flex: 1 }} onStartShouldSetResponder={() => false} onTouchStart={() => Keyboard.dismiss()}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(tabs)" />
        </Stack>
        <WhatsNewSheet />
        </View>
      )}
    </QueryClientProvider>
  )
}
