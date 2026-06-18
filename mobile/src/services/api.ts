/**
 * Reduce a backend SSE error payload to a user-friendly one-liner.
 * The chat backend stringifies the upstream provider exception so the
 * raw blob looks like `{'type': 'error', 'error': {'message': '...'}}`.
 * Pull out the inner message, otherwise return a generic phrase.
 */
function friendlyErrorMessage(raw: unknown): string {
  if (!raw) return 'The model errored. Please try again.'
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    try {
      text = JSON.stringify(raw)
    } catch {
      text = String(raw)
    }
  }
  // Detect specific upstream error families.
  if (/overloaded|rate.?limit|503|429/i.test(text)) {
    return 'The model is overloaded right now — please retry in a moment.'
  }
  if (/Internal server error|api_error|503|502|504/i.test(text)) {
    return 'The model service had a hiccup. Tap retry.'
  }
  if (/timeout/i.test(text)) {
    return 'The model took too long to respond. Tap retry.'
  }
  // Try to extract a nested .message if present.
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    const inner =
      (obj as { error?: { message?: string }; message?: string })?.error?.message ??
      (obj as { message?: string })?.message
    if (typeof inner === 'string' && inner.length > 0) {
      return inner.length > 200 ? `${inner.slice(0, 200)}…` : inner
    }
  } catch {
    // fallthrough
  }
  return 'The model errored. Please try again.'
}

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
  ExpenseSummary,
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
  ApproveSplitPayload,
  ApproveSplitResponse,
  MerchantRule,
  MerchantRuleCreate,
} from '../types'

import { API_BASE_URL } from '../config/apiBase'

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

// Handle 401 + Sentry breadcrumb on every API failure
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Sentry = require('@sentry/react-native')
      Sentry.addBreadcrumb({
        category: 'api',
        type: 'http',
        level: error.response?.status && error.response.status >= 500 ? 'error' : 'warning',
        message: `${error.config?.method?.toUpperCase?.() ?? 'REQ'} ${error.config?.url ?? '?'} → ${error.response?.status ?? 'network'}`,
        data: { status: error.response?.status, detail: error.response?.data?.detail },
      })
    } catch { /* sentry not available */ }
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
    payment_method?: string
    search?: string
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

  getSummary: async (params?: {
    start_date?: string
    end_date?: string
    beneficiary?: string
  }): Promise<ExpenseSummary> => {
    const response = await api.get<ExpenseSummary>('/expenses/summary', { params })
    return response.data
  },
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

export const budgetsApi = {
  list: async (view: 'current' | 'ytd' = 'current'): Promise<BudgetListResponse> => {
    const d = new Date()
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const response = await api.get<BudgetListResponse>('/budgets', { params: { reference_date: localDate, view } })
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

  listTransactions: async (
    budgetId: string,
    scope: 'current' | 'all' = 'current',
  ): Promise<{ expenses: Expense[]; total: number }> => {
    const response = await api.get(`/budgets/${budgetId}/transactions`, { params: { scope } })
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

  deregister: async (): Promise<{ deleted: boolean }> => {
    const response = await api.delete<{ deleted: boolean }>('/investments/registration')
    return response.data
  },

  listConnections: async (): Promise<{ connections: BrokerageConnection[] }> => {
    const response = await api.get<{ connections: BrokerageConnection[] }>('/investments/connections')
    return response.data
  },

  updateConnectionShare: async (
    authorizationId: string,
    sharedWithFamily: boolean,
  ): Promise<BrokerageConnection> => {
    const response = await api.patch<BrokerageConnection>(
      `/investments/connections/${authorizationId}`,
      { shared_with_family: sharedWithFamily },
    )
    return response.data
  },
}

export interface BrokerageConnection {
  authorization_id: string
  owner_user_id: string
  family_id: string | null
  brokerage: string | null
  shared_with_family: boolean
  is_owner: boolean
  added_at?: string
  updated_at?: string
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
    model?: 'smart' | 'opus' | 'sonnet' | 'gpt'
  }): Promise<StartChatResponse> => {
    const r = await api.post<StartChatResponse>('/chat/start', {
      conversation_id: params.conversation_id ?? null,
      message: params.message,
      family_id: params.family_id ?? null,
      model: params.model ?? 'smart',
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
          handlers.onError?.(friendlyErrorMessage(parsed.message))
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

  renameConversation: async (convId: string, title: string): Promise<{ id: string; title: string }> => {
    const r = await api.patch(`/chat/conversations/${convId}`, { title })
    return r.data
  },

  deleteConversation: async (convId: string): Promise<void> => {
    await api.delete(`/chat/conversations/${encodeURIComponent(convId)}`)
  },
}

// ─── Plaid ────────────────────────────────────────────────────────────────────

export const plaidApi = {
  createLinkToken: async (opts?: { platform?: 'web' | 'mobile' }): Promise<{ link_token: string; expiration: string }> => {
    const response = await api.post<{ link_token: string; expiration: string }>('/plaid/link-token', {
      platform: opts?.platform ?? 'mobile',
    })
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
    edits?: {
      amount?: number
      date?: string
      category?: string
      description?: string
      merchant?: string
      payment_method?: string
      beneficiary?: string
      tags?: string[]
      is_income_override?: boolean
      budget_id?: string | null
    }
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

  approveSplit: async (id: string, payload: ApproveSplitPayload): Promise<ApproveSplitResponse> => {
    const response = await api.post<ApproveSplitResponse>(
      `/plaid/pending/${id}/approve-split`,
      payload
    )
    return response.data
  },
}

// ─── Merchant Auto-Rules ──────────────────────────────────────────────────────

export const rulesApi = {
  list: async (): Promise<MerchantRule[]> => {
    const response = await api.get<{ rules: MerchantRule[] }>('/rules/merchant')
    return response.data.rules
  },

  create: async (data: MerchantRuleCreate): Promise<MerchantRule> => {
    const response = await api.post<MerchantRule>('/rules/merchant', data)
    return response.data
  },

  delete: async (ruleId: string): Promise<void> => {
    await api.delete(`/rules/merchant/${ruleId}`)
  },
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface QuickUsage {
  session_cost_usd: number
  month_cost_usd: number
}

export const usageApi = {
  quick: async (conversationId?: string | null): Promise<QuickUsage> => {
    const params: Record<string, string> = {}
    if (conversationId) params.conversation_id = conversationId
    const response = await api.get<QuickUsage>('/usage/quick', { params })
    return response.data
  },
}

export default api
