import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import * as Sentry from '@sentry/react'
import App from './App'
import './index.css'

Sentry.init({
  dsn: 'https://31bff24983d1eb1aed31d79f83962288@o4511581462921216.ingest.us.sentry.io/4511583937560576',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
  ],
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE ?? `web@${import.meta.env.VITE_COMMIT_SHA ?? 'dev'}`,
})

function ErrorFallback({ error, resetError }: { error: unknown; resetError: () => void }) {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
      <p style={{ color: '#6b7280', marginBottom: 16 }}>
        The error has been reported. Try again or refresh the page.
      </p>
      <pre style={{ background: '#f3f4f6', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
        {error instanceof Error ? error.message : String(error)}
      </pre>
      <button
        onClick={resetError}
        style={{ marginTop: 16, padding: '8px 16px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }}
      >
        Try again
      </button>
    </div>
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={ErrorFallback}>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#1f2937',
              color: '#fff',
            },
            success: {
              iconTheme: {
                primary: '#22c55e',
                secondary: '#fff',
              },
            },
            error: {
              iconTheme: {
                primary: '#ef4444',
                secondary: '#fff',
              },
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
