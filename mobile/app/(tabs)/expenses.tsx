import { useState, useRef, useEffect, useCallback } from 'react'
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
  Animated,
} from 'react-native'
import Slider from '@react-native-community/slider'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { expensesApi, plaidApi, budgetsApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { CATEGORY_INFO } from '@/types'
import type { ExpenseCategory, ExpenseCreate, Expense, PendingTransaction, PaymentMethod, BudgetStatus } from '@/types'

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

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'credit', label: 'Credit' },
  { value: 'debit', label: 'Debit' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'other', label: 'Other' },
]

// Derive a sensible payment method from the Plaid account type string
function derivePaymentMethod(accountType?: string | null): PaymentMethod {
  const t = (accountType ?? '').toLowerCase()
  if (t === 'depository') return 'debit'
  if (t === 'credit') return 'credit'
  return 'credit'
}

// ─── Approve modal (for Plaid pending approval) ────────────────────────────────

interface ApproveEdits {
  amount: number
  date: string
  category: ExpenseCategory
  description: string
  merchant: string
  payment_method: PaymentMethod
  beneficiary: string
  tags: string[]
  budget_id?: string | null
}

interface ApproveModalProps {
  visible: boolean
  pending: PendingTransaction | null
  onClose: () => void
  onApprove: (edits: ApproveEdits) => void
  isApproving: boolean
  familyMembers: { id: string; display_name: string }[]
  currentUserId: string
  // Account type for payment method derivation
  accountType?: string | null
}

function ApproveModal({
  visible,
  pending,
  onClose,
  onApprove,
  isApproving,
  familyMembers,
  currentUserId,
  accountType,
}: ApproveModalProps) {
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [category, setCategory] = useState<ExpenseCategory>('other')
  const [description, setDescription] = useState('')
  const [merchant, setMerchant] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('credit')
  const [beneficiary, setBeneficiary] = useState('')
  const [tags, setTags] = useState('')
  const [budgetId, setBudgetId] = useState<string | null>(null)
  // Track if the user manually changed category so budget auto-fill doesn't fight them
  const [categoryManuallySet, setCategoryManuallySet] = useState(false)

  const { data: budgetsData } = useQuery({
    queryKey: ['budgets', 'list'],
    queryFn: budgetsApi.list,
    enabled: visible,
  })
  const budgets: BudgetStatus[] = budgetsData?.budgets ?? []

  useEffect(() => {
    if (pending && visible) {
      const rawAmt = Math.abs(pending.amount ?? 0)
      setAmount(String(rawAmt))
      const dateStr = pending.date ?? pending.authorized_date ?? toLocalISODate()
      setDate(dateStr)
      setCategory(pending.suggested_category ?? 'other')
      setDescription(pending.merchant_name ?? pending.name ?? '')
      setMerchant(pending.merchant_name ?? '')
      setPaymentMethod(derivePaymentMethod(accountType))
      setBeneficiary(currentUserId)
      setTags('')
      setBudgetId(pending.suggested_budget_id ?? null)
      setCategoryManuallySet(false)
    }
  }, [pending, visible, currentUserId, accountType])

  // When category changes, deselect budget if it no longer matches
  const handleCategoryChange = (cat: ExpenseCategory) => {
    setCategory(cat)
    setCategoryManuallySet(true)
    if (budgetId) {
      const selected = budgets.find((b) => b.budget.id === budgetId)
      if (selected && selected.budget.category && selected.budget.category !== cat) {
        setBudgetId(null)
      }
    }
  }

  // When a budget is selected, auto-fill category if not manually overridden
  const handleBudgetSelect = (bs: BudgetStatus | null) => {
    if (!bs) {
      setBudgetId(null)
      return
    }
    setBudgetId(bs.budget.id)
    if (!categoryManuallySet && bs.budget.category) {
      setCategory(bs.budget.category as ExpenseCategory)
    }
  }

  const handleApprove = () => {
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Validation', 'Enter a valid amount greater than 0.')
      return
    }
    const tagsArr = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    onApprove({
      amount: amt,
      date: date || toLocalISODate(),
      category,
      description: description.trim(),
      merchant: merchant.trim(),
      payment_method: paymentMethod,
      beneficiary,
      tags: tagsArr,
      budget_id: budgetId,
    })
  }

  // Filter budgets: show those whose category matches current category, or has no category.
  // "Show all" toggle reveals the rest.
  const [showAllBudgets, setShowAllBudgets] = useState(false)
  const filteredBudgets = showAllBudgets
    ? budgets
    : budgets.filter((b) => !b.budget.category || b.budget.category === category)

  // Sort: weekly first, monthly, yearly
  const periodOrder: Record<string, number> = { weekly: 0, monthly: 1, yearly: 2 }
  const sortedBudgets = [...filteredBudgets].sort(
    (a, b) => (periodOrder[a.budget.period] ?? 3) - (periodOrder[b.budget.period] ?? 3)
  )

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
            <Text style={modalStyles.title}>Approve Transaction</Text>
            <TouchableOpacity onPress={handleApprove} disabled={isApproving}>
              {isApproving ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={modalStyles.save}>Approve</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Category chips */}
          <View style={modalStyles.chipsBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {CATEGORIES.map((cat) => {
                const active = category === cat
                return (
                  <TouchableOpacity
                    key={cat}
                    style={[modalStyles.catChip, active && modalStyles.catChipActive]}
                    onPress={() => handleCategoryChange(cat)}
                    testID={`approve-category-chip-${cat}`}
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
              <Text style={modalStyles.label}>Amount</Text>
              <View style={modalStyles.amountRow}>
                <Text style={modalStyles.dollar}>$</Text>
                <TextInput
                  style={modalStyles.amountInput}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  testID="approve-amount-input"
                />
              </View>

              <Text style={modalStyles.label}>Date</Text>
              <TextInput
                style={modalStyles.input}
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                testID="approve-date-input"
              />

              <Text style={modalStyles.label}>Note</Text>
              <TextInput
                style={modalStyles.input}
                value={description}
                onChangeText={setDescription}
                placeholder="What was this for?"
                testID="approve-description-input"
              />

              <Text style={modalStyles.label}>Merchant</Text>
              <TextInput
                style={modalStyles.input}
                value={merchant}
                onChangeText={setMerchant}
                placeholder="Store or vendor name"
                testID="approve-merchant-input"
              />

              <Text style={modalStyles.label}>Payment method</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 16 }}
              >
                {PAYMENT_METHODS.map((pm) => (
                  <TouchableOpacity
                    key={pm.value}
                    style={[
                      modalStyles.chip,
                      paymentMethod === pm.value && modalStyles.chipActive,
                    ]}
                    onPress={() => setPaymentMethod(pm.value)}
                    testID={`approve-pm-chip-${pm.value}`}
                  >
                    <Text
                      style={[
                        modalStyles.chipText,
                        paymentMethod === pm.value && modalStyles.chipTextActive,
                      ]}
                    >
                      {pm.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Budget picker */}
              {budgets.length > 0 && (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={[modalStyles.label, { flex: 1, marginBottom: 0 }]}>Budget</Text>
                    <TouchableOpacity onPress={() => setShowAllBudgets((v) => !v)}>
                      <Text style={approveStyles.showAllText}>
                        {showAllBudgets ? 'Show relevant' : 'Show all'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginBottom: 16 }}
                  >
                    {/* None chip */}
                    <TouchableOpacity
                      style={[
                        approveStyles.budgetChip,
                        !budgetId && approveStyles.budgetChipActive,
                      ]}
                      onPress={() => handleBudgetSelect(null)}
                      testID="approve-budget-none"
                    >
                      <Text
                        style={[
                          approveStyles.budgetChipName,
                          !budgetId && approveStyles.budgetChipNameActive,
                        ]}
                      >
                        None
                      </Text>
                    </TouchableOpacity>

                    {sortedBudgets.map((bs) => {
                      const active = budgetId === bs.budget.id
                      const pct = Math.round(bs.percentage_used)
                      return (
                        <TouchableOpacity
                          key={bs.budget.id}
                          style={[
                            approveStyles.budgetChip,
                            active && approveStyles.budgetChipActive,
                            bs.is_over_budget && approveStyles.budgetChipOver,
                          ]}
                          onPress={() => handleBudgetSelect(bs)}
                          testID={`approve-budget-chip-${bs.budget.id}`}
                        >
                          <Text
                            style={[
                              approveStyles.budgetChipName,
                              active && approveStyles.budgetChipNameActive,
                            ]}
                            numberOfLines={1}
                          >
                            {bs.budget.name}
                          </Text>
                          <Text
                            style={[
                              approveStyles.budgetChipMeta,
                              active && approveStyles.budgetChipMetaActive,
                            ]}
                          >
                            {pct}% used
                          </Text>
                        </TouchableOpacity>
                      )
                    })}
                  </ScrollView>
                </>
              )}

              {familyMembers.length > 1 && (
                <>
                  <Text style={modalStyles.label}>For</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginBottom: 16 }}
                  >
                    {familyMembers.map((m) => (
                      <TouchableOpacity
                        key={m.id}
                        style={[
                          modalStyles.chip,
                          beneficiary === m.id && modalStyles.chipActive,
                        ]}
                        onPress={() => setBeneficiary(m.id)}
                      >
                        <Text
                          style={[
                            modalStyles.chipText,
                            beneficiary === m.id && modalStyles.chipTextActive,
                          ]}
                        >
                          {m.display_name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              )}

              <Text style={modalStyles.label}>Tags (comma-separated)</Text>
              <TextInput
                style={modalStyles.input}
                value={tags}
                onChangeText={setTags}
                placeholder="e.g. work, reimbursable"
                testID="approve-tags-input"
              />

              {pending && (
                <View style={modalStyles.pendingMeta}>
                  <Text style={modalStyles.pendingMetaText}>
                    {pending.institution_name}
                    {pending.account_name ? ` · ${pending.account_name}` : ''}
                    {pending.date ? ` · ${pending.date}` : ''}
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const approveStyles = StyleSheet.create({
  showAllText: { fontSize: 12, color: '#2563eb', fontWeight: '500' },
  budgetChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1d5db',
    marginRight: 8,
    backgroundColor: '#fff',
    minWidth: 72,
    alignItems: 'center',
  },
  budgetChipActive: { backgroundColor: '#eef2ff', borderColor: '#2563eb' },
  budgetChipOver: { borderColor: '#dc2626', backgroundColor: '#fff1f2' },
  budgetChipName: { fontSize: 13, color: '#374151', fontWeight: '600' },
  budgetChipNameActive: { color: '#1d4ed8' },
  budgetChipMeta: { fontSize: 10, color: '#9ca3af', marginTop: 2 },
  budgetChipMetaActive: { color: '#6366f1' },
})

// ─── Add/Edit modal ────────────────────────────────────────────────────────────

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

// ─── Undo snackbar ─────────────────────────────────────────────────────────────

interface SnackbarItem {
  id: string
  label: string
  onUndo: () => void
}

function Snackbar({ item, onDismiss }: { item: SnackbarItem; onDismiss: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(4000),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => onDismiss())
  }, [])

  return (
    <Animated.View style={[snackStyles.bar, { opacity }]}>
      <Text style={snackStyles.label}>{item.label}</Text>
      <TouchableOpacity
        onPress={() => {
          opacity.stopAnimation()
          item.onUndo()
          onDismiss()
        }}
      >
        <Text style={snackStyles.undo}>Undo</Text>
      </TouchableOpacity>
    </Animated.View>
  )
}

const snackStyles = StyleSheet.create({
  bar: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 100,
  },
  label: { color: '#fff', fontSize: 14, flex: 1, marginRight: 12 },
  undo: { color: '#60a5fa', fontSize: 14, fontWeight: '600' },
})

// ─── Pending review section ────────────────────────────────────────────────────

interface PendingReviewSectionProps {
  pendingItems: PendingTransaction[]
  totalPending?: number
  onApprove: (item: PendingTransaction) => void
  onDiscard: (item: PendingTransaction) => void
  onSaveUncategorized: (item: PendingTransaction) => void
}

function PendingReviewSection({
  pendingItems,
  totalPending,
  onApprove,
  onDiscard,
  onSaveUncategorized,
}: PendingReviewSectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (pendingItems.length === 0) return null

  // Prefer the server's total (could be larger than locally rendered
  // count if we paginate or optimistically discard items).
  const totalShown = totalPending ?? pendingItems.length
  const cappedAt = pendingItems.length < totalShown
  const headerLabel = cappedAt
    ? `${totalShown} transactions need review (showing ${pendingItems.length})`
    : `${pendingItems.length} transaction${pendingItems.length !== 1 ? 's' : ''} need review`

  return (
    <View style={pendingStyles.container} testID="pending-review-section">
      <TouchableOpacity
        style={pendingStyles.header}
        onPress={() => setCollapsed((v) => !v)}
        testID="pending-review-header"
      >
        <Text style={pendingStyles.headerText}>🔔  {headerLabel}</Text>
        <Text style={pendingStyles.toggleBtn}>{collapsed ? 'Show' : 'Hide'}</Text>
      </TouchableOpacity>

      {!collapsed &&
        pendingItems.map((item) => (
          <View key={item.id} style={pendingStyles.row} testID={`pending-row-${item.id}`}>
            <TouchableOpacity
              style={pendingStyles.rowBody}
              onPress={() => onApprove(item)}
              testID={`pending-tap-${item.id}`}
            >
              <View style={pendingStyles.rowTop}>
                <Text style={pendingStyles.merchant} numberOfLines={1}>
                  {item.merchant_name ?? item.name ?? 'Unknown'}
                </Text>
                <Text style={pendingStyles.amount}>{fmtUSD(item.amount)}</Text>
              </View>
              <Text style={pendingStyles.meta}>
                {item.date ?? ''}
                {item.institution_name ? ` · ${item.institution_name}` : ''}
                {item.account_name ? ` · ${item.account_name}` : ''}
              </Text>
            </TouchableOpacity>
            <View style={pendingStyles.actions}>
              <TouchableOpacity
                style={pendingStyles.approveBtn}
                onPress={() => onApprove(item)}
                testID={`pending-approve-${item.id}`}
              >
                <Text style={pendingStyles.approveBtnText}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={pendingStyles.saveUncatBtn}
                onPress={() => onSaveUncategorized(item)}
                testID={`pending-save-uncat-${item.id}`}
              >
                <Text style={pendingStyles.saveUncatBtnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={pendingStyles.discardBtn}
                onPress={() => onDiscard(item)}
                testID={`pending-discard-${item.id}`}
              >
                <Text style={pendingStyles.discardBtnText}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
    </View>
  )
}

const pendingStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fcd34d',
    paddingBottom: 10,  // breathing room under the last card
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fef3c7',
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
  },
  headerText: { fontSize: 14, fontWeight: '600', color: '#92400e', flex: 1 },
  toggleBtn: { fontSize: 13, color: '#b45309', fontWeight: '500' },
  // Each transaction is its own white card inside the amber container.
  row: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fde68a',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 10,
    marginTop: 10,
    // Light shadow lifts each card off the amber background
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  rowBody: { marginBottom: 8 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  merchant: { fontSize: 14, fontWeight: '600', color: '#111827', flex: 1, marginRight: 8 },
  amount: { fontSize: 14, fontWeight: '700', color: '#111827' },
  meta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  approveBtn: {
    flex: 1,
    backgroundColor: '#dcfce7',
    borderRadius: 6,
    paddingVertical: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#86efac',
  },
  approveBtnText: { fontSize: 13, fontWeight: '600', color: '#166534' },
  saveUncatBtn: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
    paddingVertical: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  saveUncatBtnText: { fontSize: 13, fontWeight: '600', color: '#374151' },
  discardBtn: {
    flex: 1,
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    paddingVertical: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  discardBtnText: { fontSize: 13, fontWeight: '600', color: '#991b1b' },
})

// ─── Modal styles ──────────────────────────────────────────────────────────────

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
  catChipActive: { backgroundColor: '#eef2ff', borderColor: '#2563eb' },
  catEmoji: { fontSize: 16, marginRight: 6 },
  catLabel: { fontSize: 13, color: '#374151', fontWeight: '500' },
  catLabelActive: { color: '#1d4ed8', fontWeight: '600' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
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
  advancedToggle: { paddingVertical: 8, marginBottom: 8 },
  advancedToggleText: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  chipText: { fontSize: 13, color: '#374151' },
  chipTextActive: { color: '#fff' },
  pendingMeta: {
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
    padding: 10,
    marginTop: 4,
  },
  pendingMetaText: { fontSize: 12, color: '#6b7280' },
})

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function TransactionsScreen() {
  const [showModal, setShowModal] = useState(false)
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [page, setPage] = useState(1)
  const { user, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

  // Plaid pending state
  const [approvingPending, setApprovingPending] = useState<PendingTransaction | null>(null)
  // IDs optimistically removed from the pending list (approved, discarded, saved)
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  // Items re-inserted by Undo (keyed by id to avoid duplicates)
  const [undoneItems, setUndoneItems] = useState<Map<string, PendingTransaction>>(new Map())
  const [snackbar, setSnackbar] = useState<SnackbarItem | null>(null)
  const discardTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', page],
    queryFn: () => expensesApi.list({ page, page_size: 20 }),
    enabled: !!user?.family_id,
  })

  const { data: pendingData } = useQuery({
    queryKey: ['plaid', 'pending'],
    // 200 is the backend cap; with the initial Plaid pull surfacing
    // 300+ pending we'd previously show only the first 50 with no
    // hint that more exist. A single 200-item fetch is still cheap
    // and matches the "review inbox" mental model better.
    queryFn: () => plaidApi.listPending(1, 200),
    enabled: !!user?.family_id,
  })

  // Derive local pending from server data minus removed IDs, plus undo'd items
  const localPending: PendingTransaction[] = (() => {
    const serverItems = pendingData?.pending ?? []
    const merged = new Map<string, PendingTransaction>()
    // Put undo'd items first
    undoneItems.forEach((item, id) => {
      if (!removedIds.has(id)) merged.set(id, item)
    })
    serverItems.forEach((item) => {
      if (!removedIds.has(item.id)) merged.set(item.id, item)
    })
    return Array.from(merged.values())
  })()

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

  const approveMutation = useMutation({
    mutationFn: ({
      id,
      edits,
    }: {
      id: string
      edits: ApproveEdits
    }) => plaidApi.approve(id, edits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setApprovingPending(null)
    },
    onError: () => Alert.alert('Error', 'Failed to approve transaction.'),
  })

  const saveUncatMutation = useMutation({
    mutationFn: (id: string) => plaidApi.saveUncategorized(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
    },
    onError: () => Alert.alert('Error', 'Failed to save transaction.'),
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

  const handleApprove = useCallback((item: PendingTransaction) => {
    setApprovingPending(item)
  }, [])

  const handleApproveSubmit = useCallback(
    (edits: ApproveEdits) => {
      if (!approvingPending) return
      // Optimistically remove from list
      setRemovedIds((prev) => new Set([...prev, approvingPending.id]))
      approveMutation.mutate({ id: approvingPending.id, edits })
    },
    [approvingPending, approveMutation]
  )

  const handleDiscard = useCallback(
    (item: PendingTransaction) => {
      // Optimistically remove
      setRemovedIds((prev) => new Set([...prev, item.id]))

      const label = `Discarded ${item.merchant_name ?? item.name ?? 'transaction'}`
      let undone = false

      const timer = setTimeout(() => {
        if (!undone) {
          plaidApi.discard(item.id).then(() => {
            queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
          })
        }
        discardTimers.current.delete(item.id)
      }, 5000)

      discardTimers.current.set(item.id, timer)

      setSnackbar({
        id: item.id,
        label,
        onUndo: () => {
          undone = true
          clearTimeout(timer)
          discardTimers.current.delete(item.id)
          // Remove from removedIds and re-add to undone items
          setRemovedIds((prev) => {
            const next = new Set(prev)
            next.delete(item.id)
            return next
          })
          setUndoneItems((prev) => new Map([...prev, [item.id, item]]))
        },
      })
    },
    [queryClient]
  )

  const handleSaveUncategorized = useCallback(
    (item: PendingTransaction) => {
      setRemovedIds((prev) => new Set([...prev, item.id]))
      saveUncatMutation.mutate(item.id)
    },
    [saveUncatMutation]
  )

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Transactions</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd} testID="add-expense-btn">
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={data?.expenses ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingTop: 0 }}
          testID="expenses-list"
          ListHeaderComponent={
            <PendingReviewSection
              pendingItems={localPending}
              onApprove={handleApprove}
              onDiscard={handleDiscard}
              onSaveUncategorized={handleSaveUncategorized}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptySubtitle}>Tap "+ Add" or connect a bank in Settings.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const isPlaid = !!(item as Expense & { source?: string }).source?.includes?.('plaid')
            return (
              <View style={[styles.expenseCard, { marginTop: 10 }]}>
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
                    {isPlaid && (
                      <View style={styles.plaidBadge}>
                        <Text style={styles.plaidBadgeText}>🏦</Text>
                      </View>
                    )}
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
            )
          }}
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

      <ApproveModal
        visible={!!approvingPending}
        pending={approvingPending}
        onClose={() => setApprovingPending(null)}
        onApprove={handleApproveSubmit}
        isApproving={approveMutation.isPending}
        familyMembers={familyMembers}
        currentUserId={user?.id ?? ''}
        accountType={null}
      />

      {snackbar && (
        <Snackbar
          item={snackbar}
          onDismiss={() => setSnackbar(null)}
        />
      )}
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, paddingTop: 48 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#9ca3af', textAlign: 'center' },
  expenseCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 0,
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
  plaidBadge: {
    marginLeft: 4,
    marginRight: 4,
  },
  plaidBadgeText: { fontSize: 12 },
  expenseDate: { fontSize: 12, color: '#9ca3af' },
  expenseMerchant: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  actions: { flexDirection: 'column', alignItems: 'flex-end', gap: 6, marginLeft: 8 },
  actionBtn: { padding: 4 },
  actionEdit: { fontSize: 13, color: '#2563eb' },
  actionDelete: { fontSize: 13, color: '#dc2626' },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { color: '#2563eb', fontSize: 14 },
})
