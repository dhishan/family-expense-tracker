import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
} from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import { expensesApi, budgetsApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO } from '../types'
import type { ExpenseCategory } from '../types'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title)

export default function Dashboard() {
  const { user, family } = useAuthStore()
  const [selectedMonth, setSelectedMonth] = useState(new Date())

  const startDate = format(startOfMonth(selectedMonth), 'yyyy-MM-dd')
  const endDate = format(endOfMonth(selectedMonth), 'yyyy-MM-dd')

  // Fetch expense summary
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['expenses', 'summary', startDate, endDate],
    queryFn: () => expensesApi.getSummary({ start_date: startDate, end_date: endDate }),
    enabled: !!user?.family_id,
  })

  // Fetch budgets
  const { data: budgetsData, isLoading: budgetsLoading } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => budgetsApi.list(),
    enabled: !!user?.family_id,
  })

  // Fetch recent expenses
  const { data: recentExpenses } = useQuery({
    queryKey: ['expenses', 'recent'],
    queryFn: () => expensesApi.list({ page_size: 5 }),
    enabled: !!user?.family_id,
  })

  const categoryChartData = {
    labels: Object.entries(summary?.by_category || {}).map(
      ([key]) => CATEGORY_INFO[key as ExpenseCategory]?.label || key
    ),
    datasets: [
      {
        data: Object.values(summary?.by_category || {}),
        backgroundColor: [
          '#22c55e', '#f97316', '#3b82f6', '#a855f7', '#ec4899',
          '#14b8a6', '#eab308', '#06b6d4', '#6366f1', '#6b7280',
        ],
        borderWidth: 0,
      },
    ],
  }

  const handlePrevMonth = () => setSelectedMonth(subMonths(selectedMonth, 1))
  const handleNextMonth = () => {
    const next = new Date(selectedMonth)
    next.setMonth(next.getMonth() + 1)
    if (next <= new Date()) setSelectedMonth(next)
  }

  // Show setup prompt if no family
  if (!user?.family_id) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm p-8 text-center">
          <div className="text-6xl mb-4">👨‍👩‍👧‍👦</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Welcome to Family Expense Tracker!</h2>
          <p className="text-gray-600 mb-6">
            Create or join a family to start tracking expenses together.
          </p>
          <a
            href="/settings"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Get Started
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-600">
            {family?.name || 'Your family'}'s expense overview
          </p>
        </div>
        
        {/* Month selector */}
        <div className="flex items-center gap-2 bg-white rounded-lg px-4 py-2 shadow-sm">
          <button
            onClick={handlePrevMonth}
            className="p-1 hover:bg-gray-100 rounded"
          >
            ←
          </button>
          <span className="font-medium text-gray-900 min-w-[120px] text-center">
            {format(selectedMonth, 'MMMM yyyy')}
          </span>
          <button
            onClick={handleNextMonth}
            disabled={selectedMonth >= new Date()}
            className="p-1 hover:bg-gray-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            →
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <p className="text-sm text-gray-600">Total Spent</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            ${summary?.total_amount?.toFixed(2) || '0.00'}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {summary?.expense_count || 0} transactions
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <p className="text-sm text-gray-600">Active Budgets</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            {budgetsData?.total || 0}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {budgetsData?.budgets?.filter(b => b.is_over_budget).length || 0} over budget
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <p className="text-sm text-gray-600">Avg per Transaction</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            ${summary && summary.expense_count > 0
              ? (summary.total_amount / summary.expense_count).toFixed(2)
              : '0.00'}
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <p className="text-sm text-gray-600">Top Category</p>
          <p className="text-xl font-bold text-gray-900 mt-1">
            {summary?.by_category
              ? CATEGORY_INFO[
                  Object.entries(summary.by_category).sort(
                    ([, a], [, b]) => b - a
                  )[0]?.[0] as ExpenseCategory
                ]?.label || 'N/A'
              : 'N/A'}
          </p>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Category breakdown */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Spending by Category
          </h2>
          {summaryLoading ? (
            <div className="h-64 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
          ) : Object.keys(summary?.by_category || {}).length > 0 ? (
            <div className="h-64">
              <Doughnut
                data={categoryChartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: 'right',
                    },
                  },
                }}
              />
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No expenses this month
            </div>
          )}
        </div>

        {/* Budget status */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Budget Status
          </h2>
          {budgetsLoading ? (
            <div className="h-64 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
          ) : budgetsData?.budgets && budgetsData.budgets.length > 0 ? (
            <div className="space-y-4 max-h-64 overflow-y-auto">
              {budgetsData.budgets.map((status) => (
                <div key={status.budget.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-gray-900">
                      {status.budget.name}
                    </span>
                    <span className={status.is_over_budget ? 'text-red-600' : 'text-gray-600'}>
                      ${status.spent.toFixed(2)} / ${status.budget.amount.toFixed(2)}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
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
              ))}
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center text-gray-500">
              No budgets set up yet
            </div>
          )}
        </div>
      </div>

      {/* Recent transactions */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent Transactions</h2>
          <a href="/expenses" className="text-sm text-primary-600 hover:text-primary-700">
            View all →
          </a>
        </div>
        {recentExpenses?.expenses && recentExpenses.expenses.length > 0 ? (
          <div className="divide-y">
            {recentExpenses.expenses.map((expense) => (
              <div key={expense.id} className="py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      CATEGORY_INFO[expense.category]?.bgColor || 'bg-gray-100'
                    }`}
                  >
                    <span className="text-lg">
                      {expense.category === 'groceries' && '🛒'}
                      {expense.category === 'dining' && '🍽️'}
                      {expense.category === 'transportation' && '🚗'}
                      {expense.category === 'utilities' && '💡'}
                      {expense.category === 'entertainment' && '🎬'}
                      {expense.category === 'healthcare' && '🏥'}
                      {expense.category === 'shopping' && '🛍️'}
                      {expense.category === 'travel' && '✈️'}
                      {expense.category === 'education' && '📚'}
                      {expense.category === 'other' && '📦'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{expense.description}</p>
                    <p className="text-sm text-gray-500">
                      {expense.merchant || CATEGORY_INFO[expense.category]?.label}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900">
                    -${expense.amount.toFixed(2)}
                  </p>
                  <p className="text-sm text-gray-500">
                    {format(new Date(expense.date), 'MMM d')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            No recent transactions
          </div>
        )}
      </div>
    </div>
  )
}
