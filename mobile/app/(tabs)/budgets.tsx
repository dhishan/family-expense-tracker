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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { budgetsApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import type { BudgetCreate, BudgetStatus, BudgetPeriod } from '@/types'

function fmtUSD(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface BudgetFormData {
  name: string
  amount: string
  period: BudgetPeriod
  category: string
  beneficiary: string
}

function defaultForm(): BudgetFormData {
  return { name: '', amount: '', period: 'monthly', category: '', beneficiary: '' }
}

interface BudgetModalProps {
  visible: boolean
  editing: BudgetStatus | null
  onClose: () => void
  onSave: (data: BudgetCreate) => void
  isSaving: boolean
}

function BudgetModal({ visible, editing, onClose, onSave, isSaving }: BudgetModalProps) {
  const [form, setForm] = useState<BudgetFormData>(() =>
    editing
      ? {
          name: editing.budget.name,
          amount: String(editing.budget.amount),
          period: editing.budget.period,
          category: editing.budget.category ?? '',
          beneficiary: editing.budget.beneficiary ?? '',
        }
      : defaultForm()
  )

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
              <TextInput
                style={modalStyles.input}
                value={form.category}
                onChangeText={set('category')}
                placeholder="e.g. groceries"
              />

              <Text style={modalStyles.label}>Beneficiary (optional)</Text>
              <TextInput
                style={modalStyles.input}
                value={form.beneficiary}
                onChangeText={set('beneficiary')}
                placeholder="Leave blank for whole family"
              />
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
})

export default function BudgetsScreen() {
  const [showModal, setShowModal] = useState(false)
  const [editingBudget, setEditingBudget] = useState<BudgetStatus | null>(null)
  const { user } = useAuthStore()
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
              <View style={[styles.budgetCard, over && styles.budgetCardOver]}>
                <View style={styles.budgetTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.budgetName}>{item.budget.name}</Text>
                    <Text style={styles.budgetPeriod}>
                      {item.budget.period.charAt(0).toUpperCase() + item.budget.period.slice(1)}
                      {item.budget.category ? ` - ${item.budget.category}` : ''}
                    </Text>
                  </View>
                  <View style={styles.budgetActions}>
                    <TouchableOpacity
                      onPress={() => {
                        setEditingBudget(item)
                        setShowModal(true)
                      }}
                      style={styles.actionBtn}
                    >
                      <Text style={styles.actionEdit}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleDelete(item.budget.id)}
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
                  <Text style={styles.budgetTotal}>{fmtUSD(item.budget.amount)} total</Text>
                </View>
              </View>
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
