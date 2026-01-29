import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { PlusIcon, PencilIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { budgetsApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO } from '../types'
import type { BudgetCreate, BudgetPeriod, Budget, ExpenseCategory } from '../types'

const CATEGORIES: ExpenseCategory[] = [
  'groceries', 'dining', 'transportation', 'utilities', 'entertainment',
  'healthcare', 'shopping', 'travel', 'education', 'other',
]

interface BudgetFormData {
  name: string
  amount: number
  period: BudgetPeriod
  category: string
  beneficiary: string
}

export default function Budgets() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null)

  const { user, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

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
    },
  })

  const onSubmit = (formData: BudgetFormData) => {
    const budgetData: BudgetCreate = {
      name: formData.name,
      amount: formData.amount,
      period: formData.period,
      category: formData.category || undefined,
      beneficiary: formData.beneficiary || undefined,
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
                    ${status.budget.amount.toFixed(2)}
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
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_INFO[cat].label}
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
    </div>
  )
}
