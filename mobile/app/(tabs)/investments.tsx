import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Clipboard,
  Alert,
} from 'react-native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Ionicons } from '@expo/vector-icons'
import { investmentsApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import type { HoldingGroup } from '@/types'

const MCP_URL = 'https://mcp.expense-tracker.blueelephants.org/mcp/'
const PRIVACY_KEY = 'investments_hidden'

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtUSD(n: number) {
  return '$' + fmt(n)
}

interface FlatPosition {
  accountName: string
  symbol: string
  description: string
  qty: number
  avgCost: number
  price: number
  marketValue: number
  costBasis: number
  pnl: number
  returnPct: number
}

function flattenHoldings(groups: HoldingGroup[]): FlatPosition[] {
  const rows: FlatPosition[] = []
  for (const group of groups) {
    const accountName =
      group.account?.name || group.account?.institution_name || 'Unknown account'
    for (const pos of group.positions ?? []) {
      const symbol = pos.symbol?.symbol?.symbol ?? ''
      const description = pos.symbol?.symbol?.description ?? ''
      const qty = pos.units ?? pos.fractional_units ?? 0
      const price = pos.price ?? 0
      const avgCost = pos.average_purchase_price ?? 0
      const marketValue = qty * price
      const costBasis = qty * avgCost
      const pnl = pos.open_pnl != null ? pos.open_pnl : marketValue - costBasis
      const returnPct = costBasis !== 0 ? (pnl / Math.abs(costBasis)) * 100 : 0
      rows.push({
        accountName,
        symbol,
        description,
        qty,
        avgCost,
        price,
        marketValue,
        costBasis,
        pnl,
        returnPct,
      })
    }
  }
  return rows
}

export default function InvestmentsScreen() {
  // Privacy: default hidden=true, persisted in AsyncStorage
  const [hidden, setHidden] = useState(true)
  const [privacyLoaded, setPrivacyLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const { user } = useAuthStore()
  const queryClient = useQueryClient()

  // Load persisted privacy preference
  useEffect(() => {
    AsyncStorage.getItem(PRIVACY_KEY)
      .then((val) => {
        if (val !== null) setHidden(val === 'true')
      })
      .catch(() => {})
      .finally(() => setPrivacyLoaded(true))
  }, [])

  const toggleHidden = useCallback(() => {
    setHidden((h) => {
      const next = !h
      AsyncStorage.setItem(PRIVACY_KEY, String(next)).catch(() => {})
      return next
    })
  }, [])

  const { data: accounts, isLoading: loadingAccounts } = useQuery({
    queryKey: ['investments', 'accounts'],
    queryFn: investmentsApi.accounts,
    enabled: !!user?.family_id,
  })

  const { data: holdings, isLoading: loadingHoldings } = useQuery({
    queryKey: ['investments', 'holdings'],
    queryFn: investmentsApi.holdings,
    enabled: !!user?.family_id,
  })

  // Refresh holdings + activities only (accounts list rarely changes)
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['investments', 'holdings'] }),
    ])
    setRefreshing(false)
  }, [queryClient])

  const isLoading = loadingAccounts || loadingHoldings
  const positions = holdings ? flattenHoldings(holdings) : []

  const totalValue = positions.reduce((s, p) => s + p.marketValue, 0)
  const totalCost = positions.reduce((s, p) => s + p.costBasis, 0)
  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0)
  const totalReturn = totalCost !== 0 ? (totalPnl / Math.abs(totalCost)) * 100 : 0

  const maskValue = (v: string) => (hidden ? '••••••' : v)

  const handleCopyMcp = () => {
    Clipboard.setString(MCP_URL)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!privacyLoaded) return null

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Investments</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={toggleHidden}
            style={styles.iconBtn}
            testID="eye-toggle"
          >
            <Ionicons
              name={hidden ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color="#6b7280"
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={onRefresh} style={styles.iconBtn} testID="refresh-btn">
            <Ionicons name="refresh-outline" size={22} color="#6b7280" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* Summary card */}
        {!isLoading && positions.length > 0 && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>Portfolio value</Text>
                <Text style={styles.summaryValue}>{maskValue(fmtUSD(totalValue))}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryLabel}>Total P&L</Text>
                <Text
                  style={[
                    styles.summaryValue,
                    { color: totalPnl >= 0 ? '#4ade80' : '#f87171' },
                  ]}
                >
                  {maskValue((totalPnl >= 0 ? '+' : '') + fmtUSD(totalPnl))}
                </Text>
                <Text
                  style={[
                    styles.summarySubValue,
                    { color: totalReturn >= 0 ? '#4ade80' : '#f87171' },
                  ]}
                >
                  {maskValue((totalReturn >= 0 ? '+' : '') + fmt(totalReturn) + '%')}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Connected accounts */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connected accounts</Text>
          {loadingAccounts ? (
            <ActivityIndicator size="small" color="#2563eb" style={{ marginTop: 8 }} />
          ) : !accounts || accounts.length === 0 ? (
            <Text style={styles.emptyText}>
              No brokerage accounts connected. Link from the web app at
              ui.expense-tracker.blueelephants.org.
            </Text>
          ) : (
            accounts.map((acct) => (
              <View key={acct.id} style={styles.accountRow}>
                <View style={styles.accountDot} />
                <View>
                  <Text style={styles.accountName}>{acct.name || acct.institution_name}</Text>
                  {acct.institution_name && acct.name !== acct.institution_name && (
                    <Text style={styles.accountInstitution}>{acct.institution_name}</Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>

        {/* Holdings table */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Holdings</Text>
          {isLoading ? (
            <ActivityIndicator size="small" color="#2563eb" style={{ marginTop: 8 }} />
          ) : positions.length === 0 ? (
            <Text style={styles.emptyText}>
              No positions found. Connect a brokerage account on the web app first.
            </Text>
          ) : (
            <>
              {/* Table header */}
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Symbol</Text>
                <Text style={[styles.tableHeaderCell, { flex: 2, textAlign: 'right' }]}>
                  Mkt Value
                </Text>
                <Text style={[styles.tableHeaderCell, { flex: 2, textAlign: 'right' }]}>P&L</Text>
              </View>
              {positions.map((pos, idx) => (
                <View
                  key={`${pos.accountName}-${pos.symbol}-${idx}`}
                  style={[styles.tableRow, idx % 2 === 1 && styles.tableRowAlt]}
                  testID={`holding-row-${pos.symbol}`}
                >
                  <View style={{ flex: 2 }}>
                    <Text style={styles.posSymbol}>{pos.symbol || '—'}</Text>
                    <Text style={styles.posDesc} numberOfLines={1}>
                      {pos.description || pos.accountName}
                    </Text>
                  </View>
                  <Text style={[styles.posValue, { flex: 2, textAlign: 'right' }]}>
                    {maskValue(fmtUSD(pos.marketValue))}
                  </Text>
                  <View style={{ flex: 2, alignItems: 'flex-end' }}>
                    <Text
                      style={[
                        styles.posPnl,
                        { color: pos.pnl >= 0 ? '#059669' : '#dc2626' },
                      ]}
                    >
                      {maskValue((pos.pnl >= 0 ? '+' : '') + fmtUSD(pos.pnl))}
                    </Text>
                    <Text
                      style={[
                        styles.posReturn,
                        { color: pos.returnPct >= 0 ? '#059669' : '#dc2626' },
                      ]}
                    >
                      {maskValue((pos.returnPct >= 0 ? '+' : '') + fmt(pos.returnPct) + '%')}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </View>

        {/* Use with Claude (MCP) panel */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Use with Claude</Text>
          <Text style={styles.mcpDescription}>
            Add the hosted MCP server to Claude Desktop to ask Claude about your finances
            directly from the Claude app.
          </Text>
          <View style={styles.mcpUrlRow}>
            <Text style={styles.mcpUrl} numberOfLines={1} ellipsizeMode="tail">
              {MCP_URL}
            </Text>
            <TouchableOpacity
              style={styles.copyBtn}
              onPress={handleCopyMcp}
              testID="copy-mcp-btn"
            >
              <Ionicons
                name={copied ? 'checkmark-outline' : 'copy-outline'}
                size={16}
                color={copied ? '#059669' : '#2563eb'}
              />
              <Text style={[styles.copyBtnText, copied && { color: '#059669' }]}>
                {copied ? 'Copied' : 'Copy'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.mcpHint}>
            In Claude Desktop: Settings → Developer → Add MCP Server → paste URL above.
          </Text>
        </View>
      </ScrollView>
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
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { padding: 6 },
  summaryCard: {
    margin: 16,
    backgroundColor: '#1e3a8a',
    borderRadius: 16,
    padding: 20,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryItem: { flex: 1 },
  summaryLabel: { fontSize: 12, color: '#93c5fd', marginBottom: 4 },
  summaryValue: { fontSize: 20, fontWeight: '700', color: '#fff' },
  summarySubValue: { fontSize: 13, marginTop: 2 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 12 },
  emptyText: { fontSize: 14, color: '#9ca3af', lineHeight: 20 },
  accountRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 10 },
  accountDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#2563eb' },
  accountName: { fontSize: 14, fontWeight: '500', color: '#111827' },
  accountInstitution: { fontSize: 12, color: '#6b7280' },
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginBottom: 4,
  },
  tableHeaderCell: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
  },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  tableRowAlt: { backgroundColor: '#f9fafb' },
  posSymbol: { fontSize: 14, fontWeight: '600', color: '#111827' },
  posDesc: { fontSize: 11, color: '#9ca3af', marginTop: 1 },
  posValue: { fontSize: 14, color: '#111827', fontWeight: '500' },
  posPnl: { fontSize: 13, fontWeight: '600' },
  posReturn: { fontSize: 11, marginTop: 1 },
  // MCP panel
  mcpDescription: { fontSize: 13, color: '#6b7280', lineHeight: 18, marginBottom: 12 },
  mcpUrlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    padding: 10,
    gap: 8,
    marginBottom: 8,
  },
  mcpUrl: { flex: 1, fontSize: 12, color: '#374151', fontFamily: 'monospace' },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  copyBtnText: { fontSize: 13, color: '#2563eb', fontWeight: '500' },
  mcpHint: { fontSize: 12, color: '#9ca3af', lineHeight: 16 },
})
