import { useEffect } from 'react'
import { ActivityIndicator, Linking, View, Keyboard } from 'react-native'
import { Stack, router } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useAuthStore } from '@/store/auth'
import { create, open } from 'react-native-plaid-link-sdk'
import '../global.css'

const PLAID_LINK_TOKEN_KEY = 'plaid_link_token'

/**
 * Resume a Plaid OAuth flow when the app is opened via the expenses://plaid-oauth deep link.
 * The bank redirected to our backend relay, which forwarded here.
 * We restore the saved link_token, re-create the Plaid session, and open it.
 */
async function handlePlaidOAuthDeepLink(url: string): Promise<void> {
  if (!url.startsWith('expenses://plaid-oauth')) return
  const token = await AsyncStorage.getItem(PLAID_LINK_TOKEN_KEY)
  if (!token) return
  create({ token })
  open({
    onSuccess: async (success: { publicToken: string }) => {
      try {
        await AsyncStorage.removeItem(PLAID_LINK_TOKEN_KEY)
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
        </View>
      )}
    </QueryClientProvider>
  )
}
