import { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Linking,
  Switch,
  TextInput,
  ActivityIndicator,
} from 'react-native'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as SecureStore from 'expo-secure-store'
import { useAuthStore } from '@/store/auth'
import { authApi, plaidApi, investmentsApi } from '@/services/api'
import type { InvestmentAccount } from '@/types'
import { create, open } from 'react-native-plaid-link-sdk'
import type { PlaidItem } from '@/types'

const PLAID_LINK_TOKEN_KEY = 'plaid_link_token'

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface BankCardProps {
  item: PlaidItem
  currentUserId: string
  onRename: (id: string, name: string) => void
  onReconnect: (id: string) => void
  onDisconnect: (id: string, name: string) => void
}

function BankCard({ item, currentUserId, onRename, onReconnect, onDisconnect }: BankCardProps) {
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState(item.institution_name)

  const handleRenameConfirm = () => {
    if (nameInput.trim() && nameInput.trim() !== item.institution_name) {
      onRename(item.id, nameInput.trim())
    }
    setEditing(false)
  }

  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.topRow}>
        <Text style={cardStyles.icon}>🏦</Text>
        {editing ? (
          <View style={cardStyles.renameRow}>
            <TextInput
              style={cardStyles.renameInput}
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              onSubmitEditing={handleRenameConfirm}
            />
            <TouchableOpacity onPress={handleRenameConfirm} style={cardStyles.confirmBtn}>
              <Text style={cardStyles.confirmText}>✓</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={cardStyles.institutionName}>{item.institution_name}</Text>
        )}
        {item.status === 'needs_reauth' && (
          <View style={cardStyles.reAuthBadge}>
            <Text style={cardStyles.reAuthText}>Needs reauth</Text>
          </View>
        )}
      </View>
      <Text style={cardStyles.meta}>
        {item.accounts.length} account{item.accounts.length !== 1 ? 's' : ''}
        {item.last_synced_at ? ` · last sync ${formatTimeAgo(item.last_synced_at)}` : ''}
      </Text>

      <View style={cardStyles.actions}>
        <TouchableOpacity
          style={cardStyles.actionBtn}
          onPress={() => setEditing(true)}
          testID={`rename-item-${item.id}`}
        >
          <Text style={cardStyles.actionText}>Rename</Text>
        </TouchableOpacity>
        {item.status === 'needs_reauth' && (
          <TouchableOpacity
            style={[cardStyles.actionBtn, cardStyles.actionBtnWarning]}
            onPress={() => onReconnect(item.id)}
            testID={`reconnect-item-${item.id}`}
          >
            <Text style={[cardStyles.actionText, cardStyles.actionTextWarning]}>Reconnect</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[cardStyles.actionBtn, cardStyles.actionBtnDanger]}
          onPress={() => onDisconnect(item.id, item.institution_name)}
          testID={`disconnect-item-${item.id}`}
        >
          <Text style={[cardStyles.actionText, cardStyles.actionTextDanger]}>Disconnect</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginTop: 0,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  icon: { fontSize: 20, marginRight: 8 },
  institutionName: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  reAuthBadge: {
    backgroundColor: '#fef3c7',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 8,
  },
  reAuthText: { fontSize: 11, color: '#92400e', fontWeight: '600' },
  meta: { fontSize: 12, color: '#6b7280', marginBottom: 10 },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
  },
  actionBtnWarning: { borderColor: '#fbbf24', backgroundColor: '#fffbeb' },
  actionBtnDanger: { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  actionText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  actionTextWarning: { color: '#92400e' },
  actionTextDanger: { color: '#dc2626' },
  renameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  renameInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 15,
    color: '#111827',
  },
  confirmBtn: { padding: 6 },
  confirmText: { fontSize: 16, color: '#16a34a', fontWeight: '700' },
})

export default function SettingsScreen() {
  const { user, family, logout } = useAuthStore()
  const appVersion = Constants.expoConfig?.version ?? '1.0.0'
  // Semver build stamp baked at publish time via `git describe`. Example:
  // "1.0.17" at a release, "1.0.17+3.a1b2c3d" for an OTA 3 commits past it.
  // Falls back to the app.json version for local dev / unstamped builds.
  const buildVersion = process.env.EXPO_PUBLIC_OTA_VERSION || appVersion
  const otaLabel = Updates.isEmbeddedLaunch
    ? 'Embedded (no OTA yet)'
    : `${(Updates.updateId ?? '').slice(0, 8)}${
        Updates.createdAt ? ` · ${Updates.createdAt.toLocaleDateString()}` : ''
      }`
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const queryClient = useQueryClient()
  const [connectingBank, setConnectingBank] = useState(false)
  const [connectingBrokerage, setConnectingBrokerage] = useState(false)

  const handleCheckUpdate = async () => {
    if (!Updates.isEnabled) {
      Alert.alert('Updates', 'OTA updates are not available in this build.')
      return
    }
    setCheckingUpdate(true)
    try {
      const res = await Updates.checkForUpdateAsync()
      if (!res.isAvailable) {
        Alert.alert('Up to date', 'You are running the latest version.')
        return
      }
      await Updates.fetchUpdateAsync()
      Alert.alert('Update ready', 'Restart now to apply the update?', [
        { text: 'Later', style: 'cancel' },
        { text: 'Restart', onPress: () => void Updates.reloadAsync() },
      ])
    } catch (e) {
      Alert.alert('Update check failed', String(e))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['plaid', 'items'],
    queryFn: () => plaidApi.listItems(),
    enabled: !!user?.family_id,
  })

  const { data: brokerageAccountsData, isLoading: brokerageLoading } = useQuery({
    queryKey: ['investments', 'accounts'],
    queryFn: () => investmentsApi.accounts(),
    enabled: !!user?.family_id,
  })

  const { data: brokerageConnsData } = useQuery({
    queryKey: ['investments', 'connections'],
    queryFn: () => investmentsApi.listConnections(),
    enabled: !!user?.family_id,
  })
  const brokerageConns = brokerageConnsData?.connections ?? []

  const shareMutation = useMutation({
    mutationFn: ({ authorizationId, shared }: { authorizationId: string; shared: boolean }) =>
      investmentsApi.updateConnectionShare(authorizationId, shared),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments', 'connections'] })
      queryClient.invalidateQueries({ queryKey: ['investments', 'accounts'] })
    },
    onError: () => Alert.alert('Error', 'Failed to update sharing.'),
  })

  const deregisterMutation = useMutation({
    mutationFn: () => investmentsApi.deregister(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments'] })
      Alert.alert('Disconnected', 'All brokerages disconnected.')
    },
    onError: () => Alert.alert('Error', 'Failed to disconnect brokerages.'),
  })

  const handleConnectBrokerage = async () => {
    try {
      setConnectingBrokerage(true)
      await investmentsApi.register()
      const { redirectURI } = await investmentsApi.connect(null)
      await Linking.openURL(redirectURI)
      Alert.alert(
        'Brokerage connection started',
        'Complete the link in your browser, then pull to refresh this screen.',
      )
    } catch (err: unknown) {
      // Surface backend's user-facing detail when present (e.g. SnapTrade
      // Personal-plan limit returns 409 with a clear message).
      let title = 'Error'
      let body = 'Failed to start brokerage connection.'
      const e = err as { response?: { status?: number; data?: { detail?: string } } }
      const detail = e?.response?.data?.detail
      if (e?.response?.status === 409 && detail) {
        title = 'Family brokerage limit'
        body = detail
      } else if (detail) {
        body = detail
      }
      Alert.alert(title, body)
    } finally {
      setConnectingBrokerage(false)
    }
  }

  const handleDisconnectAllBrokerages = () => {
    Alert.alert(
      'Disconnect all brokerages?',
      "SnapTrade doesn't support per-brokerage disconnect yet — this removes ALL linked brokerages. You'll need to reconnect each one.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect all',
          style: 'destructive',
          onPress: () => deregisterMutation.mutate(),
        },
      ],
    )
  }

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => plaidApi.renameItem(id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] }),
    onError: () => Alert.alert('Error', 'Failed to rename account.'),
  })

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => plaidApi.disconnectItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
    },
    onError: () => Alert.alert('Error', 'Failed to disconnect account.'),
  })

  const handleConnectBank = async () => {
    try {
      setConnectingBank(true)
      const { link_token } = await plaidApi.createLinkToken({ platform: 'mobile' })
      // Persist token in SecureStore (Keychain on iOS, Keystore on Android) so
      // it isn't readable by other apps with shared filesystem access.
      await SecureStore.setItemAsync(PLAID_LINK_TOKEN_KEY, link_token)
      create({ token: link_token })
      open({
        onSuccess: async (success: { publicToken: string }) => {
          try {
            await SecureStore.deleteItemAsync(PLAID_LINK_TOKEN_KEY).catch(() => {})
            await plaidApi.exchangePublicToken(success.publicToken)
            queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
            queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
          } catch {
            Alert.alert('Error', 'Failed to link bank account.')
          }
        },
        onExit: (_exit: unknown) => {
          // user dismissed — keep token in storage in case they resume via OAuth
        },
      })
    } catch {
      Alert.alert('Error', 'Failed to start bank connection.')
    } finally {
      setConnectingBank(false)
    }
  }

  const handleReconnect = async (id: string) => {
    try {
      const { link_token } = await plaidApi.reconnectItem(id)
      create({ token: link_token })
      open({
        onSuccess: async (_success: { publicToken: string }) => {
          queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
          queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
        },
        onExit: (_exit: unknown) => {},
      })
    } catch {
      Alert.alert('Error', 'Failed to start reconnect.')
    }
  }

  const handleDisconnect = (id: string, name: string) => {
    Alert.alert(
      `Disconnect ${name}?`,
      'Pending items from this connection will also be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => disconnectMutation.mutate(id),
        },
      ]
    )
  }

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
            // ignore
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

  const items = itemsData?.items ?? []

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

      {/* Connections — Banks & Cards (Plaid) + Brokerages (SnapTrade) */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connections</Text>

        {/* Banks & Cards */}
        <Text style={styles.subSectionTitle}>Banks & Cards</Text>
        <Text style={styles.subSectionHint}>Drives expenses & pending transactions (Plaid)</Text>
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={handleConnectBank}
          disabled={connectingBank}
          testID="connect-bank-btn"
        >
          {connectingBank ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Text style={styles.connectBtnText}>+ Connect a bank</Text>
          )}
        </TouchableOpacity>
        {itemsLoading ? (
          <ActivityIndicator size="small" color="#9ca3af" style={{ margin: 16 }} />
        ) : items.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.rowValue}>No connected banks</Text>
          </View>
        ) : (
          items.map((item) => (
            <BankCard
              key={item.id}
              item={item}
              currentUserId={user?.id ?? ''}
              onRename={(id, name) => renameMutation.mutate({ id, name })}
              onReconnect={handleReconnect}
              onDisconnect={handleDisconnect}
            />
          ))
        )}

        {/* Brokerages */}
        <Text style={[styles.subSectionTitle, { marginTop: 20 }]}>Brokerages</Text>
        <Text style={styles.subSectionHint}>Drives Investments & portfolio analysis (SnapTrade)</Text>
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={handleConnectBrokerage}
          disabled={connectingBrokerage}
          testID="connect-brokerage-btn"
        >
          {connectingBrokerage ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Text style={styles.connectBtnText}>+ Connect a brokerage</Text>
          )}
        </TouchableOpacity>
        {brokerageLoading ? (
          <ActivityIndicator size="small" color="#9ca3af" style={{ margin: 16 }} />
        ) : (brokerageAccountsData?.length ?? 0) === 0 ? (
          <View style={styles.row}>
            <Text style={styles.rowValue}>No connected brokerages</Text>
          </View>
        ) : (
          <>
            {(brokerageAccountsData ?? []).map((acc: InvestmentAccount) => (
              <View key={acc.id} style={styles.bankCard}>
                <Text style={styles.bankName}>{acc.institution_name || acc.name}</Text>
                <Text style={styles.bankSubtitle}>
                  {acc.name}{acc.number ? ` · ${acc.number}` : ''}
                </Text>
              </View>
            ))}

            {/* Owner-only family share toggles */}
            {brokerageConns.filter((c) => c.is_owner).length > 0 && (
              <View style={{ paddingHorizontal: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f3f4f6' }}>
                <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                  Share my brokerages with family
                </Text>
                {brokerageConns
                  .filter((c) => c.is_owner)
                  .map((c) => (
                    <View
                      key={c.authorization_id}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingVertical: 6,
                      }}
                    >
                      <Text style={{ fontSize: 14, color: '#374151', flex: 1 }} numberOfLines={1}>
                        {c.brokerage || 'Brokerage'}{' '}
                        <Text style={{ fontSize: 11, color: '#9ca3af' }}>
                          · {c.authorization_id.slice(0, 8)}…
                        </Text>
                      </Text>
                      <Switch
                        value={c.shared_with_family}
                        onValueChange={(v) =>
                          shareMutation.mutate({
                            authorizationId: c.authorization_id,
                            shared: v,
                          })
                        }
                      />
                    </View>
                  ))}
              </View>
            )}

            <TouchableOpacity
              onPress={handleDisconnectAllBrokerages}
              style={{ alignSelf: 'flex-start', marginTop: 8, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 12, color: '#9ca3af', textDecorationLine: 'underline' }}>
                Disconnect all brokerages
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Automation */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Automation</Text>
        <TouchableOpacity
          style={styles.linkRow}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onPress={() => router.push('/auto-rules' as any)}
          testID="auto-rules-link"
        >
          <Text style={styles.linkText}>Auto-Rules</Text>
          <Text style={styles.linkArrow}>→</Text>
        </TouchableOpacity>
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onPress={() => router.push('/debug' as any)}
        >
          <Text style={styles.linkText}>Debug logs</Text>
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
          <Text style={styles.rowLabel}>Build</Text>
          <Text style={styles.rowValue}>{buildVersion}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Update</Text>
          <Text style={styles.rowValue}>{otaLabel}</Text>
        </View>
        <Text style={styles.subtext}>
          Runtime {Updates.runtimeVersion ?? '-'} · channel {Updates.channel ?? '-'}
        </Text>
        <TouchableOpacity
          style={styles.updateBtn}
          onPress={handleCheckUpdate}
          disabled={checkingUpdate}
          testID="check-updates-btn"
        >
          {checkingUpdate ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Text style={styles.updateBtnText}>Check for updates</Text>
          )}
        </TouchableOpacity>
        <View style={[styles.row, { marginTop: 12 }]}>
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
  subSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  subSectionHint: {
    fontSize: 12,
    color: '#9ca3af',
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  bankCard: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  bankName: { fontSize: 15, fontWeight: '500', color: '#111827' },
  bankSubtitle: { fontSize: 13, color: '#6b7280', marginTop: 2 },
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
  connectBtn: {
    margin: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderStyle: 'dashed',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
  },
  connectBtnText: { fontSize: 15, color: '#2563eb', fontWeight: '600' },
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
  subtext: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  updateBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  updateBtnText: { color: '#2563eb', fontWeight: '600', fontSize: 14 },
})
