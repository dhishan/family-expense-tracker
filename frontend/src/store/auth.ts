import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Family, FamilyMember } from '../types'

interface AuthState {
  user: User | null
  family: Family | null
  familyMembers: FamilyMember[]
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  
  // Actions
  setUser: (user: User | null) => void
  setFamily: (family: Family | null) => void
  setFamilyMembers: (members: FamilyMember[]) => void
  setToken: (token: string | null) => void
  login: (token: string, user: User) => void
  logout: () => void
  setLoading: (loading: boolean) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      family: null,
      familyMembers: [],
      token: null,
      isAuthenticated: false,
      isLoading: true,

      setUser: (user) => set({ user }),
      
      setFamily: (family) => set({ family }),
      
      setFamilyMembers: (members) => set({ familyMembers: members }),
      
      setToken: (token) => set({ token }),
      
      login: (token, user) =>
        set({
          token,
          user,
          isAuthenticated: true,
          isLoading: false,
        }),
      
      logout: () =>
        set({
          user: null,
          family: null,
          familyMembers: [],
          token: null,
          isAuthenticated: false,
          isLoading: false,
        }),
      
      setLoading: (loading) => set({ isLoading: loading }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setLoading(false)
        }
      },
    }
  )
)
