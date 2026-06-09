/**
 * Auth flow tests
 * Mocks: expo-secure-store, expo-auth-session, axios
 */
import React from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react-native'
import { Alert } from 'react-native'

// ─── Mock expo modules before imports ─────────────────────────────────────────
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: jest.fn(() => [
    {},
    null,
    jest.fn().mockResolvedValue({
      type: 'success',
      authentication: { idToken: 'mock-id-token', accessToken: null },
    }),
  ]),
}))

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
}))

jest.mock('expo-router', () => ({
  router: { replace: jest.fn() },
}))

jest.mock('@/services/api', () => ({
  authApi: {
    googleLogin: jest.fn().mockResolvedValue({
      access_token: 'mock-jwt',
      token_type: 'bearer',
      user: {
        id: 'user-1',
        email: 'test@example.com',
        display_name: 'Test User',
        photo_url: null,
        family_id: 'family-1',
        created_at: '2025-01-01',
        updated_at: '2025-01-01',
      },
    }),
    logout: jest.fn().mockResolvedValue(undefined),
  },
  familyApi: {
    get: jest.fn().mockResolvedValue({
      id: 'family-1',
      name: 'Test Family',
      categories: [],
      beneficiary_labels: {},
      members: [],
      invite_code: 'ABC123',
      created_at: '2025-01-01',
      created_by: 'user-1',
    }),
  },
}))

import LoginScreen from '../app/login'
import * as SecureStore from 'expo-secure-store'
import { router } from 'expo-router'
import { authApi } from '@/services/api'

describe('LoginScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders sign-in button', () => {
    const { getByTestId } = render(<LoginScreen />)
    expect(getByTestId('google-sign-in-button')).toBeTruthy()
  })

  it('calls googleLogin and stores JWT on success', async () => {
    const { getByTestId } = render(<LoginScreen />)
    const btn = getByTestId('google-sign-in-button')

    await act(async () => {
      fireEvent.press(btn)
    })

    await waitFor(() => {
      expect(authApi.googleLogin).toHaveBeenCalledWith('mock-id-token', 'id_token')
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith('jwt_token', 'mock-jwt')
      expect(router.replace).toHaveBeenCalledWith('/(tabs)')
    })
  })

  it('shows alert on sign-in error', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert')
    ;(authApi.googleLogin as jest.Mock).mockRejectedValueOnce(new Error('network error'))

    const { getByTestId } = render(<LoginScreen />)
    await act(async () => {
      fireEvent.press(getByTestId('google-sign-in-button'))
    })

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Sign-in failed', 'network error')
    })
  })
})

describe('Auth store', () => {
  it('loads token from SecureStore', async () => {
    ;(SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('stored-jwt')
    const { useAuthStore } = require('@/store/auth')
    const store = useAuthStore.getState()
    const token = await store.loadToken()
    expect(token).toBe('stored-jwt')
  })

  it('logout clears token', async () => {
    const { useAuthStore } = require('@/store/auth')
    const store = useAuthStore.getState()
    await store.logout()
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('jwt_token')
    expect(useAuthStore.getState().token).toBeNull()
  })
})
