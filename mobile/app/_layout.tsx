import { useEffect } from 'react'
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
  const { token, isLoading, loadToken, user } = useAuthStore()

  useEffect(() => {
    loadToken()
  }, [loadToken])

  useEffect(() => {
    if (isLoading) return
    if (!token) {
      router.replace('/login')
    }
  }, [token, isLoading])

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </QueryClientProvider>
  )
}
