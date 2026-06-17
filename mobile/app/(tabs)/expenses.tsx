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
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { expensesApi, plaidApi, budgetsApi, rulesApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { CATEGORY_INFO } from '@/types'
import type { ExpenseCategory, ExpenseCreate, Expense, PendingTransaction, PaymentMethod, BudgetStatus, ApproveSplitPayload, MerchantRule } from '@/types'

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
  budget_id: string | null
}

// ─── Budget dropdown picker (shared by Approve modal + Add/Edit modal) ────
//
// Touchable field that opens a bottom-sheet style modal listing every
// family budget grouped by period, with live "X% used" inline. Replaces
// the previous horizontal chip row that scaled badly past ~5 budgets.
interface BudgetPickerProps {
  budgets: BudgetStatus[]
  selectedBudgetId: string | null
  onSelect: (budgetId: string | null) => void
  // Optional filter: when set, only budgets matching this category (or
  // catch-all budgets with category=null) appear by default; user can
  // toggle "Show all" to see every budget.
  filterByCategory?: ExpenseCategory | null
  testID?: string
}

function BudgetPicker({
  budgets,
  selectedBudgetId,
  onSelect,
  filterByCategory,
  testID,
}: BudgetPickerProps) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  if (budgets.length === 0) return null

  const selected = budgets.find((b) => b.budget.id === selectedBudgetId)

  const visible = filterByCategory && !showAll
    ? budgets.filter(
        (b) => !b.budget.category || b.budget.category === filterByCategory,
      )
    : budgets

  // Group by period for the picker list
  const grouped: Record<string, BudgetStatus[]> = {}
  for (const b of visible) {
    const k = b.budget.period
    if (!grouped[k]) grouped[k] = []
    grouped[k].push(b)
  }
  const orderedPeriods = ['weekly', 'monthly', 'yearly']

  const label = selected
    ? selected.budget.name
    : selectedBudgetId
    ? '(deleted budget)'
    : 'None — don\'t pin to a budget'

  return (
    <>
      <TouchableOpacity
        style={budgetPickerStyles.field}
        onPress={() => setOpen(true)}
        testID={testID ?? 'budget-picker-field'}
      >
        <Text style={budgetPickerStyles.fieldLabel} numberOfLines={1}>
          {label}
        </Text>
        {selected ? (
          <Text style={budgetPickerStyles.fieldMeta}>
            {Math.round(selected.percentage_used)}% used
          </Text>
        ) : null}
        <Text style={budgetPickerStyles.fieldChevron}>▾</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <View style={budgetPickerStyles.backdrop}>
          <View style={budgetPickerStyles.sheet}>
            <View style={budgetPickerStyles.sheetHeader}>
              <Text style={budgetPickerStyles.sheetTitle}>Choose budget</Text>
              {filterByCategory ? (
                <TouchableOpacity onPress={() => setShowAll((v) => !v)}>
                  <Text style={budgetPickerStyles.showAllText}>
                    {showAll ? 'Show relevant' : 'Show all'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setOpen(false)}>
                  <Text style={budgetPickerStyles.closeText}>Close</Text>
                </TouchableOpacity>
              )}
            </View>
            <ScrollView style={{ maxHeight: 480 }}>
              {/* None option always at top */}
              <TouchableOpacity
                style={budgetPickerStyles.row}
                onPress={() => {
                  onSelect(null)
                  setOpen(false)
                }}
              >
                <Text style={budgetPickerStyles.rowName}>None</Text>
                {!selectedBudgetId ? (
                  <Text style={budgetPickerStyles.rowCheck}>✓</Text>
                ) : null}
              </TouchableOpacity>
              {orderedPeriods.map((p) => {
                const items = grouped[p] ?? []
                if (items.length === 0) return null
                return (
                  <View key={p}>
                    <Text style={budgetPickerStyles.groupHeader}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </Text>
                    {items.map((bs) => {
                      const active = bs.budget.id === selectedBudgetId
                      return (
                        <TouchableOpacity
                          key={bs.budget.id}
                          style={budgetPickerStyles.row}
                          onPress={() => {
                            onSelect(bs.budget.id)
                            setOpen(false)
                          }}
                          testID={`budget-picker-row-${bs.budget.id}`}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={budgetPickerStyles.rowName}>
                              {bs.budget.name}
                            </Text>
                            <Text
                              style={[
                                budgetPickerStyles.rowMeta,
                                bs.is_over_budget && budgetPickerStyles.rowMetaOver,
                              ]}
                            >
                              ${bs.spent.toFixed(0)} of ${bs.budget.amount.toFixed(0)}{' · '}
                              {Math.round(bs.percentage_used)}% used
                              {bs.budget.category ? ` · ${bs.budget.category}` : ''}
                            </Text>
                          </View>
                          {active ? (
                            <Text style={budgetPickerStyles.rowCheck}>✓</Text>
                          ) : null}
                        </TouchableOpacity>
                      )
                    })}
                  </View>
                )
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  )
}

const budgetPickerStyles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    marginBottom: 16,
  },
  fieldLabel: { flex: 1, fontSize: 15, color: '#111827' },
  fieldMeta: { fontSize: 12, color: '#6b7280', marginLeft: 8 },
  fieldChevron: { fontSize: 14, color: '#6b7280', marginLeft: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  sheetTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  showAllText: { fontSize: 14, color: '#2563eb' },
  closeText: { fontSize: 14, color: '#6b7280' },
  groupHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  rowName: { fontSize: 15, color: '#111827', fontWeight: '500' },
  rowMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  rowMetaOver: { color: '#dc2626' },
  rowCheck: { fontSize: 18, color: '#2563eb', marginLeft: 12 },
})

function defaultForm(): ExpenseFormData {
  return {
    budget_id: null,
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

interface SplitRow {
  key: number
  amount: string
  category: ExpenseCategory
  budget_id: string | null
  beneficiary: string
}

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
  saveAsRule?: boolean
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
  onApproveSplit?: (payload: ApproveSplitPayload) => void
  isApprovingSplit?: boolean
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
  onApproveSplit,
  isApprovingSplit = false,
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  // Rule checkbox (single-budget mode only)
  const [saveAsRule, setSaveAsRule] = useState(false)
  // Split mode
  const [splitMode, setSplitMode] = useState(false)
  const [splits, setSplits] = useState<SplitRow[]>([])
  const [splitUnit, setSplitUnit] = useState<'$' | '%'>('$')
  const splitKeyRef = useRef(0)

  const { data: budgetsData } = useQuery({
    queryKey: ['budgets', 'list'],
    queryFn: budgetsApi.list,
    enabled: visible,
  })
  const budgets: BudgetStatus[] = budgetsData?.budgets ?? []

  const { data: rulesData } = useQuery({
    queryKey: ['rules', 'merchant'],
    queryFn: rulesApi.list,
    enabled: visible,
  })
  const existingRules: MerchantRule[] = rulesData ?? []
  const merchantLower = merchant.trim().toLowerCase()
  const ruleAlreadyExists = merchantLower.length > 0
    && existingRules.some((r) => r.merchant.toLowerCase() === merchantLower)

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
      setTags('')
      const suggestedBudget = pending.suggested_budget_id
        ? budgets.find((b) => b.budget.id === pending.suggested_budget_id)?.budget
        : undefined
      setBudgetId(pending.suggested_budget_id ?? null)
      // Beneficiary follows the suggested budget when present; otherwise current user
      if (suggestedBudget) {
        setBeneficiary(suggestedBudget.beneficiary ?? '')
        if (suggestedBudget.category) {
          setCategory(suggestedBudget.category as ExpenseCategory)
        }
      } else {
        setBeneficiary(currentUserId)
      }
      setCategoryManuallySet(false)
      setSaveAsRule(false)
      setSplitMode(false)
      setSplits([])
    }
  }, [pending, visible, currentUserId, accountType, budgets])

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
    // Budgets with null beneficiary = family-wide → '' selects the Family chip
    setBeneficiary(bs.budget.beneficiary ?? '')
  }

  // Split-mode helpers
  const enterSplitMode = () => {
    const firstKey = ++splitKeyRef.current
    setSplits([
      {
        key: firstKey,
        amount: amount,
        category: category,
        budget_id: budgetId,
        beneficiary: beneficiary,
      },
    ])
    setSplitMode(true)
  }

  const exitSplitMode = () => {
    if (splits.length > 0) {
      const first = splits[0]
      setAmount(first.amount)
      setCategory(first.category)
      setBudgetId(first.budget_id)
      setBeneficiary(first.beneficiary)
    }
    setSplitMode(false)
    setSplits([])
  }

  const addSplit = () => {
    const last = splits[splits.length - 1]
    const allocated = splits.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
    const total = parseFloat(amount) || 0
    const remaining = Math.max(0, total - allocated)
    const newKey = ++splitKeyRef.current
    setSplits((prev) => [
      ...prev,
      {
        key: newKey,
        amount: remaining > 0 ? remaining.toFixed(2) : '',
        category: last?.category ?? 'other',
        budget_id: last?.budget_id ?? null,
        beneficiary: last?.beneficiary ?? '',
      },
    ])
  }

  const updateSplit = (key: number, changes: Partial<SplitRow>) => {
    setSplits((prev) => prev.map((r) => (r.key === key ? { ...r, ...changes } : r)))
  }

  const removeSplit = (key: number) => {
    setSplits((prev) => prev.filter((r) => r.key !== key))
  }

  const handleSplitApprove = () => {
    // Anchor to the original pending amount, NOT the editable form field —
    // backend compares sum(splits) to pending.amount and 400s on drift.
    const totalAmt = Math.abs(pending?.amount ?? parseFloat(amount) ?? 0)
    if (isNaN(totalAmt) || totalAmt <= 0) {
      Alert.alert('Validation', 'Enter a valid total amount.')
      return
    }
    if (splits.length < 2) {
      Alert.alert('Validation', 'Add at least 2 splits, or use single budget approve.')
      return
    }
    if (splits.some((r) => (parseFloat(r.amount) || 0) <= 0)) {
      Alert.alert('Validation', 'All splits must have an amount greater than 0.')
      return
    }
    const allocated = splits.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
    const target = splitUnit === '%' ? 100 : totalAmt
    if (Math.abs(allocated - target) > 0.01) {
      Alert.alert(
        'Validation',
        splitUnit === '%'
          ? `Allocated ${allocated.toFixed(2)}% must equal 100%.`
          : `Allocated ${fmtUSD(allocated)} doesn't match total ${fmtUSD(totalAmt)}.`
      )
      return
    }
    // Convert % rows to $ at submit; allocate any rounding remainder to the last row.
    const toDollars = (raw: string): number => {
      const n = parseFloat(raw) || 0
      return splitUnit === '%' ? (n / 100) * totalAmt : n
    }
    const rawDollars = splits.map((r) => toDollars(r.amount))
    const rounded = rawDollars.map((v) => Math.round(v * 100) / 100)
    const remainder = Math.round((totalAmt - rounded.reduce((s, v) => s + v, 0)) * 100) / 100
    if (rounded.length > 0) {
      rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + remainder) * 100) / 100
    }
    const tagsArr = tags.split(',').map((t) => t.trim()).filter(Boolean)
    onApproveSplit?.({
      splits: splits.map((r, i) => ({
        amount: rounded[i],
        category: r.category,
        budget_id: r.budget_id,
        beneficiary: r.beneficiary || null,
      })),
      merchant: merchant.trim(),
      date: date || toLocalISODate(),
      payment_method: paymentMethod,
      description: description.trim() || undefined,
      tags: tagsArr.length > 0 ? tagsArr : undefined,
    })
  }

  const handleApprove = () => {
    if (splitMode) {
      handleSplitApprove()
      return
    }
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
      saveAsRule: saveAsRule && !ruleAlreadyExists,
    })
  }

  // Derived split validity — anchored to pending.amount (see handleSplitApprove)
  const totalAmt = Math.abs(pending?.amount ?? parseFloat(amount) ?? 0)
  const allocated = splits.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
  const allocationTarget = splitUnit === '%' ? 100 : totalAmt
  const splitIsBalanced = Math.abs(allocated - allocationTarget) <= 0.01
  const splitAllPositive = splits.every((r) => (parseFloat(r.amount) || 0) > 0)

  const toggleSplitUnit = (next: '$' | '%') => {
    if (next === splitUnit) return
    if (totalAmt > 0) {
      setSplits((prev) =>
        prev.map((r) => {
          const v = parseFloat(r.amount) || 0
          return {
            ...r,
            amount: next === '%'
              ? ((v / totalAmt) * 100).toFixed(2)
              : ((v / 100) * totalAmt).toFixed(2),
          }
        })
      )
    }
    setSplitUnit(next)
  }
  const splitDisabled = splitMode && (splits.length < 2 || !splitIsBalanced || !splitAllPositive)

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
            <TouchableOpacity
              onPress={handleApprove}
              disabled={isApproving || isApprovingSplit || splitDisabled}
            >
              {isApproving || isApprovingSplit ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text
                  style={[
                    modalStyles.save,
                    splitDisabled && { color: '#9ca3af' },
                  ]}
                >
                  Approve
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Category chips — hidden in split mode */}
          {!splitMode && (
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
          )}

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

              {/* Split toggle */}
              {!splitMode ? (
                <TouchableOpacity
                  style={splitStyles.splitToggleBtn}
                  onPress={enterSplitMode}
                  testID="split-toggle-btn"
                >
                  <Text style={splitStyles.splitToggleText}>⊕  Split across budgets</Text>
                </TouchableOpacity>
              ) : (
                <View style={splitStyles.splitsSection}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={modalStyles.label}>Splits</Text>
                    <View style={splitStyles.unitToggle}>
                      <TouchableOpacity
                        onPress={() => toggleSplitUnit('$')}
                        style={[splitStyles.unitBtn, splitUnit === '$' && splitStyles.unitBtnActive]}
                      >
                        <Text style={[splitStyles.unitBtnText, splitUnit === '$' && splitStyles.unitBtnTextActive]}>$ Amount</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => toggleSplitUnit('%')}
                        style={[splitStyles.unitBtn, splitUnit === '%' && splitStyles.unitBtnActive]}
                      >
                        <Text style={[splitStyles.unitBtnText, splitUnit === '%' && splitStyles.unitBtnTextActive]}>% Percent</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {splits.map((row, idx) => (
                    <SplitCard
                      key={row.key}
                      index={idx}
                      row={row}
                      budgets={budgets}
                      familyMembers={familyMembers}
                      onUpdate={updateSplit}
                      onRemove={removeSplit}
                      canRemove={splits.length > 2}
                      unit={splitUnit}
                      totalAmt={totalAmt}
                    />
                  ))}
                  <TouchableOpacity
                    style={splitStyles.addSplitBtn}
                    onPress={addSplit}
                    testID="add-split-btn"
                  >
                    <Text style={splitStyles.addSplitText}>+ Add split</Text>
                  </TouchableOpacity>
                  {/* Allocated indicator */}
                  <View style={splitStyles.allocBar}>
                    <Text
                      style={[
                        splitStyles.allocText,
                        splitIsBalanced ? splitStyles.allocOk : splitStyles.allocBad,
                      ]}
                    >
                      {splitUnit === '%'
                        ? `Allocated ${allocated.toFixed(2)}% / 100.00%`
                        : `Allocated ${fmtUSD(allocated)} / ${fmtUSD(totalAmt)}`}
                      {splitIsBalanced ? '  ✓' : ''}
                    </Text>
                  </View>
                  {/* Use single budget */}
                  <TouchableOpacity
                    style={splitStyles.useSingleBtn}
                    onPress={exitSplitMode}
                    testID="use-single-budget-btn"
                  >
                    <Text style={splitStyles.useSingleText}>Use a single budget</Text>
                  </TouchableOpacity>
                </View>
              )}

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

              <TouchableOpacity
                onPress={() => setShowAdvanced((v) => !v)}
                style={{ marginBottom: 8 }}
                testID="approve-advanced-toggle"
              >
                <Text style={{ fontSize: 13, color: '#6b7280' }}>
                  {showAdvanced ? '▾ Advanced' : '▸ Advanced'}
                </Text>
              </TouchableOpacity>
              {showAdvanced && (
                <>
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
                </>
              )}

              {/* Budget and For — hidden in split mode */}
              {!splitMode && budgets.length > 0 && (
                <>
                  <Text style={modalStyles.label}>Budget</Text>
                  <BudgetPicker
                    budgets={budgets}
                    selectedBudgetId={budgetId}
                    onSelect={(id) => {
                      const bs = budgets.find((b) => b.budget.id === id)
                      if (bs) {
                        handleBudgetSelect(bs)
                      } else {
                        handleBudgetSelect(null)
                      }
                    }}
                    filterByCategory={category}
                    testID="approve-budget-picker"
                  />
                </>
              )}

              {!splitMode && familyMembers.length > 1 && (
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
                        beneficiary === '' && modalStyles.chipActive,
                      ]}
                      onPress={() => setBeneficiary('')}
                    >
                      <Text
                        style={[
                          modalStyles.chipText,
                          beneficiary === '' && modalStyles.chipTextActive,
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

              {/* Auto-rule checkbox — single-budget mode only */}
              {!splitMode && merchant.trim().length > 0 && (
                ruleAlreadyExists ? (
                  <Text style={ruleStyles.alreadyExists}>
                    Rule already exists. Delete it in Settings to change.
                  </Text>
                ) : (
                  <TouchableOpacity
                    style={ruleStyles.checkRow}
                    onPress={() => setSaveAsRule((v) => !v)}
                    activeOpacity={0.7}
                    testID="save-as-rule-checkbox"
                  >
                    <View style={[ruleStyles.checkbox, saveAsRule && ruleStyles.checkboxChecked]}>
                      {saveAsRule && <Text style={ruleStyles.checkmark}>✓</Text>}
                    </View>
                    <Text style={ruleStyles.checkLabel}>
                      Always apply to future &ldquo;{merchant.trim()}&rdquo; transactions
                    </Text>
                  </TouchableOpacity>
                )
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

// ─── Split card (one per split row inside ApproveModal split mode) ─────────────

interface SplitCardProps {
  index: number
  row: SplitRow
  budgets: BudgetStatus[]
  familyMembers: { id: string; display_name: string }[]
  onUpdate: (key: number, changes: Partial<SplitRow>) => void
  onRemove: (key: number) => void
  canRemove: boolean
  unit: '$' | '%'
  totalAmt: number
}

function SplitCard({
  index,
  row,
  budgets,
  familyMembers,
  onUpdate,
  onRemove,
  canRemove,
  unit,
  totalAmt,
}: SplitCardProps) {
  const handleBudgetSelect = (id: string | null) => {
    const bs = id ? budgets.find((b) => b.budget.id === id) : null
    const changes: Partial<SplitRow> = { budget_id: id }
    if (bs) {
      if (bs.budget.category) {
        changes.category = bs.budget.category as ExpenseCategory
      }
      changes.beneficiary = bs.budget.beneficiary ?? ''
    }
    onUpdate(row.key, changes)
  }

  return (
    <View style={splitStyles.card}>
      <View style={splitStyles.cardHeader}>
        <Text style={splitStyles.cardTitle}>Split {index + 1}</Text>
        {canRemove && (
          <TouchableOpacity
            onPress={() => onRemove(row.key)}
            testID={`remove-split-${index}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={splitStyles.removeBtn}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Amount or Percent */}
      <View style={[modalStyles.amountRow, { marginBottom: unit === '%' && totalAmt > 0 ? 4 : 12 }]}>
        {unit === '$' && <Text style={modalStyles.dollar}>$</Text>}
        <TextInput
          style={[modalStyles.amountInput, { fontSize: 18 }]}
          value={row.amount}
          onChangeText={(v) => onUpdate(row.key, { amount: v })}
          keyboardType="decimal-pad"
          placeholder="0.00"
          testID={`split-amount-${index}`}
        />
        {unit === '%' && <Text style={modalStyles.dollar}>%</Text>}
      </View>
      {unit === '%' && totalAmt > 0 && (
        <Text style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
          ≈ {fmtUSD(((parseFloat(row.amount) || 0) / 100) * totalAmt)}
        </Text>
      )}

      {/* Budget */}
      <BudgetPicker
        budgets={budgets}
        selectedBudgetId={row.budget_id}
        onSelect={handleBudgetSelect}
        filterByCategory={row.category}
        testID={`split-budget-picker-${index}`}
      />

      {/* For */}
      {familyMembers.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 8 }}
        >
          <TouchableOpacity
            style={[modalStyles.chip, row.beneficiary === '' && modalStyles.chipActive]}
            onPress={() => onUpdate(row.key, { beneficiary: '' })}
          >
            <Text style={[modalStyles.chipText, row.beneficiary === '' && modalStyles.chipTextActive]}>
              Family
            </Text>
          </TouchableOpacity>
          {familyMembers.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[modalStyles.chip, row.beneficiary === m.id && modalStyles.chipActive]}
              onPress={() => onUpdate(row.key, { beneficiary: m.id })}
            >
              <Text style={[modalStyles.chipText, row.beneficiary === m.id && modalStyles.chipTextActive]}>
                {m.display_name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

const splitStyles = StyleSheet.create({
  splitToggleBtn: {
    paddingVertical: 10,
    marginBottom: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#dbeafe',
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderStyle: 'dashed',
  },
  splitToggleText: { fontSize: 14, color: '#2563eb', fontWeight: '600' },
  splitsSection: { marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#f9fafb',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: '#374151' },
  removeBtn: { fontSize: 16, color: '#9ca3af' },
  addSplitBtn: {
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    marginBottom: 12,
  },
  addSplitText: { fontSize: 14, color: '#6b7280' },
  unitToggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 8,
  },
  unitBtn: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#fff' },
  unitBtnActive: { backgroundColor: '#2563eb' },
  unitBtnText: { fontSize: 11, color: '#6b7280' },
  unitBtnTextActive: { color: '#fff', fontWeight: '600' },
  allocBar: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    marginBottom: 10,
    alignItems: 'center',
  },
  allocText: { fontSize: 14, fontWeight: '600' },
  allocOk: { color: '#16a34a' },
  allocBad: { color: '#dc2626' },
  useSingleBtn: { alignItems: 'center', paddingVertical: 8, marginBottom: 8 },
  useSingleText: { fontSize: 13, color: '#6b7280', textDecorationLine: 'underline' },
})

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

const ruleStyles = StyleSheet.create({
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingVertical: 4,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    flexShrink: 0,
  },
  checkboxChecked: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  checkmark: {
    fontSize: 13,
    color: '#fff',
    fontWeight: '700',
    lineHeight: 16,
  },
  checkLabel: {
    flex: 1,
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  },
  alreadyExists: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 16,
    fontStyle: 'italic',
  },
})

// ─── Add/Edit modal ────────────────────────────────────────────────────────────

interface AddEditModalProps {
  visible: boolean
  editing: Expense | null
  onClose: () => void
  onSave: (data: ExpenseCreate) => void
  isSaving: boolean
  familyMembers: { id: string; display_name: string }[]
  budgets: BudgetStatus[]
}

function AddEditModal({
  visible,
  editing,
  onClose,
  onSave,
  isSaving,
  familyMembers,
  budgets,
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
          budget_id: editing.budget_id ?? null,
        }
      : defaultForm()
  )

  // AddEditModal stays mounted in the parent tree, so useState's initializer
  // only runs once. Re-seed the form whenever `editing` flips (open Add → open
  // Edit, or switch between expenses) or the modal re-opens.
  useEffect(() => {
    if (!visible) return
    setForm(
      editing
        ? {
            amount: String(editing.amount),
            description: editing.description,
            merchant: editing.merchant ?? '',
            category: editing.category,
            date: editing.date,
            beneficiary: editing.beneficiary,
            budget_id: editing.budget_id ?? null,
          }
        : defaultForm(),
    )
  }, [editing, visible])

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
      budget_id: form.budget_id,
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

                  {budgets.length > 0 && (
                    <>
                      <Text style={modalStyles.label}>Budget</Text>
                      <BudgetPicker
                        budgets={budgets}
                        selectedBudgetId={form.budget_id}
                        onSelect={(id) =>
                          setForm((prev) => ({ ...prev, budget_id: id }))
                        }
                        filterByCategory={form.category}
                        testID="addedit-budget-picker"
                      />
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
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
  onApprove: (item: PendingTransaction) => void
  onDiscard: (item: PendingTransaction) => void
  onSaveUncategorized: (item: PendingTransaction) => void
}

function PendingReviewSection({
  pendingItems,
  totalPending,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onApprove,
  onDiscard,
  onSaveUncategorized,
}: PendingReviewSectionProps) {
  // Default collapsed — the section is noisy when you have many
  // pending items and most opens of the screen aren't a review session.
  const [collapsed, setCollapsed] = useState(true)

  if (pendingItems.length === 0) return null

  const totalShown = totalPending ?? pendingItems.length
  const headerLabel = `${totalShown} transaction${totalShown !== 1 ? 's' : ''} need review`

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

      {!collapsed && hasMore && (
        <TouchableOpacity
          style={pendingStyles.loadMoreBtn}
          onPress={onLoadMore}
          disabled={isLoadingMore}
          testID="pending-load-more"
        >
          {isLoadingMore ? (
            <ActivityIndicator size="small" color="#92400e" />
          ) : (
            <Text style={pendingStyles.loadMoreText}>
              Load more ({(totalPending ?? 0) - pendingItems.length} remaining)
            </Text>
          )}
        </TouchableOpacity>
      )}
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
  loadMoreBtn: {
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fcd34d',
  },
  loadMoreText: { fontSize: 14, fontWeight: '600', color: '#92400e' },
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
  const { user, family, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

  // URL-hydrated filter set so dashboard taps can deep-link. Same shape
  // as the web side; setters reset to page 1.
  const localParams = useLocalSearchParams<{
    beneficiary?: string
    category?: string
    payment_method?: string
    start_date?: string
    end_date?: string
  }>()
  const [filters, setFilters] = useState<{
    beneficiary?: string
    category?: ExpenseCategory
    payment_method?: PaymentMethod
    start_date?: string
    end_date?: string
  }>({})
  const [filtersOpen, setFiltersOpen] = useState(false)
  useEffect(() => {
    const next: typeof filters = {}
    if (localParams.beneficiary) next.beneficiary = String(localParams.beneficiary)
    if (localParams.category) next.category = String(localParams.category) as ExpenseCategory
    if (localParams.payment_method) next.payment_method = String(localParams.payment_method) as PaymentMethod
    if (localParams.start_date) next.start_date = String(localParams.start_date)
    if (localParams.end_date) next.end_date = String(localParams.end_date)
    if (Object.keys(next).length > 0) {
      setFilters(next)
      setFiltersOpen(true)
      setPage(1)
    }
  }, [
    localParams.beneficiary,
    localParams.category,
    localParams.payment_method,
    localParams.start_date,
    localParams.end_date,
  ])

  // Plaid pending state
  const [approvingPending, setApprovingPending] = useState<PendingTransaction | null>(null)
  // IDs optimistically removed from the pending list (approved, discarded, saved)
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  // Items re-inserted by Undo (keyed by id to avoid duplicates)
  const [undoneItems, setUndoneItems] = useState<Map<string, PendingTransaction>>(new Map())
  const [snackbar, setSnackbar] = useState<SnackbarItem | null>(null)
  const discardTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Paginated infinite query — accumulates expenses across pages so
  // "Load more" appends rows beneath instead of replacing the page (and
  // scrolling back to the top, which the previous useQuery+page state
  // was doing). `page` is kept around to invalidate on filter change.
  const {
    data: expensesPages,
    isLoading,
    fetchNextPage: fetchNextExpenses,
    hasNextPage: hasMoreExpenses,
    isFetchingNextPage: isFetchingMoreExpenses,
  } = useInfiniteQuery({
    queryKey: ['expenses', filters],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      expensesApi.list({ page: pageParam as number, page_size: 20, ...filters }),
    getNextPageParam: (last) => (last.has_more ? last.page + 1 : undefined),
    enabled: !!user?.family_id,
  })
  // Flattened list across all loaded pages for the FlatList.
  const data = expensesPages
    ? {
        expenses: expensesPages.pages.flatMap((p) => p.expenses),
        has_more: expensesPages.pages[expensesPages.pages.length - 1]?.has_more ?? false,
      }
    : undefined

  // Budgets are fetched at the parent so the AddEditModal can pre-fill
  // its Budget dropdown without each child re-querying. ApproveModal also
  // queries; React Query dedupes by key.
  const { data: budgetsData } = useQuery({
    queryKey: ['budgets', 'list'],
    queryFn: budgetsApi.list,
    enabled: !!user?.family_id,
  })
  const budgets: BudgetStatus[] = budgetsData?.budgets ?? []

  const PENDING_PAGE_SIZE = 50
  const {
    data: pendingData,
    fetchNextPage: fetchNextPending,
    hasNextPage: hasMorePending,
    isFetchingNextPage: isFetchingMorePending,
  } = useInfiniteQuery({
    queryKey: ['plaid', 'pending'],
    queryFn: ({ pageParam = 1 }) => plaidApi.listPending(pageParam, PENDING_PAGE_SIZE),
    enabled: !!user?.family_id,
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.pending.length, 0)
      return loaded < lastPage.total ? allPages.length + 1 : undefined
    },
  })
  const pendingServerTotal = pendingData?.pages[0]?.total ?? 0

  // Derive local pending from server data minus removed IDs, plus undo'd items
  const localPending: PendingTransaction[] = (() => {
    const serverItems = pendingData?.pages.flatMap((p) => p.pending) ?? []
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

  const removePendingFromCache = (id: string) => {
    queryClient.setQueryData(
      ['plaid', 'pending'],
      (old: { pages: { pending: PendingTransaction[]; total: number }[]; pageParams: number[] } | undefined) => {
        if (!old) return old
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            pending: p.pending.filter((t) => t.id !== id),
            total: Math.max(0, p.total - 1),
          })),
        }
      }
    )
  }

  const approveMutation = useMutation({
    mutationFn: ({
      id,
      edits,
    }: {
      id: string
      edits: ApproveEdits
    }) => plaidApi.approve(id, edits),
    onSuccess: (_data, vars) => {
      removePendingFromCache(vars.id)
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setApprovingPending(null)
      // If user opted in to auto-rule, fire it non-blocking (409 = already exists, safe to ignore)
      if (vars.edits.saveAsRule && vars.edits.merchant.trim()) {
        rulesApi.create({
          merchant_name: vars.edits.merchant.trim(),
          category: vars.edits.category,
          budget_id: vars.edits.budget_id ?? null,
          beneficiary: vars.edits.beneficiary || null,
        }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
        }).catch((err: { response?: { status?: number } }) => {
          if (err?.response?.status !== 409) {
            Alert.alert('Note', 'Expense approved. Could not save auto-rule.')
          }
        })
      }
    },
    onError: () => Alert.alert('Error', 'Failed to approve transaction.'),
  })

  const approveSplitMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: ApproveSplitPayload
    }) => plaidApi.approveSplit(id, payload),
    onSuccess: (data, vars) => {
      removePendingFromCache(vars.id)
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setApprovingPending(null)
      Alert.alert('Done', `Transaction split into ${data.expense_ids.length} expenses.`)
    },
    onError: () => Alert.alert('Error', 'Failed to split transaction.'),
  })

  const saveUncatMutation = useMutation({
    mutationFn: (id: string) => plaidApi.saveUncategorized(id),
    onSuccess: (_data, id) => {
      removePendingFromCache(id)
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

  const handleApproveSplitSubmit = useCallback(
    (payload: ApproveSplitPayload) => {
      if (!approvingPending) return
      setRemovedIds((prev) => new Set([...prev, approvingPending.id]))
      approveSplitMutation.mutate({ id: approvingPending.id, payload })
    },
    [approvingPending, approveSplitMutation]
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
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: filtersOpen ? '#eef2ff' : '#f1f5f9' }]}
            onPress={() => setFiltersOpen((v) => !v)}
            testID="toggle-filters-btn"
          >
            <Text style={[styles.addBtnText, { color: filtersOpen ? '#4338ca' : '#475569' }]}>
              Filter{Object.keys(filters).length > 0 ? ` (${Object.keys(filters).length})` : ''}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.addBtn} onPress={openAdd} testID="add-expense-btn">
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {filtersOpen && (
        <View style={filterStyles.panel}>
          <Text style={filterStyles.label}>Person</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filterStyles.chipsRow}>
            <TouchableOpacity
              onPress={() => setFilters((f) => ({ ...f, beneficiary: undefined }))}
              style={[filterStyles.chip, !filters.beneficiary && filterStyles.chipActive]}
            >
              <Text style={[filterStyles.chipText, !filters.beneficiary && filterStyles.chipTextActive]}>Whole family</Text>
            </TouchableOpacity>
            {familyMembers.map((m) => {
              const active = filters.beneficiary === m.id
              const label = family?.beneficiary_labels?.[m.id] || m.display_name
              return (
                <TouchableOpacity
                  key={m.id}
                  onPress={() => setFilters((f) => ({ ...f, beneficiary: active ? undefined : m.id }))}
                  style={[filterStyles.chip, active && filterStyles.chipActive]}
                >
                  <Text style={[filterStyles.chipText, active && filterStyles.chipTextActive]}>{label}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          <Text style={filterStyles.label}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filterStyles.chipsRow}>
            <TouchableOpacity
              onPress={() => setFilters((f) => ({ ...f, category: undefined }))}
              style={[filterStyles.chip, !filters.category && filterStyles.chipActive]}
            >
              <Text style={[filterStyles.chipText, !filters.category && filterStyles.chipTextActive]}>All</Text>
            </TouchableOpacity>
            {(family?.categories ?? Object.keys(CATEGORY_INFO)).map((cat) => {
              const active = filters.category === cat
              const label = CATEGORY_INFO[cat as ExpenseCategory]?.label || cat
              return (
                <TouchableOpacity
                  key={cat}
                  onPress={() => setFilters((f) => ({ ...f, category: active ? undefined : (cat as ExpenseCategory) }))}
                  style={[filterStyles.chip, active && filterStyles.chipActive]}
                >
                  <Text style={[filterStyles.chipText, active && filterStyles.chipTextActive]}>{label}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          {Object.keys(filters).length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setFilters({})
                setPage(1)
              }}
              style={{ alignSelf: 'flex-end', marginTop: 4 }}
            >
              <Text style={{ color: '#2563eb', fontSize: 13 }}>Clear all</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

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
              totalPending={pendingServerTotal}
              hasMore={hasMorePending}
              isLoadingMore={isFetchingMorePending}
              onLoadMore={() => fetchNextPending()}
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
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasMoreExpenses && !isFetchingMoreExpenses) {
              fetchNextExpenses()
            }
          }}
          ListFooterComponent={
            hasMoreExpenses ? (
              <TouchableOpacity
                style={styles.loadMore}
                onPress={() => {
                  if (!isFetchingMoreExpenses) fetchNextExpenses()
                }}
                disabled={isFetchingMoreExpenses}
              >
                {isFetchingMoreExpenses ? (
                  <ActivityIndicator size="small" color="#2563eb" />
                ) : (
                  <Text style={styles.loadMoreText}>Load more</Text>
                )}
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
        budgets={budgets}
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
        onApproveSplit={handleApproveSplitSubmit}
        isApprovingSplit={approveSplitMutation.isPending}
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

const filterStyles = StyleSheet.create({
  panel: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  label: { fontSize: 12, color: '#6b7280', fontWeight: '600', marginTop: 4 },
  chipsRow: { gap: 6, paddingVertical: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActive: { backgroundColor: '#eef2ff', borderColor: '#6366f1' },
  chipText: { fontSize: 12, color: '#475569' },
  chipTextActive: { color: '#4338ca', fontWeight: '600' },
})

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
