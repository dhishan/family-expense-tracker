import { useState, useRef, useEffect } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import {
  FunnelIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
  BanknotesIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline'
import { expensesApi, plaidApi, budgetsApi, rulesApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO, PAYMENT_METHOD_LABELS } from '../types'
import type { ExpenseCreate, ExpenseCategory, PaymentMethod, Expense, PendingTransaction, BudgetStatus, PendingListResponse, PendingApproveSplit } from '../types'
import QuickAddStrip from '../components/QuickAddStrip'

interface EditFormData {
  amount: number
  date: string
  description: string
  merchant: string
  category: ExpenseCategory
  beneficiary: string
}

interface ApproveFormData {
  amount: number
  date: string
  category: ExpenseCategory
  description: string
  merchant: string
  payment_method: string
  beneficiary: string
  tags: string
  budget_id?: string
}

interface SplitRow {
  amount: string
  category: ExpenseCategory
  budget_id: string
  beneficiary: string
}

// ---------------------------------------------------------------------------
// Pending review row
// ---------------------------------------------------------------------------

interface PendingRowProps {
  tx: PendingTransaction
  onApproveClick: (tx: PendingTransaction) => void
  onSaveUncategorized: (tx: PendingTransaction) => void
  onDiscardClick: (tx: PendingTransaction) => void
}

function PendingRow({ tx, onApproveClick, onSaveUncategorized, onDiscardClick }: PendingRowProps) {
  const dateStr = tx.date || tx.authorized_date
  const formattedDate = dateStr
    ? format(new Date(dateStr + 'T00:00:00'), 'MMM d')
    : ''
  const accountSuffix = tx.account_name
    ? `${tx.institution_name} ${tx.account_name}`
    : tx.institution_name

  const isIncome = tx.is_income === true

  if (isIncome) {
    return (
      <div className="p-4 border border-green-200 rounded-lg bg-green-50">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium text-gray-900 truncate">
                {tx.merchant_name || tx.name || 'Unknown source'}
              </p>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
                💰 Income
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              {formattedDate && `${formattedDate} · `}{accountSuffix}
            </p>
          </div>
          <span className="ml-4 text-base font-semibold text-green-700 whitespace-nowrap">
            +${Math.abs(tx.amount).toFixed(2)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={() => onDiscardClick(tx)}
            className="px-3 py-1.5 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            Discard
          </button>
          <button
            onClick={() => onApproveClick(tx)}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Record as expense anyway
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 border border-amber-200 rounded-lg bg-white">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 truncate">
            {tx.merchant_name || tx.name || 'Unknown merchant'}
          </p>
          <p className="text-sm text-gray-500 mt-0.5">
            {formattedDate && `${formattedDate} · `}{accountSuffix}
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Suggested: {CATEGORY_INFO[tx.suggested_category]?.label || tx.suggested_category}
          </p>
        </div>
        <span className="ml-4 text-base font-semibold text-gray-900 whitespace-nowrap">
          ${Math.abs(tx.amount).toFixed(2)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          onClick={() => onApproveClick(tx)}
          className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          Approve &amp; edit
        </button>
        <button
          onClick={() => onSaveUncategorized(tx)}
          className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Save uncategorized
        </button>
        <button
          onClick={() => onDiscardClick(tx)}
          className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
        >
          Discard
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Transactions page
// ---------------------------------------------------------------------------

export default function Transactions() {
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [approvingTx, setApprovingTx] = useState<PendingTransaction | null>(null)
  const [approvingIsIncome, setApprovingIsIncome] = useState(false)
  const [incomeConfirmed, setIncomeConfirmed] = useState(false)
  const [filters, setFilters] = useState<{
    category?: ExpenseCategory
    start_date?: string
    end_date?: string
  }>({})
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [pendingHidden, setPendingHidden] = useState(false)
  const [approveBudgetId, setApproveBudgetId] = useState<string | undefined>(undefined)
  const [splitMode, setSplitMode] = useState(false)
  const [splits, setSplits] = useState<SplitRow[]>([])
  const [splitUnit, setSplitUnit] = useState<'$' | '%'>('$')
  const [saveAsRule, setSaveAsRule] = useState(false)

  // Discard undo buffer: map id -> { tx, timerId }
  const discardBuffer = useRef<Map<string, { tx: PendingTransaction; timerId: ReturnType<typeof setTimeout> }>>(new Map())
  // Optimistically hidden pending ids (discarded but API not yet called)
  const [optimisticallyDiscarded, setOptimisticallyDiscarded] = useState<Set<string>>(new Set())

  const { user, familyMembers, family } = useAuthStore()
  const queryClient = useQueryClient()

  const categories = family?.categories || [
    'groceries', 'dining', 'transportation', 'utilities', 'entertainment',
    'healthcare', 'shopping', 'travel', 'education', 'other',
  ]

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', page, filters],
    queryFn: () => expensesApi.list({ page, page_size: 20, ...filters }),
    enabled: !!user?.family_id,
  })

  const { data: allExpensesData } = useQuery({
    queryKey: ['expenses-merchants'],
    queryFn: () => expensesApi.list({ page: 1, page_size: 200 }),
    enabled: !!user?.family_id,
    staleTime: 5 * 60 * 1000,
  })

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
    refetchInterval: 60_000,
  })
  const pendingTotal = pendingData?.pages[0]?.total ?? 0
  const allPending = pendingData?.pages.flatMap((p) => p.pending) ?? []

  const { data: budgetsData } = useQuery({
    queryKey: ['budgets', 'list'],
    queryFn: budgetsApi.list,
    enabled: !!user?.family_id,
    staleTime: 2 * 60 * 1000,
  })
  const budgets: BudgetStatus[] = budgetsData?.budgets ?? []

  const { data: rulesData } = useQuery({
    queryKey: ['rules', 'merchant'],
    queryFn: rulesApi.list,
    enabled: !!user?.family_id,
    staleTime: 2 * 60 * 1000,
  })
  const existingRules = rulesData?.rules ?? []

  const visiblePending = allPending.filter(
    (tx) => !optimisticallyDiscarded.has(tx.id)
  )

  // Infinite-scroll sentinel
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasMorePending) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isFetchingMorePending) fetchNextPending()
      },
      { rootMargin: '200px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMorePending, isFetchingMorePending, fetchNextPending])

  const pastMerchants = Array.from(
    new Set(
      (allExpensesData?.expenses ?? [])
        .map((e) => e.merchant)
        .filter((m): m is string => !!m && m.trim().length > 0)
    )
  ).sort()

  const createMutation = useMutation({
    mutationFn: expensesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      queryClient.invalidateQueries({ queryKey: ['expenses-merchants'] })
      toast.success('Expense added!')
    },
    onError: () => toast.error('Failed to add expense'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EditFormData> }) =>
      expensesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setEditingExpense(null)
      toast.success('Expense updated!')
    },
    onError: () => toast.error('Failed to update expense'),
  })

  const deleteMutation = useMutation({
    mutationFn: expensesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Expense deleted!')
    },
    onError: () => toast.error('Failed to delete expense'),
  })

  type ApproveEdits = {
    amount?: number
    date?: string
    category?: string
    description?: string
    merchant?: string
    payment_method?: string
    beneficiary?: string
    tags?: string[]
    is_income_override?: boolean
    budget_id?: string
  }

  const approveMutation = useMutation({
    mutationFn: ({ id, edits }: { id: string; edits: ApproveEdits }) =>
      plaidApi.approve(id, edits),
    onSuccess: (_data, vars) => {
      // Surgical removal from the infinite query cache — avoids re-fetching
      // every loaded page sequentially.
      queryClient.setQueryData(
        ['plaid', 'pending'],
        (old: { pages: PendingListResponse[]; pageParams: number[] } | undefined) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              pending: p.pending.filter((t) => t.id !== vars.id),
              total: Math.max(0, p.total - 1),
            })),
          }
        }
      )
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setApprovingTx(null)
      toast.success('Transaction approved!')
    },
    onError: () => toast.error('Failed to approve transaction'),
  })

  const approveSplitMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PendingApproveSplit }) =>
      plaidApi.approveSplit(id, payload),
    onSuccess: (_data, vars) => {
      queryClient.setQueryData(
        ['plaid', 'pending'],
        (old: { pages: PendingListResponse[]; pageParams: number[] } | undefined) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              pending: p.pending.filter((t) => t.id !== vars.id),
              total: Math.max(0, p.total - 1),
            })),
          }
        }
      )
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      const n = vars.payload.splits.length
      setApprovingTx(null)
      setSplitMode(false)
      setSplits([])
      toast.success(`Transaction split into ${n} expense${n !== 1 ? 's' : ''}`)
    },
    onError: () => toast.error('Failed to split transaction'),
  })

  const saveUncategorizedMutation = useMutation({
    mutationFn: plaidApi.saveUncategorized,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Saved as uncategorized!')
    },
    onError: () => toast.error('Failed to save transaction'),
  })

  const discardMutation = useMutation({
    mutationFn: plaidApi.discard,
    onError: () => toast.error('Failed to discard transaction'),
  })

  // Edit expense form
  const {
    register,
    handleSubmit,
    reset,
  } = useForm<EditFormData>()

  // Approve pending form
  const {
    register: registerApprove,
    handleSubmit: handleApproveSubmit,
    reset: resetApprove,
    setValue: setValueApprove,
    getValues: getValuesApprove,
    watch: watchApprove,
  } = useForm<ApproveFormData>()

  const onEditSubmit = (data: EditFormData) => {
    if (!editingExpense) return
    updateMutation.mutate({ id: editingExpense.id, data })
  }

  const openEditModal = (expense: Expense) => {
    setEditingExpense(expense)
    reset({
      amount: expense.amount,
      date: expense.date,
      description: expense.description,
      merchant: expense.merchant || '',
      category: expense.category,
      beneficiary: expense.beneficiary,
    })
  }

  const openApproveModal = (tx: PendingTransaction) => {
    setApprovingTx(tx)
    setApprovingIsIncome(tx.is_income === true)
    setIncomeConfirmed(false)
    setApproveBudgetId(tx.suggested_budget_id ?? undefined)
    setSplitMode(false)
    setSplits([])
    setSaveAsRule(false)
    const dateStr = tx.date || tx.authorized_date || ''
    resetApprove({
      amount: Math.abs(tx.amount),
      date: dateStr,
      category: tx.suggested_category,
      description: tx.merchant_name || tx.name || '',
      merchant: tx.merchant_name || '',
      payment_method: 'credit',
      beneficiary: user?.id || '',
      tags: '',
      budget_id: tx.suggested_budget_id ?? undefined,
    })
  }

  const onApproveSubmit = async (data: ApproveFormData) => {
    if (!approvingTx) return
    // For income rows: require the confirmation banner to be acked
    if (approvingIsIncome && !incomeConfirmed) {
      setIncomeConfirmed(true)
      return
    }
    const tagsArr = data.tags
      ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : []

    // If "always apply" is checked, POST rule first (non-fatal on 409).
    // Coerce fields and surface validation errors so a silent 422 doesn't
    // leave the user wondering why no rule was created.
    if (saveAsRule) {
      const merchantStr = (data.merchant || '').trim()
      const categoryStr = (data.category || '').trim()
      if (!merchantStr || !categoryStr) {
        toast.error('Could not create rule: merchant and category are required')
      } else {
        try {
          await rulesApi.create({
            merchant_name: merchantStr,
            category: categoryStr,
            budget_id: approveBudgetId || null,
            beneficiary: (data.beneficiary || '').toString() || null,
          })
          toast.success(`Rule saved for "${merchantStr}"`)
          queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } })?.response?.status
          if (status === 409) {
            toast('Rule already exists for this merchant', { icon: 'ℹ️' })
          } else if (status === 422) {
            toast.error('Rule rejected by backend (validation error)')
            console.error('rules.create 422 payload:', { merchant_name: merchantStr, category: categoryStr, budget_id: approveBudgetId, beneficiary: data.beneficiary })
          } else {
            toast.error('Failed to save rule')
            console.error('rules.create error:', err)
          }
        }
      }
    }

    approveMutation.mutate({
      id: approvingTx.id,
      edits: {
        amount: data.amount,
        date: data.date || undefined,
        category: data.category,
        description: data.description,
        merchant: data.merchant || undefined,
        payment_method: data.payment_method || undefined,
        beneficiary: data.beneficiary,
        tags: tagsArr,
        is_income_override: approvingIsIncome,
        budget_id: approveBudgetId || undefined,
      },
    })
  }

  const onApproveSplitSubmit = (data: ApproveFormData) => {
    if (!approvingTx) return
    const tagsArr = data.tags
      ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : []
    // In % mode, the row's `amount` holds a percent (0-100); convert to dollars
    // using the transaction total. In $ mode, it already holds dollars.
    const toDollars = (raw: string): number => {
      const n = parseFloat(raw) || 0
      return splitUnit === '%' ? (n / 100) * splitTotalAmount : n
    }
    // Round each split to cents; allocate any rounding remainder to the last row.
    const rawDollars = splits.map((r) => toDollars(r.amount))
    const rounded = rawDollars.map((v) => Math.round(v * 100) / 100)
    const remainder = Math.round((splitTotalAmount - rounded.reduce((s, v) => s + v, 0)) * 100) / 100
    if (rounded.length > 0) rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + remainder) * 100) / 100
    approveSplitMutation.mutate({
      id: approvingTx.id,
      payload: {
        splits: splits.map((r, i) => ({
          amount: rounded[i],
          category: r.category,
          budget_id: r.budget_id || null,
          beneficiary: r.beneficiary,
        })),
        merchant: data.merchant || undefined,
        date: data.date || undefined,
        payment_method: data.payment_method || undefined,
        description: data.description || undefined,
        tags: tagsArr,
      },
    })
  }

  // Helpers for split mode.
  // Anchor to the original pending amount, NOT the editable form field.
  // The backend compares sum(splits) to pending.amount; if the user edited
  // the Amount before entering split mode (or react-hook-form returned a
  // string with float drift), the splits would sum to a different value
  // and the backend would 400 with a sum mismatch.
  const splitTotalAmount = Math.abs(approvingTx?.amount ?? 0)
  const allocatedTotal = splits.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0)
  // In % mode, allocations sum to 100; in $ mode, to splitTotalAmount.
  const allocationTarget = splitUnit === '%' ? 100 : splitTotalAmount
  const splitAllocationOk =
    Math.abs(allocatedTotal - allocationTarget) < 0.01 &&
    splits.length > 0 &&
    splits.every((r) => parseFloat(r.amount) > 0)

  const updateSplitRow = (idx: number, patch: Partial<SplitRow>) => {
    setSplits((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const removeSplitRow = (idx: number) => {
    setSplits((prev) => prev.filter((_, i) => i !== idx))
  }

  const addSplitRow = () => {
    const prev = splits[splits.length - 1]
    const remaining = Math.max(0, allocationTarget - allocatedTotal)
    setSplits((s) => [
      ...s,
      {
        amount: remaining > 0 ? remaining.toFixed(2) : '',
        category: prev?.category ?? (getValuesApprove('category') as ExpenseCategory),
        budget_id: prev?.budget_id ?? approveBudgetId ?? '',
        beneficiary: prev?.beneficiary ?? getValuesApprove('beneficiary'),
      },
    ])
  }

  const toggleSplitUnit = (next: '$' | '%') => {
    if (next === splitUnit) return
    if (splitTotalAmount > 0) {
      setSplits((prev) =>
        prev.map((r) => {
          const v = parseFloat(r.amount) || 0
          if (next === '%') {
            return { ...r, amount: ((v / splitTotalAmount) * 100).toFixed(2) }
          } else {
            return { ...r, amount: ((v / 100) * splitTotalAmount).toFixed(2) }
          }
        })
      )
    }
    setSplitUnit(next)
  }

  const enterSplitMode = () => {
    const currentAmount = parseFloat(String(getValuesApprove('amount'))) || Math.abs(approvingTx?.amount ?? 0)
    setSplits([
      {
        amount: currentAmount.toFixed(2),
        category: getValuesApprove('category') as ExpenseCategory,
        budget_id: approveBudgetId ?? '',
        beneficiary: getValuesApprove('beneficiary'),
      },
    ])
    setSplitMode(true)
  }

  const exitSplitMode = () => {
    // Restore top-level fields from first split if available
    if (splits.length > 0) {
      const first = splits[0]
      setValueApprove('category', first.category)
      setValueApprove('beneficiary', first.beneficiary)
      setApproveBudgetId(first.budget_id || undefined)
    }
    setSplitMode(false)
    setSplits([])
  }

  const handleDiscard = (tx: PendingTransaction) => {
    // Immediately hide the row
    setOptimisticallyDiscarded((prev) => new Set([...prev, tx.id]))

    // Show toast with undo
    const toastId = toast(
      (t) => (
        <span>
          Discarded &quot;{tx.merchant_name || tx.name || 'transaction'}&quot;.{' '}
          <button
            className="underline font-medium"
            onClick={() => {
              // Cancel the pending API call
              const entry = discardBuffer.current.get(tx.id)
              if (entry) {
                clearTimeout(entry.timerId)
                discardBuffer.current.delete(tx.id)
              }
              setOptimisticallyDiscarded((prev) => {
                const next = new Set(prev)
                next.delete(tx.id)
                return next
              })
              toast.dismiss(t.id)
            }}
          >
            Undo
          </button>
        </span>
      ),
      { duration: 5000 }
    )

    // Call API after 5s unless undone
    const timerId = setTimeout(() => {
      discardBuffer.current.delete(tx.id)
      discardMutation.mutate(tx.id, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['plaid', 'pending'] })
          toast.dismiss(toastId)
        },
      })
    }, 5000)

    discardBuffer.current.set(tx.id, { tx, timerId })
  }

  if (!user?.family_id) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Join a family to start tracking transactions</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <FunnelIcon className="h-5 w-5" />
          Filters
        </button>
      </div>

      {/* Pending Review section */}
      {visiblePending.length > 0 && (
        <div className="border border-amber-300 bg-amber-50 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-200">
            <div className="flex items-center gap-2">
              <span className="text-amber-600">🔔</span>
              <span className="font-semibold text-amber-900">
                {pendingTotal} transaction{pendingTotal !== 1 ? 's' : ''} need review
              </span>
            </div>
            <button
              onClick={() => setPendingHidden((h) => !h)}
              className="flex items-center gap-1 text-sm text-amber-700 hover:text-amber-900"
            >
              {pendingHidden ? (
                <>Show <ChevronDownIcon className="h-4 w-4" /></>
              ) : (
                <>Hide <ChevronUpIcon className="h-4 w-4" /></>
              )}
            </button>
          </div>

          {!pendingHidden && (
            <div className="p-4 space-y-3">
              {visiblePending.map((tx) => (
                <PendingRow
                  key={tx.id}
                  tx={tx}
                  onApproveClick={openApproveModal}
                  onSaveUncategorized={(t) => saveUncategorizedMutation.mutate(t.id)}
                  onDiscardClick={handleDiscard}
                />
              ))}
              {hasMorePending && (
                <div ref={loadMoreRef} className="py-3 text-center text-sm text-amber-700">
                  {isFetchingMorePending ? 'Loading more…' : 'Scroll for more'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Quick Add Strip */}
      <QuickAddStrip
        categories={categories}
        familyMembers={familyMembers}
        pastMerchants={pastMerchants}
        onSubmit={(data: ExpenseCreate) => createMutation.mutate(data)}
        isSubmitting={createMutation.isPending}
      />

      {/* Filters */}
      {showFilters && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={filters.category || ''}
                onChange={(e) =>
                  setFilters({ ...filters, category: e.target.value as ExpenseCategory || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={filters.start_date || ''}
                onChange={(e) =>
                  setFilters({ ...filters, start_date: e.target.value || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={filters.end_date || ''}
                onChange={(e) =>
                  setFilters({ ...filters, end_date: e.target.value || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
          </div>
          <button
            onClick={() => setFilters({})}
            className="mt-4 text-sm text-primary-600 hover:text-primary-700"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Expense list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          </div>
        ) : data?.expenses && data.expenses.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Description
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Category
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.expenses.map((expense) => {
                    const isPlaid = (expense as Expense & { source?: string }).source === 'plaid'
                    return (
                      <tr key={expense.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {format(new Date(expense.date + 'T00:00:00'), 'MMM d, yyyy')}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-gray-900">
                              {expense.description}
                            </div>
                            {isPlaid && (
                              <span
                                title="Imported from bank"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 rounded"
                              >
                                <BanknotesIcon className="h-3 w-3" />
                                Bank
                              </span>
                            )}
                          </div>
                          {expense.merchant && (
                            <div className="text-sm text-gray-500">{expense.merchant}</div>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                              CATEGORY_INFO[expense.category]?.bgColor
                            } ${CATEGORY_INFO[expense.category]?.color}`}
                          >
                            {CATEGORY_INFO[expense.category]?.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          ${expense.amount.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <button
                            onClick={() => openEditModal(expense)}
                            className="text-gray-400 hover:text-primary-600 p-1"
                          >
                            <PencilIcon className="h-5 w-5" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm('Delete this expense?')) {
                                deleteMutation.mutate(expense.id)
                              }
                            }}
                            className="text-gray-400 hover:text-red-600 p-1 ml-2"
                          >
                            <TrashIcon className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-6 py-4 border-t flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing {data.expenses.length} of {data.total} transactions
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 border rounded disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!data.has_more}
                  className="px-3 py-1 border rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="p-8 text-center text-gray-500">
            No transactions found. Add your first expense above!
          </div>
        )}
      </div>

      {/* Edit Expense Modal */}
      {editingExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Edit Expense</h2>
              <button onClick={() => setEditingExpense(null)}>
                <XMarkIcon className="h-6 w-6 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit(onEditSubmit)} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  {...register('amount', { required: true, min: 0.01 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
                <input
                  type="date"
                  {...register('date', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
                <input
                  type="text"
                  {...register('description')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Note..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Merchant</label>
                <input
                  type="text"
                  {...register('merchant')}
                  list="merchants-datalist"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Store or vendor name"
                  autoComplete="off"
                />
                <datalist id="merchants-datalist">
                  {pastMerchants.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                <select
                  {...register('category', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">For</label>
                <select
                  {...register('beneficiary')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="family">Entire Family</option>
                  {familyMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setEditingExpense(null)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Approve Pending Transaction Modal */}
      {approvingTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Approve Transaction</h2>
              <button onClick={() => setApprovingTx(null)}>
                <XMarkIcon className="h-6 w-6 text-gray-500" />
              </button>
            </div>

            {/* Income confirmation banner — shown after first "Approve" click on an income row */}
            {approvingIsIncome && incomeConfirmed && (
              <div className="mx-4 mt-4 p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800">
                <p className="font-medium mb-2">
                  This transaction looks like income. Recording it as an expense will count ${Math.abs(approvingTx.amount).toFixed(2)} toward your budgets. Continue?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      // User confirmed — now actually submit
                      handleApproveSubmit(async (data) => {
                        const tagsArr = data.tags
                          ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
                          : []
                        if (saveAsRule && data.merchant) {
                          try {
                            await rulesApi.create({
                              merchant_name: data.merchant,
                              category: data.category,
                              budget_id: approveBudgetId ?? null,
                              beneficiary: data.beneficiary,
                            })
                            queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
                          } catch (err: unknown) {
                            const status = (err as { response?: { status?: number } })?.response?.status
                            if (status === 409) toast('Rule already exists', { icon: 'ℹ️' })
                          }
                        }
                        approveMutation.mutate({
                          id: approvingTx.id,
                          edits: {
                            amount: data.amount,
                            date: data.date || undefined,
                            category: data.category,
                            description: data.description,
                            merchant: data.merchant || undefined,
                            payment_method: data.payment_method || undefined,
                            beneficiary: data.beneficiary,
                            tags: tagsArr,
                            is_income_override: true,
                            budget_id: approveBudgetId || undefined,
                          },
                        })
                      })()
                    }}
                    className="px-3 py-1 bg-yellow-700 text-white rounded text-xs font-medium hover:bg-yellow-800"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setIncomeConfirmed(false)}
                    className="px-3 py-1 border border-yellow-400 text-yellow-800 rounded text-xs hover:bg-yellow-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleApproveSubmit(splitMode ? onApproveSplitSubmit : onApproveSubmit)} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  {...registerApprove('amount', { required: true, min: 0.01 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="0.00"
                  readOnly={splitMode}
                />
                {!splitMode && (
                  <button
                    type="button"
                    onClick={enterSplitMode}
                    className="mt-1.5 text-xs text-primary-600 hover:text-primary-700 underline"
                  >
                    Split across budgets
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
                <input
                  type="date"
                  {...registerApprove('date', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
                <input
                  type="text"
                  {...registerApprove('description')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Note..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Merchant</label>
                <input
                  type="text"
                  {...registerApprove('merchant')}
                  list="approve-merchants-datalist"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Store or vendor name"
                  autoComplete="off"
                />
                <datalist id="approve-merchants-datalist">
                  {pastMerchants.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              <details className="group">
                <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 select-none">
                  Advanced
                </summary>
                <div className="mt-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment method</label>
                  <select
                    {...registerApprove('payment_method')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((pm) => (
                      <option key={pm} value={pm}>
                        {PAYMENT_METHOD_LABELS[pm]}
                      </option>
                    ))}
                  </select>
                </div>
              </details>

              {!splitMode && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                  <select
                    {...registerApprove('category', { required: !splitMode })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Budget picker — single mode only */}
              {!splitMode && budgets.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Budget</label>
                  <select
                    value={approveBudgetId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value || undefined
                      setApproveBudgetId(id)
                      if (id) {
                        const b = budgets.find((bs) => bs.budget.id === id)?.budget
                        if (b?.category) setValueApprove('category', b.category as ExpenseCategory)
                        if (b?.beneficiary) setValueApprove('beneficiary', b.beneficiary)
                      }
                    }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    <option value="">None</option>
                    {(() => {
                      const periodOrder: Record<string, number> = { weekly: 0, monthly: 1, yearly: 2 }
                      const groups: Record<string, BudgetStatus[]> = { weekly: [], monthly: [], yearly: [] }
                      budgets
                        .slice()
                        .sort((a, b) => (periodOrder[a.budget.period] ?? 3) - (periodOrder[b.budget.period] ?? 3))
                        .forEach((bs) => {
                          const p = bs.budget.period
                          if (groups[p]) groups[p].push(bs)
                        })
                      return (['weekly', 'monthly', 'yearly'] as const)
                        .filter((p) => groups[p].length > 0)
                        .map((p) => (
                          <optgroup key={p} label={p.charAt(0).toUpperCase() + p.slice(1)}>
                            {groups[p].map((bs) => (
                              <option key={bs.budget.id} value={bs.budget.id}>
                                {bs.budget.name} ({Math.round(bs.percentage_used)}% used
                                {bs.is_over_budget ? ' • over' : ''})
                              </option>
                            ))}
                          </optgroup>
                        ))
                    })()}
                  </select>
                </div>
              )}

              {!splitMode && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">For</label>
                  <select
                    {...registerApprove('beneficiary')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    <option value="family">Entire Family</option>
                    {familyMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.display_name}
                      </option>
                    ))}
                  </select>

                  {/* Always-apply rule checkbox — single mode only */}
                  {(() => {
                    const merchantVal = watchApprove('merchant')
                    if (!merchantVal) return null
                    const ruleExists = existingRules.some(
                      (r) => r.merchant_name.toLowerCase() === merchantVal.toLowerCase()
                    )
                    if (ruleExists) {
                      return (
                        <p className="mt-2 text-xs text-gray-500">
                          A rule already exists for this merchant. Delete it in{' '}
                          <a href="/settings/auto-rules" className="underline text-primary-600">
                            Settings
                          </a>{' '}
                          to change.
                        </p>
                      )
                    }
                    return (
                      <label className="flex items-start gap-2 mt-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={saveAsRule}
                          onChange={(e) => setSaveAsRule(e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700">
                          Always apply this categorization to future &ldquo;{merchantVal}&rdquo; transactions
                        </span>
                      </label>
                    )
                  })()}
                </div>
              )}

              {/* Split mode UI */}
              {splitMode && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">Splits</span>
                    <div className="flex items-center gap-3">
                      <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
                        <button
                          type="button"
                          onClick={() => toggleSplitUnit('$')}
                          className={`px-2 py-0.5 ${splitUnit === '$' ? 'bg-primary-600 text-white' : 'bg-white text-gray-600'}`}
                        >
                          $ Amount
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleSplitUnit('%')}
                          className={`px-2 py-0.5 ${splitUnit === '%' ? 'bg-primary-600 text-white' : 'bg-white text-gray-600'}`}
                        >
                          % Percent
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={exitSplitMode}
                        className="text-xs text-primary-600 hover:text-primary-700 underline"
                      >
                        Use a single budget
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {splits.map((row, idx) => (
                      <div key={idx} className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50">
                        <div className="flex items-center gap-2">
                          <div className="w-32 shrink-0">
                            <label className="block text-xs text-gray-500 mb-0.5">
                              {splitUnit === '%' ? 'Percent' : 'Amount'}
                            </label>
                            <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden bg-white">
                              {splitUnit === '$' && <span className="px-2 text-gray-500 text-sm">$</span>}
                              <input
                                type="number"
                                step="0.01"
                                min="0.01"
                                value={row.amount}
                                onChange={(e) => updateSplitRow(idx, { amount: e.target.value })}
                                className="flex-1 py-1.5 pr-2 text-sm focus:outline-none w-16"
                                placeholder="0.00"
                              />
                              {splitUnit === '%' && <span className="px-2 text-gray-500 text-sm">%</span>}
                            </div>
                            {splitUnit === '%' && splitTotalAmount > 0 && (
                              <p className="text-[10px] text-gray-500 mt-0.5">
                                ≈ ${(((parseFloat(row.amount) || 0) / 100) * splitTotalAmount).toFixed(2)}
                              </p>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <label className="block text-xs text-gray-500 mb-0.5">Budget</label>
                            <select
                              value={row.budget_id}
                              onChange={(e) => {
                                const id = e.target.value
                                const b = budgets.find((bs) => bs.budget.id === id)?.budget
                                updateSplitRow(idx, {
                                  budget_id: id,
                                  ...(b?.category ? { category: b.category as ExpenseCategory } : {}),
                                  ...(b?.beneficiary ? { beneficiary: b.beneficiary } : {}),
                                })
                              }}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
                            >
                              <option value="">None</option>
                              {(() => {
                                const periodOrder: Record<string, number> = { weekly: 0, monthly: 1, yearly: 2 }
                                const groups: Record<string, BudgetStatus[]> = { weekly: [], monthly: [], yearly: [] }
                                budgets
                                  .slice()
                                  .sort((a, b) => (periodOrder[a.budget.period] ?? 3) - (periodOrder[b.budget.period] ?? 3))
                                  .forEach((bs) => {
                                    const p = bs.budget.period
                                    if (groups[p]) groups[p].push(bs)
                                  })
                                return (['weekly', 'monthly', 'yearly'] as const)
                                  .filter((p) => groups[p].length > 0)
                                  .map((p) => (
                                    <optgroup key={p} label={p.charAt(0).toUpperCase() + p.slice(1)}>
                                      {groups[p].map((bs) => (
                                        <option key={bs.budget.id} value={bs.budget.id}>
                                          {bs.budget.name}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))
                              })()}
                            </select>
                          </div>
                          {splits.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeSplitRow(idx)}
                              className="mt-4 text-gray-400 hover:text-red-500 shrink-0"
                            >
                              <XMarkIcon className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-0.5">For</label>
                          <select
                            value={row.beneficiary}
                            onChange={(e) => updateSplitRow(idx, { beneficiary: e.target.value })}
                            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
                          >
                            <option value="family">Entire Family</option>
                            {familyMembers.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.display_name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={addSplitRow}
                    className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700"
                  >
                    <span className="text-lg leading-none">⊕</span> Add another split
                  </button>

                  {/* Allocated indicator */}
                  <div className={`flex items-center gap-1 text-sm font-medium ${splitAllocationOk ? 'text-green-600' : 'text-red-600'}`}>
                    {splitUnit === '%'
                      ? `Allocated: ${allocatedTotal.toFixed(2)}% / 100.00%`
                      : `Allocated: $${allocatedTotal.toFixed(2)} / $${splitTotalAmount.toFixed(2)}`}
                    {splitAllocationOk && ' ✓'}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
                <input
                  type="text"
                  {...registerApprove('tags')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Comma-separated tags..."
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => { setApprovingTx(null); setSplitMode(false); setSplits([]) }}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    splitMode
                      ? (!splitAllocationOk || approveSplitMutation.isPending)
                      : approveMutation.isPending
                  }
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {splitMode
                    ? (approveSplitMutation.isPending ? 'Saving...' : 'Save splits')
                    : (approveMutation.isPending ? 'Approving...' : 'Approve')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
