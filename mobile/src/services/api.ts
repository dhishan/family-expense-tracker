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
  PlaidItemsResponse,
  PlaidItem,
  PendingListResponse,
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
//
// New architecture (durable / resumable):
//
//   1. POST /chat/start              → returns { conversation_id, user_turn_id,
//                                       assistant_turn_id }. Generation begins
//                                       on the server in a background asyncio
//                                       task that writes every chunk to
//                                       Firestore.
//
//   2. GET .../turns/{t}/stream      → resumable SSE. Pass `from_seq=N` on
//                                       reconnect (e.g. after app backgrounding)
//                                       to skip events already rendered.
//
//   3. GET /chat/conversations       → recent chats list (history UI)
//      GET /chat/conversations/{id}  → full transcript
//      DELETE                        → remove a conversation
//
// React Native's built-in fetch is XHR-backed and does not expose a real
// ReadableStream, so we use the `react-native-sse` polyfill (which also
// supports POST + body).
import EventSource from 'react-native-sse'

export interface StartChatResponse {
  conversation_id: string
  user_turn_id: string
  assistant_turn_id: string
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  status: 'pending' | 'streaming' | 'complete' | 'error'
  text: string
  tool_calls: Array<{ id: string; name: string; input: unknown }>
  error: string | null
  model: string | null
  seq: number
}

export interface ChatConversationSummary {
  id: string
  title: string
  created_at: string | null
  updated_at: string | null
  turn_count: number
  last_turn_id: string | null
}

export interface ChatConversation {
  id: string
  title: string
  created_at: string | null
  updated_at: string | null
  turns: ChatTurn[]
}

export interface ChatStreamHandlers {
  onText?: (chunk: string) => void
  onToolCall?: (tool: { id: string; name: string; input: unknown }) => void
  onToolResult?: (tool: { id: string; name: string; preview: string }) => void
  onStatus?: (phase: string) => void
  onSeq?: (seq: number) => void
  onDone?: () => void
  onError?: (err: string) => void
}

export const chatApi = {
  /** Start a new chat or continue an existing one. */
  start: async (params: {
    conversation_id?: string | null
    message: string
    family_id?: string | null
  }): Promise<StartChatResponse> => {
    const r = await api.post<StartChatResponse>('/chat/start', {
      conversation_id: params.conversation_id ?? null,
      message: params.message,
      family_id: params.family_id ?? null,
    })
    return r.data
  },

  /**
   * Open a resumable SSE stream against a streaming assistant turn.
   * Returns a cleanup function that closes the connection.
   *
   * Pass `fromSeq` (>0) on reconnect after the app was backgrounded so the
   * server skips events already rendered on the client.
   */
  openStream: async (
    convId: string,
    turnId: string,
    fromSeq: number,
    handlers: ChatStreamHandlers,
  ): Promise<() => void> => {
    let token: string | null = null
    try {
      token = await SecureStore.getItemAsync('jwt_token')
    } catch {
      // ignore
    }

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const url =
      `${API_BASE_URL}/api/v1/chat/conversations/${encodeURIComponent(convId)}` +
      `/turns/${encodeURIComponent(turnId)}/stream?from_seq=${fromSeq}`

    const es = new EventSource(url, {
      headers,
      method: 'GET',
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
        if (typeof parsed.seq === 'number') {
          handlers.onSeq?.(parsed.seq)
        }
        if (parsed.type === 'text' && typeof parsed.text === 'string') {
          handlers.onText?.(parsed.text)
        } else if (parsed.type === 'tool_call') {
          handlers.onToolCall?.({ id: parsed.id, name: parsed.name, input: parsed.input })
        } else if (parsed.type === 'tool_result') {
          handlers.onToolResult?.({ id: parsed.id, name: parsed.name, preview: parsed.content_preview ?? '' })
        } else if (parsed.type === 'status') {
          handlers.onStatus?.(parsed.phase ?? '')
        } else if (parsed.type === 'done') {
          cleanup()
          handlers.onDone?.()
        } else if (parsed.type === 'error') {
          cleanup()
          handlers.onError?.(parsed.message ?? 'Server reported error')
        }
      } catch {
        // ignore non-JSON keepalives
      }
    })

    es.addEventListener('error', (event) => {
      const msg = (event as unknown as { message?: string }).message ?? 'Connection error'
      cleanup()
      handlers.onError?.(msg)
    })

    return cleanup
  },

  listConversations: async (limit = 50): Promise<ChatConversationSummary[]> => {
    const r = await api.get<{ conversations: ChatConversationSummary[] }>(
      '/chat/conversations',
      { params: { limit } },
    )
    return r.data.conversations
  },

  getConversation: async (convId: string): Promise<ChatConversation> => {
    const r = await api.get<ChatConversation>(
      `/chat/conversations/${encodeURIComponent(convId)}`,
    )
    return r.data
  },

  deleteConversation: async (convId: string): Promise<void> => {
    await api.delete(`/chat/conversations/${encodeURIComponent(convId)}`)
  },
}

// ─── Plaid ────────────────────────────────────────────────────────────────────

export const plaidApi = {
  createLinkToken: async (): Promise<{ link_token: string; expiration: string }> => {
    const response = await api.post<{ link_token: string; expiration: string }>('/plaid/link-token')
    return response.data
  },

  exchangePublicToken: async (
    public_token: string
  ): Promise<{ plaid_item_id: string; institution_name: string }> => {
    const response = await api.post<{ plaid_item_id: string; institution_name: string }>(
      '/plaid/exchange',
      { public_token }
    )
    return response.data
  },

  listItems: async (): Promise<PlaidItemsResponse> => {
    const response = await api.get<PlaidItemsResponse>('/plaid/items')
    return response.data
  },

  renameItem: async (id: string, institution_name: string): Promise<{ ok: boolean }> => {
    const response = await api.patch<{ ok: boolean }>(`/plaid/items/${id}`, { institution_name })
    return response.data
  },

  disconnectItem: async (id: string): Promise<void> => {
    await api.delete(`/plaid/items/${id}`)
  },

  reconnectItem: async (id: string): Promise<{ link_token: string }> => {
    const response = await api.post<{ link_token: string }>(`/plaid/items/${id}/reconnect`)
    return response.data
  },

  listPending: async (page?: number, page_size?: number): Promise<PendingListResponse> => {
    const response = await api.get<PendingListResponse>('/plaid/pending', {
      params: { page, page_size },
    })
    return response.data
  },

  approve: async (
    id: string,
    edits?: { amount?: number; category?: string; description?: string; beneficiary?: string }
  ): Promise<{ expense: Expense }> => {
    const response = await api.post<{ expense: Expense }>(
      `/plaid/pending/${id}/approve`,
      edits || {}
    )
    return response.data
  },

  discard: async (id: string): Promise<void> => {
    await api.post(`/plaid/pending/${id}/discard`)
  },

  saveUncategorized: async (id: string): Promise<{ expense: Expense }> => {
    const response = await api.post<{ expense: Expense }>(
      `/plaid/pending/${id}/save-uncategorized`
    )
    return response.data
  },
}

export default api
