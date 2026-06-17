import { useEffect, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { budgetsApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import type {
  Budget,
  BudgetCreate,
  BudgetStatus,
  BudgetPeriod,
  ExpenseCategory,
} from '@/types'
import { CATEGORY_INFO } from '@/types'

const CATEGORY_VALUES: ExpenseCategory[] = [
  'groceries',
  'dining',
  'transportation',
  'utilities',
  'entertainment',
  'healthcare',
  'shopping',
  'travel',
  'education',
  'other',
]

function fmtUSD(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface BudgetFormData {
  name: string
  amount: string
  period: BudgetPeriod
  category: string
  beneficiary: string
  rollover_enabled: boolean
  ytd_view: boolean
}

function defaultForm(): BudgetFormData {
  return { name: '', amount: '', period: 'monthly', category: '', beneficiary: '', rollover_enabled: true, ytd_view: false }
}

interface BudgetModalProps {
  visible: boolean
  editing: BudgetStatus | null
  onClose: () => void
  onSave: (data: BudgetCreate) => void
  isSaving: boolean
  familyMembers: { id: string; display_name: string }[]
}

function BudgetModal({ visible, editing, onClose, onSave, isSaving, familyMembers }: BudgetModalProps) {
  const [form, setForm] = useState<BudgetFormData>(defaultForm)

  // Re-seed the form every time the modal opens (or the budget being
  // edited changes). The previous lazy useState initializer only ran
  // ONCE per mount, so reopening Edit on a different budget kept stale
  // form values from whatever was previously open.
  useEffect(() => {
    if (!visible) return
    if (editing) {
      setForm({
        name: editing.budget.name,
        amount: String(editing.budget.amount),
        period: editing.budget.period,
        category: editing.budget.category ?? '',
        beneficiary: editing.budget.beneficiary ?? '',
        rollover_enabled: editing.budget.rollover_enabled ?? true,
        ytd_view: editing.budget.ytd_view ?? false,
      })
    } else {
      setForm(defaultForm())
    }
  }, [visible, editing])

  const set = (key: keyof BudgetFormData) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSave = () => {
    if (!form.name.trim()) {
      Alert.alert('Validation', 'Name is required.')
      return
    }
    const amount = parseFloat(form.amount)
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Validation', 'Enter a valid amount greater than 0.')
      return
    }
    onSave({
      name: form.name.trim(),
      amount,
      period: form.period,
      category: form.category.trim() || undefined,
      beneficiary: form.beneficiary.trim() || undefined,
      rollover_enabled: form.rollover_enabled,
      ytd_view: form.ytd_view,
    })
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={modalStyles.container}>
          <View style={modalStyles.header}>
            <TouchableOpacity onPress={onClose}>
              <Text style={modalStyles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={modalStyles.title}>{editing ? 'Edit Budget' : 'New Budget'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={isSaving}>
              {isSaving ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={modalStyles.save}>Save</Text>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <View style={modalStyles.form}>
              <Text style={modalStyles.label}>Name *</Text>
              <TextInput
                style={modalStyles.input}
                value={form.name}
                onChangeText={set('name')}
                placeholder="e.g. Groceries budget"
                testID="budget-name-input"
              />

              <Text style={modalStyles.label}>Amount ($) *</Text>
              <TextInput
                style={modalStyles.input}
                value={form.amount}
                onChangeText={set('amount')}
                keyboardType="decimal-pad"
                placeholder="0.00"
                testID="budget-amount-input"
              />

              <Text style={modalStyles.label}>Period</Text>
              <View style={modalStyles.segmentRow}>
                {(['weekly', 'monthly', 'yearly'] as BudgetPeriod[]).map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[
                      modalStyles.segment,
                      form.period === p && modalStyles.segmentActive,
                    ]}
                    onPress={() => setForm((prev) => ({ ...prev, period: p }))}
                  >
                    <Text
                      style={[
                        modalStyles.segmentText,
                        form.period === p && modalStyles.segmentTextActive,
                      ]}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={modalStyles.label}>Category (optional)</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 16 }}
                keyboardShouldPersistTaps="handled"
              >
                <TouchableOpacity
                  style={[
                    modalStyles.chip,
                    form.category === '' && modalStyles.chipActive,
                  ]}
                  onPress={() => set('category')('')}
                >
                  <Text
                    style={[
                      modalStyles.chipText,
                      form.category === '' && modalStyles.chipTextActive,
                    ]}
                  >
                    All
                  </Text>
                </TouchableOpacity>
                {CATEGORY_VALUES.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[
                      modalStyles.chip,
                      form.category === c && modalStyles.chipActive,
                    ]}
                    onPress={() => set('category')(c)}
                  >
                    <Text
                      style={[
                        modalStyles.chipText,
                        form.category === c && modalStyles.chipTextActive,
                      ]}
                    >
                      {CATEGORY_INFO[c].label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={modalStyles.label}>For (optional)</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 16 }}
                keyboardShouldPersistTaps="handled"
              >
                <TouchableOpacity
                  style={[
                    modalStyles.chip,
                    form.beneficiary === '' && modalStyles.chipActive,
                  ]}
                  onPress={() => set('beneficiary')('')}
                >
                  <Text
                    style={[
                      modalStyles.chipText,
                      form.beneficiary === '' && modalStyles.chipTextActive,
                    ]}
                  >
                    Family
                  </Text>
                </TouchableOpacity>
                {familyMembers.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={[
                      modalStyles.chip,
                      form.beneficiary === m.id && modalStyles.chipActive,
                    ]}
                    onPress={() => set('beneficiary')(m.id)}
                  >
                    <Text
                      style={[
                        modalStyles.chipText,
                        form.beneficiary === m.id && modalStyles.chipTextActive,
                      ]}
                    >
                      {m.display_name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={{ marginBottom: 16 }}>
              <TouchableOpacity
                onPress={() => setForm((prev) => {
                  const next = !prev.rollover_enabled
                  return { ...prev, rollover_enabled: next, ytd_view: next ? false : prev.ytd_view }
                })}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
              >
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 4, borderWidth: 1,
                    borderColor: form.rollover_enabled ? '#2563eb' : '#d1d5db',
                    backgroundColor: form.rollover_enabled ? '#2563eb' : '#fff',
                    alignItems: 'center', justifyContent: 'center', marginTop: 2,
                  }}
                >
                  {form.rollover_enabled && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#374151' }}>Roll over unused budget</Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    Anything unspent carries forward, cumulative, no cap.
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            <View style={{ marginBottom: 16 }}>
              <TouchableOpacity
                onPress={() => setForm((prev) => {
                  const next = !prev.ytd_view
                  return { ...prev, ytd_view: next, rollover_enabled: next ? false : prev.rollover_enabled }
                })}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
              >
                <View
                  style={{
                    width: 22, height: 22, borderRadius: 4, borderWidth: 1,
                    borderColor: form.ytd_view ? '#2563eb' : '#d1d5db',
                    backgroundColor: form.ytd_view ? '#2563eb' : '#fff',
                    alignItems: 'center', justifyContent: 'center', marginTop: 2,
                  }}
                >
                  {form.ytd_view && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#374151' }}>Track year-to-date</Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    Spent + quota since Jan 1. Quota scales by periods elapsed this year. Overrides rollover.
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const modalStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 56,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#111827' },
  cancel: { fontSize: 16, color: '#6b7280' },
  save: { fontSize: 16, color: '#2563eb', fontWeight: '600' },
  form: { padding: 16 },
  label: { fontSize: 13, fontWeight: '500', color: '#374151', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#111827',
    marginBottom: 16,
  },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  segmentText: { fontSize: 14, color: '#374151' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    marginRight: 8,
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff', fontWeight: '600' },
})

export default function BudgetsScreen() {
  const [showModal, setShowModal] = useState(false)
  const [editingBudget, setEditingBudget] = useState<BudgetStatus | null>(null)
  const [viewingTxBudget, setViewingTxBudget] = useState<Budget | null>(null)
  const [txScope, setTxScope] = useState<'current' | 'all'>('current')
  const { user, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['budgets'],
    queryFn: budgetsApi.list,
    enabled: !!user?.family_id,
  })

  const createMutation = useMutation({
    mutationFn: budgetsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setShowModal(false)
    },
    onError: () => Alert.alert('Error', 'Failed to create budget.'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Partial<BudgetCreate> }) =>
      budgetsApi.update(id, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setShowModal(false)
      setEditingBudget(null)
    },
    onError: () => Alert.alert('Error', 'Failed to update budget.'),
  })

  const deleteMutation = useMutation({
    mutationFn: budgetsApi.delete,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budgets'] }),
    onError: () => Alert.alert('Error', 'Failed to delete budget.'),
  })

  const handleSave = (formData: BudgetCreate) => {
    if (editingBudget) {
      updateMutation.mutate({ id: editingBudget.budget.id, d: formData })
    } else {
      createMutation.mutate(formData)
    }
  }

  const handleDelete = (id: string) => {
    Alert.alert('Delete budget', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate(id) },
    ])
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Budgets</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => {
            setEditingBudget(null)
            setShowModal(true)
          }}
          testID="add-budget-btn"
        >
          <Text style={styles.addBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 40 }} />
      ) : data?.budgets.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No budgets yet</Text>
          <Text style={styles.emptySubtitle}>Tap "+ New" to create your first budget.</Text>
        </View>
      ) : (
        <FlatList
          data={data?.budgets ?? []}
          keyExtractor={(item) => item.budget.id}
          contentContainerStyle={{ padding: 16 }}
          testID="budgets-list"
          renderItem={({ item }) => {
            const pct = Math.min(item.percentage_used, 100)
            const over = item.is_over_budget
            return (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setViewingTxBudget(item.budget)}
                style={[styles.budgetCard, over && styles.budgetCardOver]}
                testID={`budget-card-${item.budget.id}`}
              >
                <View style={styles.budgetTop}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.budgetName}>{item.budget.name}</Text>
                      {item.budget.ytd_view && (
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: '700',
                            color: '#4338ca',
                            backgroundColor: '#eef2ff',
                            borderColor: '#c7d2fe',
                            borderWidth: 1,
                            paddingHorizontal: 4,
                            paddingVertical: 1,
                            borderRadius: 4,
                          }}
                        >
                          YTD
                        </Text>
                      )}
                    </View>
                    <Text style={styles.budgetPeriod}>
                      {item.budget.period.charAt(0).toUpperCase() + item.budget.period.slice(1)}
                      {item.budget.category ? ` - ${item.budget.category}` : ''}
                    </Text>
                  </View>
                  <View style={styles.budgetActions}>
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.()
                        setEditingBudget(item)
                        setShowModal(true)
                      }}
                      style={styles.actionBtn}
                    >
                      <Text style={styles.actionEdit}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.()
                        handleDelete(item.budget.id)
                      }}
                      style={styles.actionBtn}
                    >
                      <Text style={styles.actionDelete}>Del</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${pct}%` as `${number}%`,
                        backgroundColor: over ? '#dc2626' : '#2563eb',
                      },
                    ]}
                  />
                </View>

                <View style={styles.budgetAmounts}>
                  <Text style={styles.budgetSpent}>
                    {fmtUSD(item.spent)} spent
                  </Text>
                  <Text style={[styles.budgetRemaining, over && { color: '#dc2626' }]}>
                    {over
                      ? `${fmtUSD(Math.abs(item.remaining))} over`
                      : `${fmtUSD(item.remaining)} left`}
                  </Text>
                  <Text style={styles.budgetTotal}>
                    {fmtUSD(item.effective_amount ?? item.budget.amount)} total
                    {item.rollover_amount && item.rollover_amount > 0
                      ? `  (+${fmtUSD(item.rollover_amount)} rolled over)`
                      : ''}
                  </Text>
                </View>
              </TouchableOpacity>
            )
          }}
        />
      )}

      <BudgetModal
        visible={showModal}
        editing={editingBudget}
        onClose={() => {
          setShowModal(false)
          setEditingBudget(null)
        }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        familyMembers={familyMembers.map((m) => ({ id: m.id, display_name: m.display_name }))}
      />

      <BudgetTxModal
        budget={viewingTxBudget}
        scope={txScope}
        onScopeChange={setTxScope}
        onClose={() => { setViewingTxBudget(null); setTxScope('current') }}
      />
    </View>
  )
}

interface BudgetTxModalProps {
  budget: Budget | null
  scope: 'current' | 'all'
  onScopeChange: (s: 'current' | 'all') => void
  onClose: () => void
}

function BudgetTxModal({ budget, scope, onScopeChange, onClose }: BudgetTxModalProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['budgets', 'transactions', budget?.id, scope],
    queryFn: () => budgetsApi.listTransactions(budget!.id, scope),
    enabled: !!budget,
    staleTime: 30_000,
  })
  const total = (data?.expenses ?? []).reduce((s, e) => s + e.amount, 0)
  return (
    <Modal
      visible={!!budget}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#111827' }}>{budget?.name ?? ''}</Text>
            <Text style={{ fontSize: 12, color: '#6b7280', textTransform: 'capitalize' }}>
              {budget?.period ?? ''} · transactions
            </Text>
          </View>
          <TouchableOpacity onPress={onClose}>
            <Text style={{ fontSize: 14, color: '#2563eb' }}>Close</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' }}>
          <TouchableOpacity
            onPress={() => onScopeChange('current')}
            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, backgroundColor: scope === 'current' ? '#2563eb' : 'transparent' }}
          >
            <Text style={{ fontSize: 12, color: scope === 'current' ? '#fff' : '#6b7280' }}>This period</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onScopeChange('all')}
            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, backgroundColor: scope === 'all' ? '#2563eb' : 'transparent' }}
          >
            <Text style={{ fontSize: 12, color: scope === 'all' ? '#fff' : '#6b7280' }}>Since start</Text>
          </TouchableOpacity>
          <Text style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
            {data?.total ?? 0} txns · {fmtUSD(total)}
          </Text>
        </View>
        {isLoading ? (
          <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 40 }} />
        ) : !data || data.expenses.length === 0 ? (
          <Text style={{ textAlign: 'center', color: '#6b7280', marginTop: 40 }}>
            No transactions for this budget yet.
          </Text>
        ) : (
          <FlatList
            data={data.expenses}
            keyExtractor={(e) => e.id}
            renderItem={({ item }) => (
              <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ fontSize: 14, color: '#111827' }} numberOfLines={1}>
                    {item.merchant || item.description || item.category}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    {item.date.slice(0, 10)}
                  </Text>
                </View>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#111827' }}>
                  {fmtUSD(item.amount)}
                </Text>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  addBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#9ca3af', textAlign: 'center' },
  budgetCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    borderLeftWidth: 4,
    borderLeftColor: '#2563eb',
  },
  budgetCardOver: { borderLeftColor: '#dc2626' },
  budgetTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  budgetName: { fontSize: 16, fontWeight: '600', color: '#111827' },
  budgetPeriod: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  budgetActions: { flexDirection: 'row', gap: 12 },
  actionBtn: { padding: 4 },
  actionEdit: { fontSize: 13, color: '#2563eb' },
  actionDelete: { fontSize: 13, color: '#dc2626' },
  progressTrack: { height: 8, backgroundColor: '#e5e7eb', borderRadius: 4, marginBottom: 10 },
  progressFill: { height: 8, borderRadius: 4 },
  budgetAmounts: { flexDirection: 'row', justifyContent: 'space-between' },
  budgetSpent: { fontSize: 13, color: '#374151' },
  budgetRemaining: { fontSize: 13, color: '#059669', fontWeight: '500' },
  budgetTotal: { fontSize: 13, color: '#6b7280' },
})
