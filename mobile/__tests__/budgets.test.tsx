import React from 'react'
import { render, waitFor, act } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('mock-jwt'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }))

const mockBudgets = [
  {
    budget: {
      id: 'b1',
      family_id: 'f1',
      name: 'Groceries Budget',
      amount: 500,
      period: 'monthly',
      category: 'groceries',
      beneficiary: null,
      start_date: '2025-06-01',
      created_by: 'user-1',
      created_at: '2025-06-01',
      updated_at: '2025-06-01',
    },
    spent: 180,
    remaining: 320,
    percentage_used: 36,
    is_over_budget: false,
    period_start: '2025-06-01',
    period_end: '2025-06-30',
  },
  {
    budget: {
      id: 'b2',
      family_id: 'f1',
      name: 'Dining Budget',
      amount: 200,
      period: 'monthly',
      category: 'dining',
      beneficiary: null,
      start_date: '2025-06-01',
      created_by: 'user-1',
      created_at: '2025-06-01',
      updated_at: '2025-06-01',
    },
    spent: 240,
    remaining: -40,
    percentage_used: 120,
    is_over_budget: true,
    period_start: '2025-06-01',
    period_end: '2025-06-30',
  },
]

jest.mock('@/services/api', () => ({
  budgetsApi: {
    list: jest.fn().mockResolvedValue({ budgets: mockBudgets, total: 2 }),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock('@/store/auth', () => ({
  useAuthStore: jest.fn(() => ({
    user: { id: 'user-1', family_id: 'f1' },
  })),
}))

import BudgetsScreen from '../app/(tabs)/budgets'

const mockBudgetData = { budgets: mockBudgets, total: 2 }

function makeWrapper(prefill = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  if (prefill) {
    qc.setQueryData(['budgets'], mockBudgetData)
  }
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return wrapper
}

describe('BudgetsScreen', () => {
  it('renders budget list after load', () => {
    // Pre-populate cache so render is synchronous (no waitFor needed)
    const { getByText, getByTestId } = render(<BudgetsScreen />, { wrapper: makeWrapper(true) })

    expect(getByTestId('budgets-list')).toBeTruthy()
    expect(getByText('Groceries Budget')).toBeTruthy()
    expect(getByText('Dining Budget')).toBeTruthy()
  })

  it('shows empty state when no budgets', () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
    })
    qc.setQueryData(['budgets'], { budgets: [], total: 0 })

    const { getByText } = render(
      <QueryClientProvider client={qc}><BudgetsScreen /></QueryClientProvider>
    )

    expect(getByText('No budgets yet')).toBeTruthy()
  })
})
