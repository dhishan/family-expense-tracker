import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { useAuthStore } from '@/store/auth'
import '../global.css'

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
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      )}
    </QueryClientProvider>
  )
}
