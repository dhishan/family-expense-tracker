import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import { GoogleSignin } from '@react-native-google-signin/google-signin'
import type { User, Family, FamilyMember } from '../types'

// Lazy require so this module doesn't depend on the api module load order.
const fetchMe = async (token: string): Promise<User | null> => {
  const { authApi } = await import('../services/api')
  // authApi.getCurrentUser uses the axios JWT interceptor which reads the
  // store. The store hasn't been updated with the new token yet, so pass
  // it explicitly via a one-off call. Falling back to direct fetch.
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
  const r = await fetch(`${base}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`/auth/me ${r.status}`)
  return (await r.json()) as User
}

interface AuthState {
  token: string | null
  user: User | null
  family: Family | null
  familyMembers: FamilyMember[]
  isLoading: boolean

  setToken: (token: string) => Promise<void>
  setUser: (user: User) => void
  setFamily: (family: Family | null) => void
  setFamilyMembers: (members: FamilyMember[]) => void
  logout: () => Promise<void>
  loadToken: () => Promise<string | null>
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  family: null,
  familyMembers: [],
  isLoading: true,

  setToken: async (token: string) => {
    await SecureStore.setItemAsync('jwt_token', token)
    set({ token })
  },

  setUser: (user: User) => set({ user }),

  setFamily: (family: Family | null) => set({ family }),

  setFamilyMembers: (members: FamilyMember[]) => set({ familyMembers: members }),

  logout: async () => {
    await SecureStore.deleteItemAsync('jwt_token').catch(() => {})
    set({ token: null, user: null, family: null, familyMembers: [] })
  },

  loadToken: async () => {
    try {
      // 1. Try to restore the JWT from the keychain
      const token = await SecureStore.getItemAsync('jwt_token')
      if (token) {
        try {
          const user = await fetchMe(token)
          if (user) {
            set({ token, user, isLoading: false })
            return token
          }
        } catch {
          // Token expired or invalid; fall through to silent Google
        }
      }

      // 2. Token missing or rejected — try silent Google sign-in. Works if
      //    the user previously signed in on THIS device (Google caches the
      //    account choice in iOS Keychain at the OS level, not the app's
      //    keychain — so it survives reinstalls of our bundle ID).
      try {
        const userInfo = await GoogleSignin.signInSilently()
        const idToken =
          (userInfo as unknown as { data?: { idToken?: string } })?.data?.idToken ??
          (userInfo as unknown as { idToken?: string })?.idToken
        if (idToken) {
          const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
          const r = await fetch(`${base}/api/v1/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: idToken, token_type: 'id_token' }),
          })
          if (r.ok) {
            const auth = await r.json() as { access_token: string; user: User }
            await SecureStore.setItemAsync('jwt_token', auth.access_token)
            set({ token: auth.access_token, user: auth.user, isLoading: false })
            return auth.access_token
          }
        }
      } catch {
        // No cached Google session — user has to sign in manually
      }

      set({ isLoading: false })
      return null
    } catch {
      set({ isLoading: false })
      return null
    }
  },
}))
