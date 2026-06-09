import { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native'
import { router } from 'expo-router'
import { useGoogleAuth } from '@/hooks/useAuth'
import { authApi, familyApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'

export default function LoginScreen() {
  const [loading, setLoading] = useState(false)
  const { signIn } = useGoogleAuth()
  const { setUser, setFamily, setFamilyMembers, user } = useAuthStore()

  const handleGoogleSignIn = async () => {
    setLoading(true)
    try {
      await signIn()
      router.replace('/(tabs)')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed'
      if (msg !== 'Sign-in cancelled') {
        Alert.alert('Sign-in failed', msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.emoji}>💰</Text>
        <Text style={styles.title}>Family Expense Tracker</Text>
        <Text style={styles.subtitle}>
          Track spending, manage budgets, and monitor investments together.
        </Text>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleGoogleSignIn}
          disabled={loading}
          testID="google-sign-in-button"
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.buttonIcon}>G</Text>
              <Text style={styles.buttonText}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.disclaimer}>
          Sign in with the same Google account you use on the web app.
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#2563eb',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingTop: 100,
    paddingBottom: 60,
  },
  header: {
    alignItems: 'center',
  },
  emoji: {
    fontSize: 72,
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#bfdbfe',
    textAlign: 'center',
    lineHeight: 24,
  },
  footer: {
    gap: 16,
  },
  button: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonIcon: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2563eb',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e3a8a',
  },
  disclaimer: {
    fontSize: 13,
    color: '#bfdbfe',
    textAlign: 'center',
    lineHeight: 20,
  },
})
