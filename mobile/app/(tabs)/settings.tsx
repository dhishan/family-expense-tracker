import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Linking,
} from 'react-native'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/services/api'

export default function SettingsScreen() {
  const { user, family, logout } = useAuthStore()
  const appVersion = Constants.expoConfig?.version ?? '1.0.0'

  const handleSignOut = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          try {
            await authApi.logout()
          } catch {
            // ignore — backend session cleanup is best-effort
          }
          await logout()
          router.replace('/login')
        },
      },
    ])
  }

  const openWebApp = () => {
    Linking.openURL('https://ui.expense-tracker.blueelephants.org')
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.screenTitle}>Settings</Text>

      {/* Profile */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Name</Text>
          <Text style={styles.rowValue}>{user?.display_name ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Email</Text>
          <Text style={styles.rowValue}>{user?.email ?? '—'}</Text>
        </View>
        {family && (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Family</Text>
            <Text style={styles.rowValue}>{family.name}</Text>
          </View>
        )}
      </View>

      {/* Links */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>More</Text>
        <TouchableOpacity style={styles.linkRow} onPress={openWebApp}>
          <Text style={styles.linkText}>Open web app</Text>
          <Text style={styles.linkArrow}>→</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.linkRow}
          onPress={() => Linking.openURL('https://ui.expense-tracker.blueelephants.org/investments')}
        >
          <Text style={styles.linkText}>Link brokerage account (web)</Text>
          <Text style={styles.linkArrow}>→</Text>
        </TouchableOpacity>
      </View>

      {/* App info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Version</Text>
          <Text style={styles.rowValue}>{appVersion}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>API</Text>
          <Text style={styles.rowValue}>
            {process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://api.expense-tracker.blueelephants.org'}
          </Text>
        </View>
      </View>

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} testID="sign-out-btn">
        <Text style={styles.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { paddingBottom: 40 },
  screenTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginBottom: 16,
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    padding: 12,
    paddingBottom: 4,
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  rowLabel: { fontSize: 15, color: '#374151' },
  rowValue: { fontSize: 15, color: '#6b7280', maxWidth: '60%', textAlign: 'right' },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  linkText: { fontSize: 15, color: '#2563eb' },
  linkArrow: { fontSize: 15, color: '#9ca3af' },
  signOutBtn: {
    marginHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fecaca',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  signOutText: { fontSize: 16, color: '#dc2626', fontWeight: '600' },
})
