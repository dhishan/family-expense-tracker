import axios from 'axios'
import * as SecureStore from 'expo-secure-store'
import type {
  AuthResponse,
  User,
  Family,
  FamilyWithMembers,
  FamilyMember,
  Expense,
  ExpenseCreate,
  ExpenseUpdate,
  ExpenseListResponse,
  Budget,
  BudgetCreate,
  BudgetUpdate,
  BudgetListResponse,
  BudgetStatus,
  NotificationListResponse,
  InvestmentAccount,
  HoldingGroup,
  ChatMessage,
} from '../types'

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

const api = axios.create({
  baseURL: `${API_BASE_URL}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
  // 45s timeout — accommodates Cloud Run cold starts (~10-30s) plus the
  // per-account SnapTrade fetches inside get_all_holdings, while still
  // failing visibly if something is wedged. Without an explicit timeout
  // axios will hang the React Query promise forever and the spinners
  // never resolve.
  timeout: 45_000,
})

// Add auth token to every request
api.interceptors.request.use(async (config) => {
  try {
    const token = await SecureStore.getItemAsync('jwt_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  } catch {
    // SecureStore unavailable (e.g. web) — ignore
  }
  return config
})

// Handle 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/google')) {
      await SecureStore.deleteItemAsync('jwt_token').catch(() => {})
    }
    return Promise.reject(error)
  }
)

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  googleLogin: async (
    token: string,
    tokenType: 'id_token' | 'access_token' = 'id_token'
  ): Promise<AuthResponse> => {
    const response = await api.post<AuthResponse>('/auth/google', {
      token,
      token_type: tokenType,
    })
    return response.data
  },

  getCurrentUser: async (): Promise<User> => {
    const response = await api.get<User>('/auth/me')
    return response.data
  },

  logout: async (): Promise<void> => {
    await api.post('/auth/logout')
  },
}

// ─── Family ───────────────────────────────────────────────────────────────────

export const familyApi = {
  create: async (name: string): Promise<Family> => {
    const response = await api.post<Family>('/families', { name })
    return response.data
  },

  get: async (familyId: string): Promise<FamilyWithMembers> => {
    const response = await api.get<FamilyWithMembers>(`/families/${familyId}`)
    return response.data
  },

  getMembers: async (familyId: string): Promise<FamilyMember[]> => {
    const response = await api.get<FamilyMember[]>(`/families/${familyId}/members`)
    return response.data
  },

  joinByCode: async (inviteCode: string): Promise<Family> => {
    const response = await api.post<Family>('/families/join-by-code', {
      invite_code: inviteCode,
    })
    return response.data
  },
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export const expensesApi = {
  list: async (params?: {
    page?: number
    page_size?: number
    category?: string
    start_date?: string
    end_date?: string
    beneficiary?: string
  }): Promise<ExpenseListResponse> => {
    const response = await api.get<ExpenseListResponse>('/expenses', { params })
    return response.data
  },

  get: async (expenseId: string): Promise<Expense> => {
    const response = await api.get<Expense>(`/expenses/${expenseId}`)
    return response.data
  },

  create: async (data: ExpenseCreate): Promise<Expense> => {
    const response = await api.post<Expense>('/expenses', data)
    return response.data
  },

  update: async (expenseId: string, data: ExpenseUpdate): Promise<Expense> => {
    const response = await api.put<Expense>(`/expenses/${expenseId}`, data)
    return response.data
  },

  delete: async (expenseId: string): Promise<void> => {
    await api.delete(`/expenses/${expenseId}`)
  },
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

export const budgetsApi = {
  list: async (): Promise<BudgetListResponse> => {
    const response = await api.get<BudgetListResponse>('/budgets')
    return response.data
  },

  create: async (data: BudgetCreate): Promise<Budget> => {
    const response = await api.post<Budget>('/budgets', data)
    return response.data
  },

  update: async (budgetId: string, data: BudgetUpdate): Promise<Budget> => {
    const response = await api.put<Budget>(`/budgets/${budgetId}`, data)
    return response.data
  },

  delete: async (budgetId: string): Promise<void> => {
    await api.delete(`/budgets/${budgetId}`)
  },

  getStatus: async (budgetId: string): Promise<BudgetStatus> => {
    const response = await api.get<BudgetStatus>(`/budgets/${budgetId}/status`)
    return response.data
  },
}

// ─── Notifications ────────────────────────────────────────────────────────────

export const notificationsApi = {
  list: async (params?: {
    unread_only?: boolean
    limit?: number
  }): Promise<NotificationListResponse> => {
    const response = await api.get<NotificationListResponse>('/notifications', { params })
    return response.data
  },

  markAsRead: async (notificationId: string): Promise<void> => {
    await api.put(`/notifications/${notificationId}/read`)
  },

  markAllAsRead: async (): Promise<void> => {
    await api.put('/notifications/read-all')
  },
}

// ─── Investments ──────────────────────────────────────────────────────────────

export const investmentsApi = {
  register: async (): Promise<unknown> => {
    const response = await api.post('/investments/register')
    return response.data
  },

  connect: async (broker?: string | null): Promise<{ redirectURI: string }> => {
    const response = await api.post<{ redirectURI: string }>('/investments/connect', {
      broker: broker ?? null,
      connection_type: 'read',
    })
    return response.data
  },

  accounts: async (): Promise<InvestmentAccount[]> => {
    const response = await api.get<InvestmentAccount[]>('/investments/accounts')
    return response.data
  },

  holdings: async (): Promise<HoldingGroup[]> => {
    const response = await api.get<HoldingGroup[]>('/investments/holdings')
    return response.data
  },
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

// React Native's built-in fetch is XHR-backed and does not expose a
// real ReadableStream from `response.body`, so the standard
// fetch+getReader() pattern (works on web) hangs or fails on iOS with
// "Network request failed". Use the dedicated `react-native-sse` EventSource
// polyfill which speaks SSE directly over RN's networking stack.
import EventSource from 'react-native-sse'

export const chatApi = {
  sendMessage: async (
    messages: ChatMessage[],
    _familyId: string | undefined,
    onChunk?: (chunk: string) => void,
    onDone?: () => void,
    onError?: (err: string) => void,
    onToolCall?: (tool: { id: string; name: string; input: unknown }) => void,
    onToolResult?: (tool: { id: string; name: string; preview: string }) => void,
  ): Promise<() => void> => {
    let token: string | null = null
    try {
      token = await SecureStore.getItemAsync('jwt_token')
    } catch {
      // ignore
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    // EventSource here is using POST + body — react-native-sse supports that
    // through its `method` / `body` opts (unlike the web standard).
    const es = new EventSource(`${API_BASE_URL}/api/v1/chat`, {
      headers,
      method: 'POST',
      body: JSON.stringify({ messages }),
      pollingInterval: 0,
    })

    const cleanup = () => {
      try { es.removeAllEventListeners() } catch { /* noop */ }
      try { es.close() } catch { /* noop */ }
    }

    es.addEventListener('message', (event) => {
      const raw = (event as unknown as { data?: string }).data
      if (!raw) return
      try {
        const parsed = JSON.parse(raw)
        if (parsed.type === 'text' && typeof parsed.text === 'string') {
          onChunk?.(parsed.text)
        } else if (parsed.type === 'tool_call' && onToolCall) {
          onToolCall({ id: parsed.id, name: parsed.name, input: parsed.input })
        } else if (parsed.type === 'tool_result' && onToolResult) {
          onToolResult({ id: parsed.id, name: parsed.name, preview: parsed.content_preview ?? '' })
        } else if (parsed.type === 'done') {
          cleanup()
          onDone?.()
        } else if (parsed.type === 'error') {
          cleanup()
          onError?.(parsed.message ?? 'Server reported error')
        }
      } catch {
        // ignore non-JSON keepalives
      }
    })

    es.addEventListener('error', (event) => {
      const msg = (event as unknown as { message?: string }).message ?? 'Connection error'
      cleanup()
      onError?.(msg)
    })

    return cleanup
  },
}

export default api
