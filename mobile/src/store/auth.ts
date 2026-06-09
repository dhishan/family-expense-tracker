import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import type { User, Family, FamilyMember } from '../types'

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
      const token = await SecureStore.getItemAsync('jwt_token')
      set({ token, isLoading: false })
      return token
    } catch {
      set({ isLoading: false })
      return null
    }
  },
}))
