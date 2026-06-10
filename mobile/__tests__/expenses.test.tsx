import React from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('mock-jwt'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-router', () => ({ router: { replace: jest.fn(), push: jest.fn() } }))


jest.mock('@/services/api', () => {
  const mockPending = {
    pending: [],
    total: 0,
    page: 1,
    page_size: 50,
  }
  const mockData = [
    {
      id: 'e1',
      family_id: 'f1',
      amount: 45.5,
      currency: 'USD',
      date: '2025-06-01',
      description: 'Whole Foods run',
      merchant: 'Whole Foods',
      payment_method: 'credit',
      category: 'groceries',
      beneficiary: 'user-1',
      tags: [],
      created_by: 'user-1',
      created_at: '2025-06-01T10:00:00',
      updated_at: '2025-06-01T10:00:00',
    },
    {
      id: 'e2',
      family_id: 'f1',
      amount: 22.0,
      currency: 'USD',
      date: '2025-06-02',
      description: 'Chipotle',
      merchant: 'Chipotle',
      payment_method: 'debit',
      category: 'dining',
      beneficiary: 'user-1',
      tags: [],
      created_by: 'user-1',
      created_at: '2025-06-02T12:00:00',
      updated_at: '2025-06-02T12:00:00',
    },
  ]
  return {
    expensesApi: {
      list: jest.fn().mockResolvedValue({
        expenses: mockData,
        total: 2,
        page: 1,
        page_size: 20,
        has_more: false,
      }),
      create: jest.fn().mockResolvedValue({ ...mockData[0], id: 'e-new' }),
      update: jest.fn().mockResolvedValue(mockData[0]),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    plaidApi: {
      listPending: jest.fn().mockResolvedValue(mockPending),
      approve: jest.fn().mockResolvedValue({ expense: {} }),
      discard: jest.fn().mockResolvedValue(undefined),
      saveUncategorized: jest.fn().mockResolvedValue({ expense: {} }),
    },
  }
})

jest.mock('@/store/auth', () => ({
  useAuthStore: jest.fn(() => ({
    user: { id: 'user-1', family_id: 'f1', display_name: 'Test' },
    familyMembers: [{ id: 'user-1', display_name: 'Test' }],
    family: { categories: ['groceries', 'dining'], beneficiary_labels: {} },
  })),
}))

import ExpensesScreen from '../app/(tabs)/expenses'
import { expensesApi } from '@/services/api'

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return wrapper
}

describe('ExpensesScreen', () => {
  it('renders expense list after load', async () => {
    const { findByTestId, findAllByText } = render(<ExpensesScreen />, { wrapper: makeWrapper() })

    expect(await findByTestId('expenses-list')).toBeTruthy()
    expect((await findAllByText('Whole Foods run')).length).toBeGreaterThan(0)
    expect((await findAllByText('Chipotle')).length).toBeGreaterThan(0)
  })

  it('opens add modal when add button pressed', async () => {
    const { findByTestId, findByText } = render(<ExpensesScreen />, { wrapper: makeWrapper() })

    fireEvent.press(await findByTestId('add-expense-btn'))
    expect(await findByText('Add Expense')).toBeTruthy()
  })

  it('calls expensesApi.create on form submission', async () => {
    const { findByTestId, findByText } = render(<ExpensesScreen />, { wrapper: makeWrapper() })

    fireEvent.press(await findByTestId('add-expense-btn'))

    const amountInput = await findByTestId('amount-input')
    const descInput = await findByTestId('description-input')
    fireEvent.changeText(amountInput, '50')
    fireEvent.changeText(descInput, 'Test expense')

    await act(async () => {
      fireEvent.press(await findByText('Save'))
    })

    await waitFor(() => {
      expect(expensesApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50, description: 'Test expense' }),
        expect.anything()
      )
    })
  })

  it('shows empty state when no expenses', async () => {
    ;(expensesApi.list as jest.Mock).mockResolvedValueOnce({
      expenses: [],
      total: 0,
      page: 1,
      page_size: 20,
      has_more: false,
    })

    const { findByText } = render(<ExpensesScreen />, { wrapper: makeWrapper() })
    expect(await findByText('No transactions yet')).toBeTruthy()
  })
})
