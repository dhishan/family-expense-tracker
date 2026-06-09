import { useCallback, useEffect, useState } from 'react'
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin'
import { useAuthStore } from '../store/auth'
import { authApi, familyApi } from '../services/api'

// Use the iOS client for native sign-in. Fall back to the web client only
// because expo-auth-session used to require it; the native module needs the
// iOS client when running on iOS, Android client when running on Android.
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? ''
const WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ??
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ??
  ''

// Configure once at module load — happens before any sign-in attempt.
// The native SDK opens Google's bottom-sheet auth UI and returns an
// id_token directly (no implicit-grant deprecation issues, no URL-scheme
// redirect race conditions, no Safari hop).
GoogleSignin.configure({
  iosClientId: IOS_CLIENT_ID,
  // webClientId is also accepted by the SDK for OIDC audience purposes
  // even on iOS — set it if available so the id_token can be validated
  // against the web client when the backend prefers that audience.
  webClientId: WEB_CLIENT_ID || undefined,
  scopes: ['openid', 'profile', 'email'],
  offlineAccess: false,
})

export function useGoogleAuth() {
  const { setToken, setUser, setFamily, setFamilyMembers } = useAuthStore()
  const [signingIn, setSigningIn] = useState(false)

  const signIn = useCallback(async () => {
    try {
      setSigningIn(true)
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: false })
      const userInfo = await GoogleSignin.signIn()

      // SDK v13+ returns { type: 'success', data: { idToken, user } }
      // older versions returned { idToken, user } directly. Handle both.
      const idToken =
        // v13+ shape
        (userInfo as unknown as { data?: { idToken?: string } })?.data?.idToken ??
        // older shape
        (userInfo as unknown as { idToken?: string })?.idToken

      if (!idToken) {
        throw new Error('Google returned a user but no idToken — check that the iOS OAuth client bundle ID matches.')
      }

      const authResponse = await authApi.googleLogin(idToken, 'id_token')

      await setToken(authResponse.access_token)
      setUser(authResponse.user)

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
    } catch (err) {
      // Map common errors to clean messages
      const e = err as { code?: string; message?: string }
      if (e.code === statusCodes.SIGN_IN_CANCELLED) throw new Error('Sign-in cancelled')
      if (e.code === statusCodes.IN_PROGRESS) throw new Error('Sign-in already in progress')
      if (e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE)
        throw new Error('Google Play services unavailable')
      throw err
    } finally {
      setSigningIn(false)
    }
  }, [setToken, setUser, setFamily, setFamilyMembers])

  return { signIn, signingIn }
}

// keep useEffect import used for backwards-compat in case other code referenced it
void useEffect
