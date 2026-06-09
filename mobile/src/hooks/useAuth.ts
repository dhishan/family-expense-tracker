import { useCallback } from 'react'
import * as Google from 'expo-auth-session/providers/google'
import * as WebBrowser from 'expo-web-browser'
import { useAuthStore } from '../store/auth'
import { authApi, familyApi } from '../services/api'

WebBrowser.maybeCompleteAuthSession()

// Platform-specific OAuth clients. The Web client is used by expo-auth-session
// internally for the OpenID discovery + browser; the iOS/Android clients are
// what Google actually validates against based on the bundle ID / package name.
// Create separate clients in GCP Console with "iOS" and "Android" types and
// the app's bundleIdentifier / package (org.blueelephants.familyexpensetracker).
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? ''
const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? ''
const WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ??
  // Backwards-compat: older configs used a single var.
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ??
  ''

export function useGoogleAuth() {
  const { setToken, setUser, setFamily, setFamilyMembers } = useAuthStore()

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: WEB_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID || WEB_CLIENT_ID,
    androidClientId: ANDROID_CLIENT_ID || WEB_CLIENT_ID,
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
