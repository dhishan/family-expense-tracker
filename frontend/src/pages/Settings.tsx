import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import {
  ClipboardDocumentIcon,
  ArrowPathIcon,
  UserPlusIcon,
  PlusIcon,
  XMarkIcon,
  PencilIcon,
  BanknotesIcon,
  ExclamationTriangleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { familyApi, plaidApi, investmentsApi } from '../services/api'
import type { InvestmentAccount } from '../services/api'
import { useAuthStore } from '../store/auth'
import { usePlaidLink } from 'react-plaid-link'
import type { PlaidItem } from '../types'

// ---------------------------------------------------------------------------
// Banks & Cards sub-component (Plaid)
// ---------------------------------------------------------------------------

function BanksAndCards() {
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [reconnectToken, setReconnectToken] = useState<string | null>(null)
  const [disconnectConfirmId, setDisconnectConfirmId] = useState<string | null>(null)
  // IDs of newly connected items whose initial sync is still running
  const [syncingItemIds, setSyncingItemIds] = useState<Set<string>>(new Set())

  const { data } = useQuery({
    queryKey: ['plaid', 'items'],
    queryFn: plaidApi.listItems,
    enabled: !!user?.family_id,
    // Poll while any item is still syncing (cap: ~60s of 3s intervals = 20 rounds)
    refetchInterval: syncingItemIds.size > 0 ? 3000 : false,
  })

  // Remove items from syncing set once last_synced_at becomes non-null
  useEffect(() => {
    if (!data || syncingItemIds.size === 0) return
    const stillSyncing = new Set<string>()
    for (const id of syncingItemIds) {
      const item = data.items.find((i: PlaidItem) => i.id === id)
      if (item && !item.last_synced_at) {
        stillSyncing.add(id)
      }
    }
    if (stillSyncing.size !== syncingItemIds.size) {
      setSyncingItemIds(stillSyncing)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const items = data?.items ?? []

  // Plaid Link for new connection
  const { open: openLink, ready } = usePlaidLink({
    token: linkToken || '',
    onSuccess: async (public_token) => {
      try {
        const result = await plaidApi.exchangePublicToken(public_token)
        queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
        queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
        toast.success('Bank connected!')
        // If sync is still running server-side, mark this item for polling
        if (result.sync_status === 'pending') {
          setSyncingItemIds((prev) => new Set([...prev, result.plaid_item_id]))
          // Safety cap: stop polling after 60s regardless
          setTimeout(() => {
            setSyncingItemIds((prev) => {
              const next = new Set(prev)
              next.delete(result.plaid_item_id)
              return next
            })
          }, 60_000)
        }
      } catch {
        toast.error('Failed to connect bank')
      }
      setLinkToken(null)
    },
    onExit: () => setLinkToken(null),
  })

  // Plaid Link for reconnect (update mode)
  const { open: openReconnectLink, ready: reconnectReady } = usePlaidLink({
    token: reconnectToken || '',
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
      toast.success('Bank reconnected!')
      setReconnectToken(null)
    },
    onExit: () => setReconnectToken(null),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      plaidApi.renameItem(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
      setRenamingId(null)
      toast.success('Renamed!')
    },
    onError: () => toast.error('Failed to rename'),
  })

  const disconnectMutation = useMutation({
    mutationFn: plaidApi.disconnectItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'items'] })
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
      setDisconnectConfirmId(null)
      toast.success('Bank disconnected')
    },
    onError: () => toast.error('Failed to disconnect'),
  })

  const handleConnectBank = async () => {
    try {
      const { link_token } = await plaidApi.createLinkToken({ platform: 'web' })
      // Persist across the OAuth redirect — bank will bounce back to /plaid-oauth-return
      if (user?.id) {
        sessionStorage.setItem(`plaid_link_token_${user.id}`, link_token)
      }
      setLinkToken(link_token)
    } catch {
      toast.error('Failed to start bank connection')
    }
  }

  const handleReconnect = async (item: PlaidItem) => {
    try {
      const { link_token } = await plaidApi.reconnectItem(item.id)
      setReconnectToken(link_token)
    } catch {
      toast.error('Failed to start reconnection')
    }
  }

  // Open link when token is ready
  if (linkToken && ready) openLink()
  if (reconnectToken && reconnectReady) openReconnectLink()

  const getLastSyncText = (lastSyncedAt: string | null) => {
    if (!lastSyncedAt) return 'Never synced'
    const diff = Date.now() - new Date(lastSyncedAt).getTime()
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
    const days = Math.floor(hours / 24)
    return `${days} day${days !== 1 ? 's' : ''} ago`
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Banks & Cards</h3>
          <p className="text-xs text-gray-500 mt-0.5">Drives expenses and pending transactions (via Plaid)</p>
        </div>
        <button
          onClick={handleConnectBank}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          Connect a bank
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No banks connected yet. Connect a bank to import transactions automatically.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className={`border rounded-lg p-4 ${
                item.status === 'needs_reauth' ? 'border-red-200 bg-red-50' : 'border-gray-200'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <BanknotesIcon className="h-8 w-8 text-primary-600 shrink-0" />
                  <div className="min-w-0">
                    {renamingId === item.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="border border-gray-300 rounded px-2 py-1 text-sm"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') renameMutation.mutate({ id: item.id, name: renameValue })
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          autoFocus
                        />
                        <button
                          onClick={() => renameMutation.mutate({ id: item.id, name: renameValue })}
                          disabled={renameMutation.isPending}
                          className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setRenamingId(null)}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <p className="font-medium text-gray-900 truncate">{item.institution_name}</p>
                    )}
                    <p className="text-sm text-gray-500 mt-0.5">
                      {item.accounts.length} account{item.accounts.length !== 1 ? 's' : ''} · last sync {getLastSyncText(item.last_synced_at)}
                    </p>
                    {item.status === 'needs_reauth' && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-red-600">
                        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                        Needs reconnection
                      </div>
                    )}
                    {syncingItemIds.has(item.id) && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-blue-600">
                        <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                        Syncing transactions...
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      setRenamingId(item.id)
                      setRenameValue(item.institution_name)
                    }}
                    className="p-1.5 text-gray-400 hover:text-primary-600 rounded"
                    title="Rename"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  {item.status === 'needs_reauth' && (
                    <button
                      onClick={() => handleReconnect(item)}
                      className="p-1.5 text-amber-500 hover:text-amber-700 rounded"
                      title="Reconnect"
                    >
                      <ArrowPathIcon className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => setDisconnectConfirmId(item.id)}
                    className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                    title="Disconnect"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Disconnect confirmation modal */}
      {disconnectConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Disconnect bank?</h3>
            <p className="text-sm text-gray-600 mb-6">
              You'll lose access to its transactions and any unreviewed pending items will be deleted.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDisconnectConfirmId(null)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => disconnectMutation.mutate(disconnectConfirmId)}
                disabled={disconnectMutation.isPending}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
              >
                {disconnectMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Brokerages sub-component (SnapTrade)
// ---------------------------------------------------------------------------

const BROKERS = [
  { id: 'ROBINHOOD', label: 'Robinhood' },
  { id: 'ETRADE', label: 'E*TRADE' },
  { id: null, label: 'Other / pick on next screen' },
]

function BrokerageConnectModal({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>('ROBINHOOD')
  const [linked, setLinked] = useState(false)
  const queryClient = useQueryClient()

  const connectMutation = useMutation({
    mutationFn: async () => {
      await investmentsApi.register()
      return investmentsApi.connect(selected)
    },
    onSuccess: ({ redirectURI }) => {
      window.open(redirectURI, '_blank')
      setLinked(true)
    },
    onError: () => toast.error('Failed to start brokerage connection'),
  })

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['investments', 'accounts'] })
    onClose()
    toast.success('Accounts refreshed')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Connect a brokerage</h2>
        {!linked ? (
          <>
            <div className="space-y-2 mb-6">
              {BROKERS.map((b) => (
                <button
                  key={String(b.id)}
                  onClick={() => setSelected(b.id)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    selected === b.id
                      ? 'border-primary-500 bg-primary-50 text-primary-800'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending}
                className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                {connectMutation.isPending ? 'Opening...' : 'Continue'}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-sm text-gray-600 mb-6">
              A brokerage tab was opened. Complete the link there, then come back and refresh.
            </p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                Not yet
              </button>
              <button
                onClick={handleRefresh}
                className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 flex items-center justify-center gap-2"
              >
                <ArrowPathIcon className="h-4 w-4" />
                Refresh accounts
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Brokerages() {
  const { user } = useAuthStore()
  const [showConnect, setShowConnect] = useState(false)
  const [confirmDeregister, setConfirmDeregister] = useState(false)
  const queryClient = useQueryClient()

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['investments', 'accounts'],
    queryFn: investmentsApi.accounts,
    enabled: !!user?.family_id,
  })

  // Connection-level metadata for the family share toggle. Each row is a
  // brokerage connection (potentially containing multiple accounts).
  const { data: connectionsResp } = useQuery({
    queryKey: ['investments', 'connections'],
    queryFn: investmentsApi.listConnections,
    enabled: !!user?.family_id,
  })
  const connections = connectionsResp?.connections ?? []

  const shareMutation = useMutation({
    mutationFn: ({ authorizationId, shared }: { authorizationId: string; shared: boolean }) =>
      investmentsApi.updateConnectionShare(authorizationId, shared),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments', 'connections'] })
      queryClient.invalidateQueries({ queryKey: ['investments', 'accounts'] })
    },
    onError: () => toast.error('Failed to update sharing'),
  })

  const deregisterMutation = useMutation({
    mutationFn: investmentsApi.deregister,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments'] })
      setConfirmDeregister(false)
      toast.success('All brokerages disconnected')
    },
    onError: () => toast.error('Failed to disconnect'),
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Brokerages</h3>
          <p className="text-xs text-gray-500 mt-0.5">Drives Investments and portfolio analysis (via SnapTrade)</p>
        </div>
        <button
          onClick={() => setShowConnect(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          Connect a brokerage
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-gray-500">No brokerages connected yet. Connect a brokerage to see holdings and portfolio P&L.</p>
      ) : (
        <div className="space-y-3">
          {accounts.map((acc: InvestmentAccount) => (
            <div key={acc.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <BanknotesIcon className="h-8 w-8 text-primary-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">{acc.institution_name || acc.name}</p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {acc.name}{acc.number ? ` · ${acc.number}` : ''}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
          {/* Family-sharing toggles, one per brokerage connection you own */}
          {connections.filter((c) => c.is_owner).length > 0 && (
            <div className="mt-2 pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-500 mb-2">
                Share my brokerages with the rest of the family
              </p>
              {connections
                .filter((c) => c.is_owner)
                .map((c) => (
                  <label
                    key={c.authorization_id}
                    className="flex items-center justify-between py-2 cursor-pointer"
                  >
                    <span className="text-sm text-gray-700">
                      {c.brokerage || 'Brokerage'}{' '}
                      <span className="text-xs text-gray-400">
                        · {c.authorization_id.slice(0, 8)}…
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={c.shared_with_family}
                      onChange={(e) =>
                        shareMutation.mutate({
                          authorizationId: c.authorization_id,
                          shared: e.target.checked,
                        })
                      }
                      className="h-4 w-4 text-primary-600 rounded focus:ring-primary-500"
                    />
                  </label>
                ))}
            </div>
          )}
          <button
            onClick={() => setConfirmDeregister(true)}
            className="text-xs text-gray-400 hover:text-red-600 underline mt-2"
          >
            Disconnect all brokerages
          </button>
        </div>
      )}

      {showConnect && <BrokerageConnectModal onClose={() => setShowConnect(false)} />}

      {confirmDeregister && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Disconnect all brokerages?</h3>
            <p className="text-sm text-gray-600 mb-6">
              SnapTrade doesn't support per-brokerage disconnect yet — this removes <strong>all</strong> linked brokerages. You'll need to reconnect each one to restore holdings.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeregister(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => deregisterMutation.mutate()}
                disabled={deregisterMutation.isPending}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
              >
                {deregisterMutation.isPending ? 'Disconnecting…' : 'Disconnect all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connections wrapper — groups Banks & Cards (Plaid) + Brokerages (SnapTrade)
// ---------------------------------------------------------------------------

function Connections() {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Connections</h2>
        <p className="text-sm text-gray-500 mt-0.5">Link external accounts so the app can sync transactions and holdings.</p>
      </div>
      <BanksAndCards />
      <div className="border-t border-gray-100" />
      <Brokerages />
    </div>
  )
}

export default function Settings() {
  const { user, family, familyMembers, setFamily, setFamilyMembers, setUser } = useAuthStore()
  const queryClient = useQueryClient()
  const [_showJoinModal, setShowJoinModal] = useState(false)
  const [editingCategories, setEditingCategories] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [editingBeneficiaryLabels, setEditingBeneficiaryLabels] = useState(false)
  const [beneficiaryLabels, setBeneficiaryLabels] = useState<Record<string, string>>({})

  // Create family form
  const {
    register: registerCreate,
    handleSubmit: handleCreateSubmit,
    formState: { errors: createErrors },
  } = useForm<{ name: string }>()

  // Join family form
  const {
    register: registerJoin,
    handleSubmit: handleJoinSubmit,
    formState: { errors: joinErrors },
  } = useForm<{ invite_code: string }>()

  // Create family mutation
  const createFamilyMutation = useMutation({
    mutationFn: familyApi.create,
    onSuccess: async (newFamily) => {
      setFamily(newFamily)
      // Update user with new family_id
      setUser({ ...user!, family_id: newFamily.id })
      // Fetch members
      const members = await familyApi.getMembers(newFamily.id)
      setFamilyMembers(members)
      queryClient.invalidateQueries()
      toast.success('Family created!')
    },
    onError: () => toast.error('Failed to create family'),
  })

  // Join family mutation
  const joinFamilyMutation = useMutation({
    mutationFn: familyApi.joinByCode,
    onSuccess: async (joinedFamily) => {
      setFamily(joinedFamily)
      setUser({ ...user!, family_id: joinedFamily.id })
      const members = await familyApi.getMembers(joinedFamily.id)
      setFamilyMembers(members)
      queryClient.invalidateQueries()
      setShowJoinModal(false)
      toast.success('Joined family!')
    },
    onError: () => toast.error('Invalid invite code'),
  })

  // Regenerate invite code mutation
  const regenerateCodeMutation = useMutation({
    mutationFn: () => familyApi.regenerateInviteCode(family!.id),
    onSuccess: (data) => {
      setFamily({ ...family!, invite_code: data.invite_code })
      toast.success('Invite code regenerated!')
    },
    onError: () => toast.error('Failed to regenerate code'),
  })

  // Leave family mutation
  const leaveFamilyMutation = useMutation({
    mutationFn: () => familyApi.leave(family!.id),
    onSuccess: () => {
      setFamily(null)
      setFamilyMembers([])
      setUser({ ...user!, family_id: null })
      queryClient.invalidateQueries()
      toast.success('Left family')
    },
    onError: () => toast.error('Failed to leave family'),
  })

  // Update family settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: (settings: { categories?: string[]; beneficiary_labels?: Record<string, string> }) =>
      familyApi.updateSettings(family!.id, settings),
    onSuccess: (updatedFamily) => {
      setFamily(updatedFamily)
      queryClient.invalidateQueries()
      toast.success('Settings updated!')
    },
    onError: () => toast.error('Failed to update settings'),
  })

  const copyInviteCode = () => {
    if (family?.invite_code) {
      navigator.clipboard.writeText(family.invite_code)
      toast.success('Invite code copied!')
    }
  }

  const onCreateFamily = (data: { name: string }) => {
    createFamilyMutation.mutate(data.name)
  }

  const onJoinFamily = (data: { invite_code: string }) => {
    joinFamilyMutation.mutate(data.invite_code)
  }

  const handleEditCategories = () => {
    setCategories([...(family?.categories || [])])
    setEditingCategories(true)
  }

  const handleSaveCategories = () => {
    if (categories.length === 0) {
      toast.error('Must have at least one category')
      return
    }
    updateSettingsMutation.mutate(
      { categories },
      {
        onSuccess: () => setEditingCategories(false),
      }
    )
  }

  const handleAddCategory = () => {
    const trimmed = newCategory.trim().toLowerCase()
    if (!trimmed) return
    if (categories.includes(trimmed)) {
      toast.error('Category already exists')
      return
    }
    setCategories([...categories, trimmed])
    setNewCategory('')
  }

  const handleRemoveCategory = (index: number) => {
    setCategories(categories.filter((_, i) => i !== index))
  }

  const handleEditBeneficiaryLabels = () => {
    setBeneficiaryLabels({ ...(family?.beneficiary_labels || {}) })
    setEditingBeneficiaryLabels(true)
  }

  const handleSaveBeneficiaryLabels = () => {
    if (!beneficiaryLabels.family) {
      toast.error('Must have a label for "Entire Family"')
      return
    }
    updateSettingsMutation.mutate(
      { beneficiary_labels: beneficiaryLabels },
      {
        onSuccess: () => setEditingBeneficiaryLabels(false),
      }
    )
  }

  const handleUpdateBeneficiaryLabel = (key: string, value: string) => {
    setBeneficiaryLabels({ ...beneficiaryLabels, [key]: value })
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* User Profile */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Profile</h2>
        <div className="flex items-center gap-4">
          {user?.photo_url ? (
            <img
              src={user.photo_url}
              alt={user.display_name}
              className="h-16 w-16 rounded-full"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-primary-100 flex items-center justify-center">
              <span className="text-2xl font-medium text-primary-700">
                {user?.display_name?.[0]?.toUpperCase()}
              </span>
            </div>
          )}
          <div>
            <p className="font-semibold text-gray-900">{user?.display_name}</p>
            <p className="text-gray-500">{user?.email}</p>
          </div>
        </div>
      </div>

      {/* Family Section */}
      {family ? (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Family</h2>
          
          <div className="space-y-6">
            {/* Family name */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">
                Family Name
              </label>
              <p className="text-lg font-semibold text-gray-900">{family.name}</p>
            </div>

            {/* Invite code */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">
                Invite Code
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-4 py-2 bg-gray-100 rounded-lg font-mono text-lg">
                  {family.invite_code}
                </code>
                <button
                  onClick={copyInviteCode}
                  className="p-2 text-gray-500 hover:text-primary-600"
                  title="Copy code"
                >
                  <ClipboardDocumentIcon className="h-6 w-6" />
                </button>
                <button
                  onClick={() => regenerateCodeMutation.mutate()}
                  disabled={regenerateCodeMutation.isPending}
                  className="p-2 text-gray-500 hover:text-primary-600"
                  title="Generate new code"
                >
                  <ArrowPathIcon className={`h-6 w-6 ${regenerateCodeMutation.isPending ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Share this code with family members to let them join
              </p>
            </div>

            {/* Members */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-2">
                Members ({familyMembers.length})
              </label>
              <div className="space-y-2">
                {familyMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    {member.photo_url ? (
                      <img
                        src={member.photo_url}
                        alt={member.display_name}
                        className="h-10 w-10 rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center">
                        <span className="font-medium text-primary-700">
                          {member.display_name[0]?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div>
                      <p className="font-medium text-gray-900">{member.display_name}</p>
                      <p className="text-sm text-gray-500">{member.email}</p>
                    </div>
                    {member.id === user?.id && (
                      <span className="ml-auto text-xs bg-primary-100 text-primary-700 px-2 py-1 rounded">
                        You
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Categories */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-500">
                  Expense Categories
                </label>
                {!editingCategories && (
                  <button
                    onClick={handleEditCategories}
                    className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
                  >
                    <PencilIcon className="h-4 w-4" />
                    Edit
                  </button>
                )}
              </div>
              
              {editingCategories ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {categories.map((category, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-1 px-3 py-1 bg-primary-50 text-primary-700 rounded-full text-sm"
                      >
                        <span className="capitalize">{category}</span>
                        <button
                          onClick={() => handleRemoveCategory(index)}
                          className="hover:text-primary-900"
                        >
                          <XMarkIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddCategory()}
                      placeholder="Add new category"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <button
                      onClick={handleAddCategory}
                      className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                    >
                      <PlusIcon className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setEditingCategories(false)
                        setNewCategory('')
                      }}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveCategories}
                      disabled={updateSettingsMutation.isPending}
                      className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
                    >
                      {updateSettingsMutation.isPending ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {family.categories?.map((category) => (
                    <span
                      key={category}
                      className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm capitalize"
                    >
                      {category}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Beneficiary Labels */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-500">
                  "For" Labels
                </label>
                {!editingBeneficiaryLabels && (
                  <button
                    onClick={handleEditBeneficiaryLabels}
                    className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
                  >
                    <PencilIcon className="h-4 w-4" />
                    Edit
                  </button>
                )}
              </div>
              
              {editingBeneficiaryLabels ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <div>
                      <label className="text-xs text-gray-600">Entire Family Label</label>
                      <input
                        type="text"
                        value={beneficiaryLabels.family || ''}
                        onChange={(e) => handleUpdateBeneficiaryLabel('family', e.target.value)}
                        placeholder="e.g., Entire Family, Household"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1"
                      />
                    </div>
                    {familyMembers.map((member) => (
                      <div key={member.id}>
                        <label className="text-xs text-gray-600">{member.display_name}</label>
                        <input
                          type="text"
                          value={beneficiaryLabels[member.id] || member.display_name}
                          onChange={(e) => handleUpdateBeneficiaryLabel(member.id, e.target.value)}
                          placeholder={member.display_name}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingBeneficiaryLabels(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveBeneficiaryLabels}
                      disabled={updateSettingsMutation.isPending}
                      className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
                    >
                      {updateSettingsMutation.isPending ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between py-1">
                    <span className="text-gray-600">Entire Family:</span>
                    <span className="font-medium text-gray-900">{family.beneficiary_labels?.family || 'Entire Family'}</span>
                  </div>
                  {familyMembers.map((member) => (
                    <div key={member.id} className="flex justify-between py-1">
                      <span className="text-gray-600">{member.display_name}:</span>
                      <span className="font-medium text-gray-900">
                        {family.beneficiary_labels?.[member.id] || member.display_name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Leave family */}
            <div className="pt-4 border-t">
              <button
                onClick={() => {
                  if (confirm('Are you sure you want to leave this family?')) {
                    leaveFamilyMutation.mutate()
                  }
                }}
                disabled={leaveFamilyMutation.isPending}
                className="text-red-600 hover:text-red-700 text-sm font-medium"
              >
                Leave Family
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Create family */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Create a Family</h2>
            <form onSubmit={handleCreateSubmit(onCreateFamily)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Family Name
                </label>
                <input
                  type="text"
                  {...registerCreate('name', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="e.g., The Smiths"
                />
                {createErrors.name && (
                  <p className="text-red-500 text-sm mt-1">Name is required</p>
                )}
              </div>
              <button
                type="submit"
                disabled={createFamilyMutation.isPending}
                className="w-full px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {createFamilyMutation.isPending ? 'Creating...' : 'Create Family'}
              </button>
            </form>
          </div>

          {/* Or join */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-gray-50 text-gray-500">or</span>
            </div>
          </div>

          {/* Join family */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Join a Family</h2>
            <form onSubmit={handleJoinSubmit(onJoinFamily)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Invite Code
                </label>
                <input
                  type="text"
                  {...registerJoin('invite_code', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Enter invite code"
                />
                {joinErrors.invite_code && (
                  <p className="text-red-500 text-sm mt-1">Invite code is required</p>
                )}
              </div>
              <button
                type="submit"
                disabled={joinFamilyMutation.isPending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-primary-600 text-primary-600 rounded-lg hover:bg-primary-50 disabled:opacity-50"
              >
                <UserPlusIcon className="h-5 w-5" />
                {joinFamilyMutation.isPending ? 'Joining...' : 'Join Family'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Auto-rules link (only show if user is in a family) */}
      {family && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Auto-categorization Rules</h2>
              <p className="text-sm text-gray-500 mt-1">
                Automatically categorize future transactions from known merchants.
              </p>
            </div>
            <a
              href="/settings/auto-rules"
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 whitespace-nowrap"
            >
              Manage rules
            </a>
          </div>
        </div>
      )}

      {/* Connections — Banks & Cards (Plaid) + Brokerages (SnapTrade) */}
      {family && <Connections />}

      {/* App info */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">About</h2>
        <div className="text-sm text-gray-600 space-y-2">
          <p>Family Expense Tracker v1.0.0</p>
          <p>Track, budget, and manage your family's expenses together.</p>
        </div>
      </div>
    </div>
  )
}
