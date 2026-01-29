import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { authApi, familyApi } from '../services/api'
import toast from 'react-hot-toast'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
            auto_select?: boolean
          }) => void
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: 'outline' | 'filled_blue' | 'filled_black'
              size?: 'large' | 'medium' | 'small'
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
              shape?: 'rectangular' | 'pill' | 'circle' | 'square'
              width?: number
            }
          ) => void
          prompt: () => void
        }
      }
    }
  }
}

export default function Login() {
  const navigate = useNavigate()
  const { login, isAuthenticated, setFamily, setFamilyMembers } = useAuthStore()

  const handleGoogleCallback = useCallback(
    async (response: { credential: string }) => {
      try {
        const authResponse = await authApi.googleLogin(response.credential, 'id_token')
        login(authResponse.access_token, authResponse.user)

        // If user has a family, fetch it
        if (authResponse.user.family_id) {
          try {
            const familyData = await familyApi.get(authResponse.user.family_id)
            setFamily(familyData)
            setFamilyMembers(familyData.members)
          } catch (err) {
            console.error('Failed to fetch family:', err)
          }
        }

        toast.success(`Welcome, ${authResponse.user.display_name}!`)
        navigate('/')
      } catch (error) {
        console.error('Login failed:', error)
        toast.error('Login failed. Please try again.')
      }
    },
    [login, navigate, setFamily, setFamilyMembers]
  )

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/')
      return
    }

    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

    if (!clientId) {
      console.error('Google Client ID not configured')
      return
    }

    // Initialize Google Sign-In
    const initializeGoogleSignIn = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleCallback,
        })

        const buttonDiv = document.getElementById('google-signin-button')
        if (buttonDiv) {
          window.google.accounts.id.renderButton(buttonDiv, {
            theme: 'filled_blue',
            size: 'large',
            text: 'continue_with',
            shape: 'rectangular',
            width: 280,
          })
        }
      }
    }

    // Check if script is already loaded
    if (window.google) {
      initializeGoogleSignIn()
    } else {
      // Wait for script to load
      const checkGoogle = setInterval(() => {
        if (window.google) {
          clearInterval(checkGoogle)
          initializeGoogleSignIn()
        }
      }, 100)

      return () => clearInterval(checkGoogle)
    }
  }, [isAuthenticated, navigate, handleGoogleCallback])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-500 to-primary-700 px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">💰</div>
          <h1 className="text-2xl font-bold text-gray-900">Family Expense Tracker</h1>
          <p className="text-gray-600 mt-2">
            Track, budget, and manage your family's expenses together
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4">
            <div id="google-signin-button" className="flex justify-center"></div>
          </div>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">Features</span>
            </div>
          </div>

          <ul className="space-y-3 text-sm text-gray-600">
            <li className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              Track daily expenses with categories
            </li>
            <li className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              Create and manage family budgets
            </li>
            <li className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              Tag expenses by family member
            </li>
            <li className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              Get budget alerts and insights
            </li>
            <li className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              Share expenses with family members
            </li>
          </ul>
        </div>

        <p className="text-xs text-gray-500 text-center mt-8">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
