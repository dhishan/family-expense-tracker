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
  list: async (): Promise<BudgetListResponse> => {
    const response = await api.get<BudgetListResponse>('/budgets')
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

export default api
