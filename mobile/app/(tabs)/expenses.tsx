import { useState } from 'react'
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
import Slider from '@react-native-community/slider'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { expensesApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { CATEGORY_INFO } from '@/types'
import type { ExpenseCategory, ExpenseCreate, Expense } from '@/types'

const CATEGORY_EMOJI: Record<string, string> = {
  groceries: '🛒',
  dining: '🍽',
  transportation: '🚗',
  utilities: '💡',
  entertainment: '🎬',
  healthcare: '🏥',
  shopping: '🛍',
  travel: '✈️',
  education: '📚',
  other: '📝',
}

function toLocalISODate(d: Date = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtUSD(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CATEGORIES = Object.keys(CATEGORY_INFO) as ExpenseCategory[]

interface ExpenseFormData {
  amount: string
  description: string
  merchant: string
  category: ExpenseCategory
  date: string
  beneficiary: string
}

function defaultForm(): ExpenseFormData {
  return {
    amount: '',
    description: '',
    merchant: '',
    category: 'other',
    date: toLocalISODate(),
    beneficiary: '',
  }
}

interface AddEditModalProps {
  visible: boolean
  editing: Expense | null
  onClose: () => void
  onSave: (data: ExpenseCreate) => void
  isSaving: boolean
  familyMembers: { id: string; display_name: string }[]
}

function AddEditModal({
  visible,
  editing,
  onClose,
  onSave,
  isSaving,
  familyMembers,
}: AddEditModalProps) {
  const [form, setForm] = useState<ExpenseFormData>(() =>
    editing
      ? {
          amount: String(editing.amount),
          description: editing.description,
          merchant: editing.merchant ?? '',
          category: editing.category,
          date: editing.date,
          beneficiary: editing.beneficiary,
        }
      : defaultForm()
  )

  const set = (key: keyof ExpenseFormData) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSave = () => {
    const amount = parseFloat(form.amount)
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Validation', 'Enter a valid amount greater than 0.')
      return
    }
    if (!form.description.trim()) {
      Alert.alert('Validation', 'Description is required.')
      return
    }
    onSave({
      amount,
      description: form.description.trim(),
      merchant: form.merchant.trim() || undefined,
      category: form.category,
      date: form.date,
      beneficiary: form.beneficiary || (familyMembers[0]?.id ?? ''),
      payment_method: 'other',
    })
  }

  // Mirror the web's QuickAddStrip: category chips at top (always visible
  // even when the keyboard is open), amount with slider + numeric input,
  // merchant typeahead, then a collapsible "Advanced" section for date +
  // beneficiary.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const sliderValue = Math.min(parseFloat(form.amount) || 0, 100)

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <View style={modalStyles.container}>
          <View style={modalStyles.header}>
            <TouchableOpacity onPress={onClose}>
              <Text style={modalStyles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={modalStyles.title}>{editing ? 'Edit Expense' : 'Add Expense'}</Text>
            <TouchableOpacity onPress={handleSave} disabled={isSaving}>
              {isSaving ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={modalStyles.save}>Save</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Category chips — pinned to the TOP so they remain visible even
              when the keyboard is open (was the user's main complaint). */}
          <View style={modalStyles.chipsBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {CATEGORIES.map((cat) => {
                const active = form.category === cat
                return (
                  <TouchableOpacity
                    key={cat}
                    style={[modalStyles.catChip, active && modalStyles.catChipActive]}
                    onPress={() => set('category')(cat)}
                    testID={`category-chip-${cat}`}
                  >
                    <Text style={modalStyles.catEmoji}>{CATEGORY_EMOJI[cat] ?? '📝'}</Text>
                    <Text style={[modalStyles.catLabel, active && modalStyles.catLabelActive]}>
                      {CATEGORY_INFO[cat].label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 64 }}
          >
            <View style={modalStyles.form}>
              {/* Amount — big display + slider underneath */}
              <Text style={modalStyles.label}>Amount</Text>
              <View style={modalStyles.amountRow}>
                <Text style={modalStyles.dollar}>$</Text>
                <TextInput
                  style={modalStyles.amountInput}
                  value={form.amount}
                  onChangeText={set('amount')}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  testID="amount-input"
                />
              </View>
              <Slider
                minimumValue={0}
                maximumValue={100}
                step={1}
                value={sliderValue}
                onValueChange={(v) => set('amount')(String(v))}
                minimumTrackTintColor="#2563eb"
                maximumTrackTintColor="#e5e7eb"
                style={{ marginBottom: 16 }}
              />

              <Text style={modalStyles.label}>Description *</Text>
              <TextInput
                style={modalStyles.input}
                value={form.description}
                onChangeText={set('description')}
                placeholder="What was this for?"
                testID="description-input"
                returnKeyType="next"
              />

              <Text style={modalStyles.label}>Merchant</Text>
              <TextInput
                style={modalStyles.input}
                value={form.merchant}
                onChangeText={set('merchant')}
                placeholder="Optional"
                returnKeyType="next"
              />

              {/* Advanced toggle — Date + Beneficiary collapsed by default */}
              <TouchableOpacity
                onPress={() => setShowAdvanced((v) => !v)}
                style={modalStyles.advancedToggle}
              >
                <Text style={modalStyles.advancedToggleText}>
                  {showAdvanced ? '▾' : '▸'}  Advanced
                </Text>
              </TouchableOpacity>

              {showAdvanced && (
                <>
                  <Text style={modalStyles.label}>Date</Text>
                  <TextInput
                    style={modalStyles.input}
                    value={form.date}
                    onChangeText={set('date')}
                    placeholder="YYYY-MM-DD"
                  />

                  {familyMembers.length > 1 && (
                    <>
                      <Text style={modalStyles.label}>For</Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={{ marginBottom: 16 }}
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
                    </>
                  )}
                </>
              )}
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
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingTop: 56,
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
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#d1d5db',
    marginRight: 8,
    backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },

  // ── QuickAdd-strip styles ─────────────────────────────────────────────
  chipsBar: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    backgroundColor: '#fafafa',
  },
  catChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    marginRight: 8,
  },
  catChipActive: {
    backgroundColor: '#eef2ff',
    borderColor: '#2563eb',
  },
  catEmoji: { fontSize: 16, marginRight: 6 },
  catLabel: { fontSize: 13, color: '#374151', fontWeight: '500' },
  catLabelActive: { color: '#1d4ed8', fontWeight: '600' },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  dollar: { fontSize: 22, color: '#6b7280', fontWeight: '600' },
  amountInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  advancedToggle: {
    paddingVertical: 8,
    marginBottom: 8,
  },
  advancedToggleText: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff' },
})

export default function ExpensesScreen() {
  const [showModal, setShowModal] = useState(false)
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [page, setPage] = useState(1)
  const { user, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', page],
    queryFn: () => expensesApi.list({ page, page_size: 20 }),
    enabled: !!user?.family_id,
  })

  const createMutation = useMutation({
    mutationFn: expensesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setShowModal(false)
      setEditingExpense(null)
    },
    onError: () => Alert.alert('Error', 'Failed to add expense.'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data: d }: { id: string; data: Partial<ExpenseCreate> }) =>
      expensesApi.update(id, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setShowModal(false)
      setEditingExpense(null)
    },
    onError: () => Alert.alert('Error', 'Failed to update expense.'),
  })

  const deleteMutation = useMutation({
    mutationFn: expensesApi.delete,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expenses'] }),
    onError: () => Alert.alert('Error', 'Failed to delete expense.'),
  })

  const handleDelete = (id: string) => {
    Alert.alert('Delete expense', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate(id) },
    ])
  }

  const handleSave = (formData: ExpenseCreate) => {
    if (editingExpense) {
      updateMutation.mutate({ id: editingExpense.id, data: formData })
    } else {
      createMutation.mutate(formData)
    }
  }

  const openAdd = () => {
    setEditingExpense(null)
    setShowModal(true)
  }

  const openEdit = (expense: Expense) => {
    setEditingExpense(expense)
    setShowModal(true)
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Expenses</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd} testID="add-expense-btn">
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 40 }} />
      ) : data?.expenses.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No expenses yet</Text>
          <Text style={styles.emptySubtitle}>Tap "+ Add" to record your first expense.</Text>
        </View>
      ) : (
        <FlatList
          data={data?.expenses ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          testID="expenses-list"
          renderItem={({ item }) => (
            <View style={styles.expenseCard}>
              <View style={{ flex: 1 }}>
                <View style={styles.expenseRow}>
                  <Text style={styles.expenseDescription} numberOfLines={1}>
                    {item.description}
                  </Text>
                  <Text style={styles.expenseAmount}>{fmtUSD(item.amount)}</Text>
                </View>
                <View style={styles.expenseRow}>
                  <View style={styles.categoryBadge}>
                    <Text style={styles.categoryBadgeText}>
                      {CATEGORY_INFO[item.category]?.label ?? item.category}
                    </Text>
                  </View>
                  <Text style={styles.expenseDate}>{item.date}</Text>
                </View>
                {item.merchant && (
                  <Text style={styles.expenseMerchant}>{item.merchant}</Text>
                )}
              </View>
              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={() => openEdit(item)}
                  style={styles.actionBtn}
                  testID={`edit-expense-${item.id}`}
                >
                  <Text style={styles.actionEdit}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleDelete(item.id)}
                  style={styles.actionBtn}
                  testID={`delete-expense-${item.id}`}
                >
                  <Text style={styles.actionDelete}>Del</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListFooterComponent={
            data?.has_more ? (
              <TouchableOpacity
                style={styles.loadMore}
                onPress={() => setPage((p) => p + 1)}
              >
                <Text style={styles.loadMoreText}>Load more</Text>
              </TouchableOpacity>
            ) : null
          }
        />
      )}

      <AddEditModal
        visible={showModal}
        editing={editingExpense}
        onClose={() => {
          setShowModal(false)
          setEditingExpense(null)
        }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        familyMembers={familyMembers}
      />
    </View>
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
  expenseCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  expenseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  expenseDescription: { fontSize: 15, fontWeight: '500', color: '#111827', flex: 1, marginRight: 8 },
  expenseAmount: { fontSize: 15, fontWeight: '700', color: '#111827' },
  categoryBadge: {
    backgroundColor: '#dbeafe',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  categoryBadgeText: { fontSize: 11, color: '#1d4ed8', fontWeight: '500' },
  expenseDate: { fontSize: 12, color: '#9ca3af' },
  expenseMerchant: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  actions: { flexDirection: 'column', alignItems: 'flex-end', gap: 6, marginLeft: 8 },
  actionBtn: { padding: 4 },
  actionEdit: { fontSize: 13, color: '#2563eb' },
  actionDelete: { fontSize: 13, color: '#dc2626' },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { color: '#2563eb', fontSize: 14 },
})
