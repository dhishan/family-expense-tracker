import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { TrashIcon } from '@heroicons/react/24/outline'
import { rulesApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO } from '../types'
import type { ExpenseCategory } from '../types'

export default function AutoRules() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'merchant'],
    queryFn: rulesApi.list,
    enabled: !!user?.family_id,
  })
  const rules = data?.rules ?? []

  const deleteMutation = useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
      setConfirmDeleteId(null)
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule'),
  })

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Auto-categorization Rules</h1>
        <p className="mt-1 text-sm text-gray-500">
          When a pending transaction matches a merchant name, it gets pre-categorized automatically.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto" />
          </div>
        ) : rules.length === 0 ? (
          <div className="p-10 text-center text-gray-500">
            <p className="font-medium text-gray-700 mb-1">No auto-rules yet.</p>
            <p className="text-sm">
              Create one when approving a transaction by checking the &ldquo;Always apply&rdquo; option.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Merchant
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    For
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Applied
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last applied
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules.map((rule) => {
                  const catInfo = CATEGORY_INFO[rule.category as ExpenseCategory]
                  return (
                    <tr key={rule.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {rule.merchant_name}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                            catInfo?.bgColor ?? 'bg-gray-100'
                          } ${catInfo?.color ?? 'text-gray-600'}`}
                        >
                          {catInfo?.label ?? rule.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {rule.beneficiary === 'family' ? 'Entire Family' : rule.beneficiary}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {rule.applied_count}x
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {rule.last_applied_at
                          ? format(new Date(rule.last_applied_at), 'MMM d, yyyy')
                          : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setConfirmDeleteId(rule.id)}
                          className="text-gray-400 hover:text-red-600 p-1"
                          title="Delete rule"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete rule?</h3>
            <p className="text-sm text-gray-600 mb-6">
              Future transactions from this merchant will no longer be auto-categorized.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirmDeleteId)}
                disabled={deleteMutation.isPending}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
