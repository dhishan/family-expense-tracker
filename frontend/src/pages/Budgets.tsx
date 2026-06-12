import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { PlusIcon, PencilIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { budgetsApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO } from '../types'
import type { BudgetCreate, BudgetPeriod, Budget, ExpenseCategory } from '../types'

interface BudgetFormData {
  name: string
  amount: number
  period: BudgetPeriod
  category: string
  beneficiary: string
  rollover_enabled: boolean
}

export default function Budgets() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null)
  const [viewingTxBudget, setViewingTxBudget] = useState<Budget | null>(null)
  const [txScope, setTxScope] = useState<'current' | 'all'>('current')

  const { user, familyMembers, family } = useAuthStore()
  const queryClient = useQueryClient()

  // Use family categories or fallback to default
  const categories = family?.categories || [
    'groceries', 'dining', 'transportation', 'utilities', 'entertainment',
    'healthcare', 'shopping', 'travel', 'education', 'other',
  ]

  const { data, isLoading } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => budgetsApi.list(),
    enabled: !!user?.family_id,
  })

  const createMutation = useMutation({
    mutationFn: budgetsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setShowAddModal(false)
      toast.success('Budget created!')
    },
    onError: () => toast.error('Failed to create budget'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<BudgetFormData> }) =>
      budgetsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setEditingBudget(null)
      toast.success('Budget updated!')
    },
    onError: () => toast.error('Failed to update budget'),
  })

  const deleteMutation = useMutation({
    mutationFn: budgetsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.success('Budget deleted!')
    },
    onError: () => toast.error('Failed to delete budget'),
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<BudgetFormData>({
    defaultValues: {
      period: 'monthly',
      category: '',
      beneficiary: '',
      rollover_enabled: true,
    },
  })

  const onSubmit = (formData: BudgetFormData) => {
    const budgetData: BudgetCreate = {
      name: formData.name,
      amount: formData.amount,
      period: formData.period,
      category: formData.category || undefined,
      beneficiary: formData.beneficiary || undefined,
      rollover_enabled: formData.rollover_enabled,
    }

    if (editingBudget) {
      updateMutation.mutate({ id: editingBudget.id, data: budgetData })
    } else {
      createMutation.mutate(budgetData)
    }
  }

  const openEditModal = (budget: Budget) => {
    setEditingBudget(budget)
    reset({
      name: budget.name,
      amount: budget.amount,
      period: budget.period,
      category: budget.category || '',
      beneficiary: budget.beneficiary || '',
      rollover_enabled: budget.rollover_enabled ?? true,
    })
  }

  const openAddModal = () => {
    setEditingBudget(null)
    reset({
      name: '',
      amount: undefined as unknown as number,
      period: 'monthly',
      category: '',
      beneficiary: '',
      rollover_enabled: true,
    })
    setShowAddModal(true)
  }

  if (!user?.family_id) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Join a family to start creating budgets</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Budgets</h1>
        <button
          onClick={openAddModal}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
        >
          <PlusIcon className="h-5 w-5" />
          Create Budget
        </button>
      </div>

      {/* Budget cards */}
      {isLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
        </div>
      ) : data?.budgets && data.budgets.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {data.budgets.map((status) => (
            <div
              key={status.budget.id}
              className={`bg-white rounded-xl shadow-sm p-6 border-l-4 ${
                status.is_over_budget
                  ? 'border-red-500'
                  : status.percentage_used > 80
                  ? 'border-yellow-500'
                  : 'border-green-500'
              }`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-gray-900">{status.budget.name}</h3>
                  <p className="text-sm text-gray-500 capitalize">
                    {status.budget.period} budget
                    {status.budget.category && (
                      <> • {CATEGORY_INFO[status.budget.category as ExpenseCategory]?.label || status.budget.category}</>
                    )}
                  </p>
                  <p className="text-xs text-gray-400">
                    {new Date(status.period_start + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {' – '}
                    {new Date(status.period_end + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEditModal(status.budget)}
                    className="p-1 text-gray-400 hover:text-primary-600"
                  >
                    <PencilIcon className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this budget?')) {
                        deleteMutation.mutate(status.budget.id)
                      }
                    }}
                    className="p-1 text-gray-400 hover:text-red-600"
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-600">
                    ${status.spent.toFixed(2)} spent
                  </span>
                  <span className="font-medium text-gray-900">
                    ${(status.effective_amount ?? status.budget.amount).toFixed(2)}
                    {status.rollover_amount && status.rollover_amount > 0 ? (
                      <span className="ml-1 text-emerald-600 text-xs font-normal">
                        (+${status.rollover_amount.toFixed(2)} rolled over)
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      status.is_over_budget
                        ? 'bg-red-500'
                        : status.percentage_used > 80
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                    }`}
                    style={{ width: `${Math.min(status.percentage_used, 100)}%` }}
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Remaining</p>
                  <p className={`font-semibold ${status.remaining < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                    ${status.remaining.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Used</p>
                  <p className="font-semibold text-gray-900">
                    {status.percentage_used.toFixed(1)}%
                  </p>
                </div>
              </div>

              {/* Alert */}
              {status.is_over_budget && (
                <div className="mt-4 p-3 bg-red-50 rounded-lg">
                  <p className="text-sm text-red-700">
                    ⚠️ Over budget by ${Math.abs(status.remaining).toFixed(2)}
                  </p>
                </div>
              )}
              {!status.is_over_budget && status.percentage_used >= 80 && (
                <div className="mt-4 p-3 bg-yellow-50 rounded-lg">
                  <p className="text-sm text-yellow-700">
                    ⚠️ Approaching budget limit
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={() => setViewingTxBudget(status.budget)}
                className="mt-4 w-full text-sm text-primary-600 hover:text-primary-700 font-medium text-left"
              >
                View transactions →
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm p-12 text-center">
          <div className="text-5xl mb-4">📊</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">No budgets yet</h2>
          <p className="text-gray-600 mb-6">
            Create your first budget to start tracking spending limits
          </p>
          <button
            onClick={openAddModal}
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            <PlusIcon className="h-5 w-5" />
            Create Budget
          </button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {(showAddModal || editingBudget) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">
                {editingBudget ? 'Edit Budget' : 'Create Budget'}
              </h2>
              <button
                onClick={() => {
                  setShowAddModal(false)
                  setEditingBudget(null)
                }}
              >
                <XMarkIcon className="h-6 w-6 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Budget Name *
                </label>
                <input
                  type="text"
                  {...register('name', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="e.g., Monthly Groceries"
                />
                {errors.name && (
                  <p className="text-red-500 text-sm mt-1">Name is required</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Budget Amount *
                </label>
                <input
                  type="number"
                  step="0.01"
                  {...register('amount', { required: true, min: 0.01 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p className="text-red-500 text-sm mt-1">Valid amount is required</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Period
                </label>
                <select
                  {...register('period')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category (optional)
                </label>
                <select
                  {...register('category')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="">All Categories</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Leave empty to track all spending
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  For (optional)
                </label>
                <select
                  {...register('beneficiary')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="">Everyone</option>
                  <option value="family">Family Expenses Only</option>
                  {familyMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    {...register('rollover_enabled')}
                    className="mt-0.5 h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-gray-700">Roll over unused budget</span>
                    <span className="block text-xs text-gray-500">
                      Anything you don't spend this period carries forward and increases next period's limit. Cumulative, no cap.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddModal(false)
                    setEditingBudget(null)
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {createMutation.isPending || updateMutation.isPending
                    ? 'Saving...'
                    : editingBudget
                    ? 'Update'
                    : 'Create Budget'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewingTxBudget && (
        <BudgetTxModal
          budget={viewingTxBudget}
          scope={txScope}
          onScopeChange={setTxScope}
          onClose={() => { setViewingTxBudget(null); setTxScope('current') }}
        />
      )}
    </div>
  )
}

interface BudgetTxModalProps {
  budget: Budget
  scope: 'current' | 'all'
  onScopeChange: (s: 'current' | 'all') => void
  onClose: () => void
}

function BudgetTxModal({ budget, scope, onScopeChange, onClose }: BudgetTxModalProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['budgets', 'transactions', budget.id, scope],
    queryFn: () => budgetsApi.listTransactions(budget.id, scope),
    staleTime: 30_000,
  })
  const total = (data?.expenses ?? []).reduce((s, e) => s + e.amount, 0)
  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative ml-auto h-full w-full sm:w-[28rem] bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{budget.name}</h2>
            <p className="text-xs text-gray-500 capitalize">{budget.period} • transactions</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700" aria-label="Close">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 text-xs">
          <button
            onClick={() => onScopeChange('current')}
            className={`px-2 py-1 rounded ${scope === 'current' ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            This period
          </button>
          <button
            onClick={() => onScopeChange('all')}
            className={`px-2 py-1 rounded ${scope === 'all' ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            Since start
          </button>
          <div className="ml-auto text-gray-500">{data?.total ?? 0} txns · ${total.toFixed(2)}</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
          ) : !data || data.expenses.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">No transactions for this budget yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.expenses.map((e) => (
                <li key={e.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 truncate">
                      {e.merchant || e.description || CATEGORY_INFO[e.category as ExpenseCategory]?.label || e.category}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {format(new Date(e.date + 'T00:00:00'), 'MMM d')}
                      {e.merchant && e.description ? ` · ${e.description}` : ''}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-gray-900 shrink-0">${e.amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
