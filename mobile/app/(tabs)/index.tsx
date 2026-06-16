import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { useAuthStore } from '@/store/auth'
import { expensesApi, budgetsApi } from '@/services/api'
import { CATEGORY_INFO } from '@/types'

function toLocalISODate(d: Date = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtUSD(n: number) {
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

export default function DashboardScreen() {
  const { user, family, familyMembers } = useAuthStore()

  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const startStr = toLocalISODate(firstOfMonth)
  const endStr = toLocalISODate(today)

  const { data: expensesData, isLoading: loadingExpenses } = useQuery({
    queryKey: ['expenses', 'dashboard'],
    queryFn: () =>
      expensesApi.list({
        page: 1,
        page_size: 5,
        start_date: startStr,
        end_date: endStr,
      }),
    enabled: !!user?.family_id,
  })

  const { data: budgetsData, isLoading: loadingBudgets } = useQuery({
    queryKey: ['budgets', 'dashboard'],
    queryFn: budgetsApi.list,
    enabled: !!user?.family_id,
  })

  // Spending-by-person bar list (mobile-friendly alternative to a pie).
  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['expenses', 'summary', startStr, endStr],
    queryFn: () =>
      expensesApi.getSummary({ start_date: startStr, end_date: endStr }),
    enabled: !!user?.family_id,
  })

  const beneficiaryLabel = (key: string): string => {
    if (!key || key === 'family' || key === 'all') return 'Whole family'
    const override = family?.beneficiary_labels?.[key]
    if (override) return override
    const member = familyMembers.find((m) => m.id === key)
    return member?.display_name || key
  }

  const PERSON_COLORS = [
    '#6366f1', '#14b8a6', '#f97316', '#ec4899', '#a855f7',
    '#22c55e', '#eab308', '#3b82f6', '#06b6d4', '#6b7280',
  ]

  const [breakdown, setBreakdown] = useState<'person' | 'category' | 'budget'>('person')

  const personRows = Object.entries(summary?.by_beneficiary || {})
    .map(([key, amount]) => ({ key, label: beneficiaryLabel(key), amount: amount as number }))
    .sort((a, b) => b.amount - a.amount)
  const categoryRows = Object.entries(summary?.by_category || {})
    .map(([key, amount]) => ({
      key,
      label: (CATEGORY_INFO as Record<string, { label: string }>)[key]?.label || key,
      amount: amount as number,
    }))
    .sort((a, b) => b.amount - a.amount)
  const budgetRows = (budgetsData?.budgets ?? [])
    .map((b) => ({
      key: b.budget.id,
      label: b.budget.name,
      amount: b.spent,
      total: b.budget.amount,
      isOver: b.is_over_budget,
    }))
    .sort((a, b) => b.amount - a.amount)
  const activeRows =
    breakdown === 'person'
      ? personRows
      : breakdown === 'category'
        ? categoryRows
        : budgetRows.map((b) => ({ key: b.key, label: b.label, amount: b.amount }))
  const rowsTotal = activeRows.reduce((s, r) => s + r.amount, 0) || 1

  const monthTotal = expensesData?.expenses.reduce((s, e) => s + e.amount, 0) ?? 0
  const overBudgetCount = budgetsData?.budgets.filter((b) => b.is_over_budget).length ?? 0

  const goToFiltered = (
    bucket: 'person' | 'category' | 'budget',
    key: string,
  ) => {
    if (bucket === 'person') {
      router.push({ pathname: '/(tabs)/expenses', params: { beneficiary: key } })
    } else if (bucket === 'category') {
      router.push({ pathname: '/(tabs)/expenses', params: { category: key } })
    } else {
      router.push({ pathname: '/(tabs)/budgets' })
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>
            Hello, {user?.display_name?.split(' ')[0] ?? 'there'} 👋
          </Text>
          <Text style={styles.familyName}>{family?.name ?? 'No family yet'}</Text>
        </View>
      </View>

      {/* Summary cards */}
      <View style={styles.cardRow}>
        <View style={[styles.card, { flex: 1 }]}>
          <Text style={styles.cardLabel}>This month</Text>
          {loadingExpenses ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Text style={styles.cardValue}>{fmtUSD(monthTotal)}</Text>
          )}
        </View>
        <View style={[styles.card, { flex: 1 }]}>
          <Text style={styles.cardLabel}>Over budget</Text>
          {loadingBudgets ? (
            <ActivityIndicator size="small" color="#2563eb" />
          ) : (
            <Text
              style={[
                styles.cardValue,
                overBudgetCount > 0 && { color: '#dc2626' },
              ]}
            >
              {overBudgetCount}
            </Text>
          )}
        </View>
      </View>

      {/* Spending breakdown — Person / Category / Budget */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Spending by</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {(['person', 'category', 'budget'] as const).map((opt) => (
              <TouchableOpacity
                key={opt}
                onPress={() => setBreakdown(opt)}
                style={[
                  styles.breakdownChip,
                  breakdown === opt && styles.breakdownChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.breakdownChipText,
                    breakdown === opt && styles.breakdownChipTextActive,
                  ]}
                >
                  {opt[0].toUpperCase() + opt.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {loadingSummary ? (
          <ActivityIndicator size="small" color="#2563eb" style={{ marginTop: 8 }} />
        ) : activeRows.length === 0 ? (
          <Text style={styles.emptyText}>No expenses this month.</Text>
        ) : (
          activeRows.map((row, idx) => {
            const pct = (row.amount / rowsTotal) * 100
            const color = PERSON_COLORS[idx % PERSON_COLORS.length]
            const overFlag =
              breakdown === 'budget'
                ? budgetRows.find((b) => b.key === row.key)?.isOver
                : false
            return (
              <TouchableOpacity
                key={row.key}
                style={styles.personRow}
                onPress={() => goToFiltered(breakdown, row.key)}
              >
                <View style={styles.personLabelRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <View
                      style={[
                        styles.personDot,
                        { backgroundColor: overFlag ? '#dc2626' : color },
                      ]}
                    />
                    <Text style={styles.personName} numberOfLines={1}>
                      {row.label}
                    </Text>
                  </View>
                  <Text
                    style={[styles.personAmount, overFlag && { color: '#dc2626' }]}
                  >
                    {fmtUSD(row.amount)}
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.max(2, Math.min(pct, 100))}%` as `${number}%`,
                        backgroundColor: overFlag ? '#dc2626' : color,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.personPct}>
                  {breakdown === 'budget'
                    ? `${fmtUSD(row.amount)} of ${fmtUSD(budgetRows.find((b) => b.key === row.key)?.total ?? 0)}`
                    : `${pct.toFixed(1)}% of total`}
                </Text>
              </TouchableOpacity>
            )
          })
        )}
      </View>

      {/* Recent expenses */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent expenses</Text>
          <TouchableOpacity onPress={() => router.push('/(tabs)/expenses')}>
            <Text style={styles.sectionLink}>View all</Text>
          </TouchableOpacity>
        </View>

        {loadingExpenses ? (
          <ActivityIndicator size="small" color="#2563eb" style={{ marginTop: 16 }} />
        ) : expensesData?.expenses.length === 0 ? (
          <Text style={styles.emptyText}>
            No expenses this month. Tap Expenses to add one.
          </Text>
        ) : (
          expensesData?.expenses.map((expense) => (
            <View key={expense.id} style={styles.expenseRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.expenseDescription} numberOfLines={1}>
                  {expense.description}
                </Text>
                <Text style={styles.expenseMeta}>
                  {expense.category} - {expense.date}
                </Text>
              </View>
              <Text style={styles.expenseAmount}>{fmtUSD(expense.amount)}</Text>
            </View>
          ))
        )}
      </View>

      {/* Budget overview */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Budgets</Text>
          <TouchableOpacity onPress={() => router.push('/(tabs)/budgets')}>
            <Text style={styles.sectionLink}>View all</Text>
          </TouchableOpacity>
        </View>

        {loadingBudgets ? (
          <ActivityIndicator size="small" color="#2563eb" style={{ marginTop: 16 }} />
        ) : budgetsData?.budgets.length === 0 ? (
          <Text style={styles.emptyText}>No budgets set up. Tap Budgets to create one.</Text>
        ) : (
          budgetsData?.budgets.slice(0, 3).map((b) => (
            <View key={b.budget.id} style={styles.budgetRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <View style={styles.budgetLabelRow}>
                  <Text style={styles.budgetName}>{b.budget.name}</Text>
                  <Text
                    style={[
                      styles.budgetPct,
                      b.is_over_budget && { color: '#dc2626' },
                    ]}
                  >
                    {Math.round(b.percentage_used)}%
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.min(b.percentage_used, 100)}%` as `${number}%`,
                        backgroundColor: b.is_over_budget ? '#dc2626' : '#2563eb',
                      },
                    ]}
                  />
                </View>
                <Text style={styles.budgetAmounts}>
                  {fmtUSD(b.spent)} / {fmtUSD(b.budget.amount)}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, paddingTop: 60, paddingBottom: 32 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  greeting: { fontSize: 22, fontWeight: '700', color: '#111827' },
  familyName: { fontSize: 14, color: '#6b7280', marginTop: 2 },
  cardRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLabel: { fontSize: 12, color: '#6b7280', marginBottom: 6 },
  cardValue: { fontSize: 22, fontWeight: '700', color: '#111827' },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  sectionLink: { fontSize: 14, color: '#2563eb' },
  emptyText: { fontSize: 14, color: '#9ca3af', textAlign: 'center', paddingVertical: 16 },
  expenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  expenseDescription: { fontSize: 14, fontWeight: '500', color: '#111827' },
  expenseMeta: { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  expenseAmount: { fontSize: 14, fontWeight: '600', color: '#111827' },
  budgetRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  budgetLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  budgetName: { fontSize: 14, fontWeight: '500', color: '#111827' },
  budgetPct: { fontSize: 13, color: '#6b7280' },
  progressTrack: { height: 6, backgroundColor: '#e5e7eb', borderRadius: 3, marginBottom: 4 },
  progressFill: { height: 6, borderRadius: 3 },
  budgetAmounts: { fontSize: 12, color: '#9ca3af' },
  personRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  personLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  personDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  personName: { fontSize: 14, fontWeight: '500', color: '#111827', flexShrink: 1 },
  personAmount: { fontSize: 14, fontWeight: '600', color: '#111827' },
  personPct: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  breakdownChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  breakdownChipActive: { backgroundColor: '#eef2ff', borderColor: '#6366f1' },
  breakdownChipText: { fontSize: 12, color: '#475569' },
  breakdownChipTextActive: { color: '#4338ca', fontWeight: '600' },
})
