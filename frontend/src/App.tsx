import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import { familyApi } from './services/api'
import Layout from './components/Layout/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import Budgets from './pages/Budgets'
import Settings from './pages/Settings'
import Investments from './pages/Investments'
import Chat from './pages/Chat'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user, family, setFamily, setFamilyMembers } = useAuthStore()

  // Re-fetch family on mount if authenticated but family not loaded (e.g. after page refresh)
  useEffect(() => {
    if (isAuthenticated && user?.family_id && !family) {
      familyApi.get(user.family_id)
        .then((familyData) => {
          setFamily(familyData)
          setFamilyMembers(familyData.members)
        })
        .catch(() => {}) // stale family_id — ignore, Settings will show create form
    }
  }, [isAuthenticated, user?.family_id, family, setFamily, setFamilyMembers])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="expenses" element={<Navigate to="/transactions" replace />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="budgets" element={<Budgets />} />
        <Route path="settings" element={<Settings />} />
        <Route path="investments" element={<Investments />} />
        <Route path="chat" element={<Chat />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
