import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import {
  PlusIcon,
  FunnelIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { expensesApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO, PAYMENT_METHOD_LABELS } from '../types'
import type { ExpenseCreate, ExpenseCategory, PaymentMethod, Expense } from '../types'

const CATEGORIES: ExpenseCategory[] = [
  'groceries', 'dining', 'transportation', 'utilities', 'entertainment',
  'healthcare', 'shopping', 'travel', 'education', 'other',
]

const PAYMENT_METHODS: PaymentMethod[] = [
  'cash', 'credit', 'debit', 'bank_transfer', 'paypal', 'venmo', 'other',
]

interface ExpenseFormData {
  amount: number
  date: string
  description: string
  merchant: string
  category: ExpenseCategory
  payment_method: PaymentMethod
  beneficiary: string
}

export default function Expenses() {
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [filters, setFilters] = useState<{
    category?: ExpenseCategory
    start_date?: string
    end_date?: string
  }>({})
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)

  const { user, familyMembers } = useAuthStore()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', page, filters],
    queryFn: () => expensesApi.list({ page, page_size: 20, ...filters }),
    enabled: !!user?.family_id,
  })

  const createMutation = useMutation({
    mutationFn: expensesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setShowAddModal(false)
      toast.success('Expense added!')
    },
    onError: () => toast.error('Failed to add expense'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ExpenseFormData> }) =>
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

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ExpenseFormData>({
    defaultValues: {
      date: format(new Date(), 'yyyy-MM-dd'),
      category: 'other',
      payment_method: 'credit',
      beneficiary: 'family',
    },
  })

  const onSubmit = (data: ExpenseFormData) => {
    if (editingExpense) {
      updateMutation.mutate({ id: editingExpense.id, data })
    } else {
      createMutation.mutate(data as ExpenseCreate)
    }
  }

  const openEditModal = (expense: Expense) => {
    setEditingExpense(expense)
    reset({
      amount: expense.amount,
      date: expense.date,
      description: expense.description,
      merchant: expense.merchant || '',
      category: expense.category,
      payment_method: expense.payment_method,
      beneficiary: expense.beneficiary,
    })
  }

  const openAddModal = () => {
    setEditingExpense(null)
    reset({
      date: format(new Date(), 'yyyy-MM-dd'),
      category: 'other',
      payment_method: 'credit',
      beneficiary: 'family',
      amount: undefined,
      description: '',
      merchant: '',
    })
    setShowAddModal(true)
  }

  if (!user?.family_id) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Join a family to start tracking expenses</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Expenses</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <FunnelIcon className="h-5 w-5" />
            Filters
          </button>
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            <PlusIcon className="h-5 w-5" />
            Add Expense
          </button>
        </div>
      </div>

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
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_INFO[cat].label}
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
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Payment
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.expenses.map((expense) => (
                    <tr key={expense.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {format(new Date(expense.date), 'MMM d, yyyy')}
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">
                          {expense.description}
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
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {PAYMENT_METHOD_LABELS[expense.payment_method]}
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
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-6 py-4 border-t flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing {data.expenses.length} of {data.total} expenses
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
            No expenses found. Add your first expense!
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {(showAddModal || editingExpense) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">
                {editingExpense ? 'Edit Expense' : 'Add Expense'}
              </h2>
              <button
                onClick={() => {
                  setShowAddModal(false)
                  setEditingExpense(null)
                }}
              >
                <XMarkIcon className="h-6 w-6 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount *
                </label>
                <input
                  type="number"
                  step="0.01"
                  {...register('amount', { required: true, min: 0.01 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p className="text-red-500 text-sm mt-1">Amount is required</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  {...register('date', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description *
                </label>
                <input
                  type="text"
                  {...register('description', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="What was this expense for?"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Merchant
                </label>
                <input
                  type="text"
                  {...register('merchant')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Store or vendor name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  {...register('category', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_INFO[cat].label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Method
                </label>
                <select
                  {...register('payment_method')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  For
                </label>
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
                  onClick={() => {
                    setShowAddModal(false)
                    setEditingExpense(null)
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
                    : editingExpense
                    ? 'Update'
                    : 'Add Expense'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
