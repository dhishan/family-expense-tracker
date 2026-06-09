import React from 'react'
import { render, waitFor, fireEvent, act } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('mock-jwt'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }))

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}))

const mockAccounts = [
  { id: 'acct-1', name: 'Robinhood', institution_name: 'Robinhood' },
]

const mockHoldings = [
  {
    account: { id: 'acct-1', name: 'Robinhood', institution_name: 'Robinhood' },
    positions: [
      {
        symbol: { symbol: { symbol: 'AAPL', description: 'Apple Inc.' } },
        units: 10,
        price: 175.5,
        average_purchase_price: 140.0,
        open_pnl: 355.0,
      },
      {
        symbol: { symbol: { symbol: 'TSLA', description: 'Tesla Inc.' } },
        units: 5,
        price: 200.0,
        average_purchase_price: 250.0,
        open_pnl: -250.0,
      },
    ],
    balances: [{ currency: { code: 'USD' }, cash: 500, total_value: 2255 }],
  },
]

jest.mock('@/services/api', () => ({
  investmentsApi: {
    accounts: jest.fn().mockResolvedValue(mockAccounts),
    holdings: jest.fn().mockResolvedValue(mockHoldings),
    register: jest.fn().mockResolvedValue({}),
    connect: jest.fn().mockResolvedValue({ redirectURI: 'https://example.com' }),
  },
}))

jest.mock('@/store/auth', () => ({
  useAuthStore: jest.fn(() => ({
    user: { id: 'user-1', family_id: 'f1' },
  })),
}))

import InvestmentsScreen from '../app/(tabs)/investments'

function makeWrapper(prefill = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  if (prefill) {
    qc.setQueryData(['investments', 'accounts'], mockAccounts)
    qc.setQueryData(['investments', 'holdings'], mockHoldings)
  }
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return wrapper
}

describe('InvestmentsScreen', () => {
  it('renders accounts and holdings', async () => {
    const { getByText, getByTestId } = render(<InvestmentsScreen />, { wrapper: makeWrapper(true) })

    // Wait for AsyncStorage privacy load + render
    await waitFor(() => expect(getByText('Robinhood')).toBeTruthy(), { timeout: 2000 })
    expect(getByTestId('holding-row-AAPL')).toBeTruthy()
    expect(getByTestId('holding-row-TSLA')).toBeTruthy()
  })

  it('hides values by default (privacy mode)', async () => {
    const { getAllByText } = render(<InvestmentsScreen />, { wrapper: makeWrapper(true) })

    await waitFor(() => {
      const masked = getAllByText('••••••')
      expect(masked.length).toBeGreaterThan(0)
    }, { timeout: 2000 })
  })

  it('reveals values when eye toggle is pressed', async () => {
    const { getByTestId, queryAllByText } = render(<InvestmentsScreen />, { wrapper: makeWrapper(true) })

    await waitFor(() => expect(getByTestId('eye-toggle')).toBeTruthy(), { timeout: 2000 })
    fireEvent.press(getByTestId('eye-toggle'))
    expect(queryAllByText('••••••').length).toBe(0)
  })

  it('shows empty state when no accounts', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
    })
    qc.setQueryData(['investments', 'accounts'], [])
    qc.setQueryData(['investments', 'holdings'], [])

    const { getByText } = render(
      <QueryClientProvider client={qc}><InvestmentsScreen /></QueryClientProvider>
    )

    await waitFor(
      () => expect(getByText(/No brokerage accounts connected/)).toBeTruthy(),
      { timeout: 2000 }
    )
  })
})
