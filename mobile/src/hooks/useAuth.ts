import { useCallback } from 'react'
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { useAuthStore } from '../store/auth'
import { authApi, familyApi } from '../services/api'

WebBrowser.maybeCompleteAuthSession()

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? ''

export function useGoogleAuth() {
  const { setToken, setUser, setFamily, setFamilyMembers } = useAuthStore()

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: GOOGLE_CLIENT_ID,
    iosClientId: GOOGLE_CLIENT_ID,
    androidClientId: GOOGLE_CLIENT_ID,
    scopes: ['openid', 'profile', 'email'],
  })

  const signIn = useCallback(async () => {
    const result = await promptAsync()
    if (result?.type !== 'success') {
      throw new Error(result?.type === 'cancel' ? 'Sign-in cancelled' : 'Sign-in failed')
    }

    const idToken = result.authentication?.idToken
    const accessToken = result.authentication?.accessToken

    if (!idToken && !accessToken) {
      throw new Error('No token returned from Google')
    }

    // Exchange with backend
    const authResponse = await authApi.googleLogin(
      idToken ?? accessToken!,
      idToken ? 'id_token' : 'access_token'
    )

    await setToken(authResponse.access_token)
    setUser(authResponse.user)

    // Load family if user has one
    if (authResponse.user.family_id) {
      try {
        const family = await familyApi.get(authResponse.user.family_id)
        setFamily(family)
        setFamilyMembers(family.members)
      } catch {
        // non-critical
      }
    }

    return authResponse.user
  }, [promptAsync, setToken, setUser, setFamily, setFamilyMembers])

  return { request, response, signIn }
}
