import axios from 'axios'
import { useAuthStore } from '../store/auth'
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
  PlaidItemsResponse,
  PendingListResponse,
  PendingApproveSplit,
  MerchantRule,
  MerchantRuleCreate,
  MerchantRulesResponse,
} from '../types'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only redirect on 401 for authenticated routes, not for login itself
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/google')) {
      console.error('Authentication failed, redirecting to login')
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// Auth API
export const authApi = {
  googleLogin: async (token: string, tokenType: 'id_token' | 'access_token' = 'id_token'): Promise<AuthResponse> => {
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

// Family API
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

  join: async (familyId: string, inviteCode: string): Promise<Family> => {
    const response = await api.post<Family>(`/families/${familyId}/join`, {
      invite_code: inviteCode,
    })
    return response.data
  },

  joinByCode: async (inviteCode: string): Promise<Family> => {
    const response = await api.post<Family>('/families/join-by-code', {
      invite_code: inviteCode,
    })
    return response.data
  },

  leave: async (familyId: string): Promise<void> => {
    await api.post(`/families/${familyId}/leave`)
  },

  regenerateInviteCode: async (familyId: string): Promise<{ invite_code: string }> => {
    const response = await api.post<{ invite_code: string }>(
      `/families/${familyId}/regenerate-invite`
    )
    return response.data
  },

  updateSettings: async (
    familyId: string,
    settings: { categories?: string[]; beneficiary_labels?: Record<string, string> }
  ): Promise<Family> => {
    const response = await api.put<Family>(`/families/${familyId}/settings`, settings)
    return response.data
  },
}

// Expenses API
export const expensesApi = {
  list: async (params?: {
    page?: number
    page_size?: number
    start_date?: string
    end_date?: string
    category?: string
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

  create: async (expense: ExpenseCreate): Promise<Expense> => {
    const response = await api.post<Expense>('/expenses', expense)
    return response.data
  },

  update: async (expenseId: string, expense: ExpenseUpdate): Promise<Expense> => {
    const response = await api.put<Expense>(`/expenses/${expenseId}`, expense)
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

// Budgets API
export const budgetsApi = {
  list: async (view: 'current' | 'ytd' = 'current'): Promise<BudgetListResponse> => {
    const d = new Date()
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const response = await api.get<BudgetListResponse>('/budgets', { params: { reference_date: localDate, view } })
    return response.data
  },

  get: async (budgetId: string): Promise<Budget> => {
    const response = await api.get<Budget>(`/budgets/${budgetId}`)
    return response.data
  },

  getStatus: async (budgetId: string): Promise<BudgetStatus> => {
    const response = await api.get<BudgetStatus>(`/budgets/${budgetId}/status`)
    return response.data
  },

  create: async (budget: BudgetCreate): Promise<Budget> => {
    const response = await api.post<Budget>('/budgets', budget)
    return response.data
  },

  update: async (budgetId: string, budget: BudgetUpdate): Promise<Budget> => {
    const response = await api.put<Budget>(`/budgets/${budgetId}`, budget)
    return response.data
  },

  delete: async (budgetId: string): Promise<void> => {
    await api.delete(`/budgets/${budgetId}`)
  },

  listTransactions: async (
    budgetId: string,
    scope: 'current' | 'all' = 'current',
  ): Promise<{ expenses: Expense[]; total: number }> => {
    const response = await api.get(`/budgets/${budgetId}/transactions`, { params: { scope } })
    return response.data
  },
}

// Notifications API
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

  getUnreadCount: async (): Promise<{ unread_count: number }> => {
    const response = await api.get<{ unread_count: number }>('/notifications/unread-count')
    return response.data
  },
}

// Investments API
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

export interface InvestmentAccount {
  id: string
  name: string
  number?: string
  institution_name?: string
  sync_status?: {
    holdings?: { last_successful_sync?: string | null; initial_sync_completed?: boolean }
    transactions?: { last_successful_sync?: string | null; initial_sync_completed?: boolean }
  }
  cash_restrictions?: unknown
  meta?: Record<string, unknown>
}

export interface HoldingPosition {
  symbol?: { symbol?: { symbol?: string; description?: string } }
  units?: number
  price?: number
  average_purchase_price?: number
  open_pnl?: number
  fractional_units?: number
}

export interface HoldingBalance {
  currency?: { code?: string }
  cash?: number
  buying_power?: number
  total_value?: number
}

export interface HoldingGroup {
  account?: { id?: string; name?: string; institution_name?: string }
  positions?: HoldingPosition[]
  balances?: HoldingBalance[]
}

// Plaid API
export const plaidApi = {
  createLinkToken: async (opts?: { platform?: 'web' | 'mobile' }): Promise<{ link_token: string; expiration: string }> => {
    const response = await api.post<{ link_token: string; expiration: string }>('/plaid/link-token', {
      platform: opts?.platform ?? 'web',
    })
    return response.data
  },

  exchangePublicToken: async (public_token: string): Promise<{
    plaid_item_id: string
    institution_name: string
    accounts_count: number
    pending_count: number
    sync_status: 'pending' | 'complete'
  }> => {
    const response = await api.post<{
      plaid_item_id: string
      institution_name: string
      accounts_count: number
      pending_count: number
      sync_status: 'pending' | 'complete'
    }>('/plaid/exchange', { public_token })
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
    const response = await api.get<PendingListResponse>('/plaid/pending', { params: { page, page_size } })
    return response.data
  },

  approve: async (
    id: string,
    edits?: {
      amount?: number
      category?: string
      description?: string
      beneficiary?: string
      date?: string
      merchant?: string
      payment_method?: string
      tags?: string[]
      is_income_override?: boolean
      budget_id?: string | null
    }
  ): Promise<{ expense: Expense }> => {
    const response = await api.post<{ expense: Expense }>(`/plaid/pending/${id}/approve`, edits || {})
    return response.data
  },

  discard: async (id: string): Promise<void> => {
    await api.post(`/plaid/pending/${id}/discard`)
  },

  saveUncategorized: async (id: string): Promise<{ expense: Expense }> => {
    const response = await api.post<{ expense: Expense }>(`/plaid/pending/${id}/save-uncategorized`)
    return response.data
  },

  approveSplit: async (id: string, payload: PendingApproveSplit): Promise<{ expense_ids: string[]; pending_id: string }> => {
    const response = await api.post<{ expense_ids: string[]; pending_id: string }>(`/plaid/pending/${id}/approve-split`, payload)
    return response.data
  },
}

// Rules API
export const rulesApi = {
  list: async (): Promise<MerchantRulesResponse> => {
    const response = await api.get<MerchantRulesResponse>('/rules/merchant')
    return response.data
  },

  create: async (rule: MerchantRuleCreate): Promise<MerchantRule> => {
    const response = await api.post<MerchantRule>('/rules/merchant', rule)
    return response.data
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/rules/merchant/${id}`)
  },
}

// Chat API (history)
export interface ChatConversationSummary {
  id: string
  title: string
  created_at: string | null
  updated_at: string | null
  turn_count: number
  last_turn_id: string | null
}

export const chatApi = {
  listConversations: async (limit = 50): Promise<{ conversations: ChatConversationSummary[] }> => {
    const response = await api.get('/chat/conversations', { params: { limit } })
    return response.data
  },

  getConversation: async (conversationId: string): Promise<{ conversation: ChatConversationSummary; turns: unknown[] }> => {
    const response = await api.get(`/chat/conversations/${conversationId}`)
    return response.data
  },

  deleteConversation: async (conversationId: string): Promise<void> => {
    await api.delete(`/chat/conversations/${conversationId}`)
  },

  renameConversation: async (conversationId: string, title: string): Promise<{ id: string; title: string }> => {
    const response = await api.patch(`/chat/conversations/${conversationId}`, { title })
    return response.data
  },
}

export const usageApi = {
  quick: async (conversationId?: string | null): Promise<{ session_cost_usd: number; month_cost_usd: number }> => {
    const params: Record<string, string> = {}
    if (conversationId) params.conversation_id = conversationId
    const response = await api.get('/usage/quick', { params })
    return response.data
  },
}

export default api
