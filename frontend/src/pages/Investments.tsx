import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  BuildingLibraryIcon,
  PlusCircleIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline'
import { investmentsApi } from '../services/api'
import type { HoldingGroup } from '../services/api'

// ─── helpers ─────────────────────────────────────────────────────────────────

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
      const pnl =
        pos.open_pnl != null ? pos.open_pnl : marketValue - costBasis
      const returnPct = costBasis !== 0 ? (pnl / Math.abs(costBasis)) * 100 : 0
      rows.push({ accountName, symbol, description, qty, avgCost, price, marketValue, costBasis, pnl, returnPct })
    }
  }
  return rows
}

// ─── Connect modal ────────────────────────────────────────────────────────────

const BROKERS = [
  { id: 'ROBINHOOD', label: 'Robinhood' },
  { id: 'ETRADE', label: 'E*TRADE' },
  { id: null, label: 'Other / pick on next screen' },
]

function ConnectModal({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>('ROBINHOOD')
  const [linked, setLinked] = useState(false)
  const queryClient = useQueryClient()

  const connectMutation = useMutation({
    mutationFn: async () => {
      await investmentsApi.register()
      return investmentsApi.connect(selected)
    },
    onSuccess: ({ redirectURI }) => {
      window.open(redirectURI, '_blank')
      setLinked(true)
    },
    onError: () => toast.error('Failed to start brokerage connection'),
  })

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['investments', 'accounts'] })
    onClose()
    toast.success('Accounts refreshed')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Connect a brokerage</h2>

        {!linked ? (
          <>
            <div className="space-y-2 mb-6">
              {BROKERS.map((b) => (
                <button
                  key={String(b.id)}
                  onClick={() => setSelected(b.id)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    selected === b.id
                      ? 'border-primary-500 bg-primary-50 text-primary-800'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending}
                className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                {connectMutation.isPending ? 'Opening...' : 'Continue'}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-sm text-gray-600 mb-6">
              A brokerage tab was opened. Complete the link there, then come back and refresh.
            </p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                Not yet
              </button>
              <button
                onClick={handleRefresh}
                className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 flex items-center justify-center gap-2"
              >
                <ArrowPathIcon className="h-4 w-4" />
                Refresh accounts
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── MCP panel ────────────────────────────────────────────────────────────────

const MCP_URL = 'https://mcp.expense-tracker.blueelephants.org/mcp/'

const DESKTOP_CONFIG = `{
  "mcpServers": {
    "family-investments": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {
        "MCP_URL": "${MCP_URL}"
      }
    }
  }
}`

const CLI_CMD = `claude mcp add family-investments --url "${MCP_URL}"`

type McpTab = 'desktop' | 'cli' | 'web'

function McpPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<McpTab>('desktop')
  const [copied, setCopied] = useState(false)
  const [copiedSnippet, setCopiedSnippet] = useState(false)

  const copy = (text: string, which: 'url' | 'snippet') => {
    navigator.clipboard.writeText(text).then(() => {
      if (which === 'url') {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        setCopiedSnippet(true)
        setTimeout(() => setCopiedSnippet(false), 2000)
      }
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">🤖</span>
          <div>
            <p className="font-medium text-gray-900">Use with Claude Desktop / Mobile</p>
            <p className="text-sm text-gray-500">Chat with your portfolio using Claude's MCP integration</p>
          </div>
        </div>
        {open ? (
          <ChevronUpIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-6 pb-6 border-t border-gray-100">
          <p className="text-sm text-gray-600 mt-4 mb-3">
            Add the URL below to your Claude Desktop or mobile app's MCP settings to chat with
            your portfolio.
          </p>

          {/* MCP URL + copy */}
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-5">
            <code className="flex-1 text-xs text-gray-800 break-all">{MCP_URL}</code>
            <button
              onClick={() => copy(MCP_URL, 'url')}
              className="flex-shrink-0 text-gray-400 hover:text-primary-600 transition-colors"
              title="Copy URL"
            >
              {copied ? (
                <CheckIcon className="h-4 w-4 text-green-500" />
              ) : (
                <ClipboardDocumentIcon className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
            {([['desktop', 'Claude Desktop'], ['cli', 'Claude Code CLI'], ['web', 'Claude Web / Mobile']] as [McpTab, string][]).map(
              ([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
                    tab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              )
            )}
          </div>

          {/* Tab content */}
          {tab === 'desktop' && (
            <div>
              <p className="text-sm text-gray-600 mb-2">
                Add to{' '}
                <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </code>
                :
              </p>
              <div className="relative">
                <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto leading-relaxed">
                  {DESKTOP_CONFIG}
                </pre>
                <button
                  onClick={() => copy(DESKTOP_CONFIG, 'snippet')}
                  className="absolute top-2 right-2 text-gray-400 hover:text-white transition-colors"
                  title="Copy config"
                >
                  {copiedSnippet ? (
                    <CheckIcon className="h-4 w-4 text-green-400" />
                  ) : (
                    <ClipboardDocumentIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {tab === 'cli' && (
            <div>
              <p className="text-sm text-gray-600 mb-2">Run in your terminal:</p>
              <div className="relative">
                <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto leading-relaxed">
                  {CLI_CMD}
                </pre>
                <button
                  onClick={() => copy(CLI_CMD, 'snippet')}
                  className="absolute top-2 right-2 text-gray-400 hover:text-white transition-colors"
                  title="Copy command"
                >
                  {copiedSnippet ? (
                    <CheckIcon className="h-4 w-4 text-green-400" />
                  ) : (
                    <ClipboardDocumentIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {tab === 'web' && (
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                In <strong>claude.ai</strong>: open Settings &rarr; Integrations &rarr; Add MCP
                server, and paste the URL above.
              </p>
              <p>
                In the <strong>Claude mobile app</strong>: Settings &rarr; MCP Servers &rarr; Add,
                paste the URL.
              </p>
            </div>
          )}

          <p className="text-xs text-gray-400 mt-4">
            The first call will open a Google sign-in in your browser (Cloudflare Access). Sign in
            with the same Google account you use here.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type SortKey = keyof Pick<FlatPosition, 'symbol' | 'accountName' | 'qty' | 'marketValue' | 'costBasis' | 'pnl' | 'returnPct'>

export default function Investments() {
  const [showConnect, setShowConnect] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('marketValue')
  const [sortAsc, setSortAsc] = useState(false)

  const queryClient = useQueryClient()

  const { data: accounts, isLoading: accountsLoading, error: accountsError } = useQuery({
    queryKey: ['investments', 'accounts'],
    queryFn: investmentsApi.accounts,
    retry: false,
  })

  const { data: holdingsRaw, isLoading: holdingsLoading } = useQuery({
    queryKey: ['investments', 'holdings'],
    queryFn: investmentsApi.holdings,
    enabled: !accountsError && !!accounts && accounts.length > 0,
    retry: false,
  })

  const positions = holdingsRaw ? flattenHoldings(holdingsRaw) : []

  const [showHoldings, setShowHoldings] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('investments:showHoldings') === '1'
  })
  const toggleHoldings = () => {
    setShowHoldings((prev) => {
      const next = !prev
      try { window.localStorage.setItem('investments:showHoldings', next ? '1' : '0') } catch {}
      return next
    })
  }

  const sorted = [...positions].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    if (typeof av === 'string' && typeof bv === 'string') {
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
    }
    return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })

  const totalMV = positions.reduce((s, p) => s + p.marketValue, 0)
  const totalCost = positions.reduce((s, p) => s + p.costBasis, 0)
  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0)
  const totalReturn = totalCost !== 0 ? (totalPnl / Math.abs(totalCost)) * 100 : 0

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      onClick={() => handleSort(k)}
      className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
    >
      {label} {sortKey === k ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  )

  const noAccounts = !accountsLoading && (!accounts || accounts.length === 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Investments</h1>
        <button
          onClick={() => setShowConnect(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <PlusCircleIcon className="h-4 w-4" />
          Connect brokerage
        </button>
      </div>

      {/* ── Accounts ─────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <BuildingLibraryIcon className="h-5 w-5 text-gray-400" />
            Connected accounts
          </h2>
          {accounts && accounts.length > 0 && (
            <button
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ['investments'] })
                toast.success('Refreshed')
              }}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-primary-600 transition-colors"
            >
              <ArrowPathIcon className="h-4 w-4" />
              Refresh
            </button>
          )}
        </div>

        {accountsLoading && (
          <div className="py-8 flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        )}

        {noAccounts && (
          <div className="py-8 text-center text-gray-500">
            <BuildingLibraryIcon className="h-10 w-10 mx-auto mb-3 text-gray-300" />
            <p className="font-medium text-gray-700 mb-1">No brokerages connected yet</p>
            <p className="text-sm">Get started by connecting your first brokerage account.</p>
          </div>
        )}

        {accounts && accounts.length > 0 && (
          <div className="divide-y divide-gray-100">
            {accounts.map((acct) => (
              <div key={acct.id} className="py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{acct.name}</p>
                  {acct.institution_name && (
                    <p className="text-xs text-gray-500">{acct.institution_name}</p>
                  )}
                  {acct.number && (
                    <p className="text-xs text-gray-400">...{acct.number.slice(-4)}</p>
                  )}
                </div>
                {(() => {
                  const synced = acct.sync_status?.holdings?.initial_sync_completed
                  const label = synced === false ? 'Syncing…' : 'Connected'
                  const cls = synced === false
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-green-100 text-green-700'
                  return (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
                      {label}
                    </span>
                  )
                })()}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Holdings table ────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Holdings</h2>
          <button
            type="button"
            onClick={toggleHoldings}
            aria-label={showHoldings ? 'Hide holdings' : 'Show holdings'}
            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            {showHoldings ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
          </button>
        </div>

        {!showHoldings && (
          <div className="py-10 text-center text-sm text-gray-500">
            Holdings hidden for privacy. Click the eye to reveal.
          </div>
        )}

        {showHoldings && holdingsLoading && (
          <div className="py-8 flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        )}

        {showHoldings && !holdingsLoading && positions.length === 0 && (
          <div className="py-8 text-center text-gray-500 text-sm">
            {noAccounts
              ? 'Connect a brokerage above to see your holdings.'
              : 'No positions found across your connected accounts.'}
          </div>
        )}

        {showHoldings && positions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-gray-50">
                <tr>
                  <SortHeader label="Account" k="accountName" />
                  <SortHeader label="Symbol" k="symbol" />
                  <SortHeader label="Qty" k="qty" />
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Cost</th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                  <SortHeader label="Mkt Value" k="marketValue" />
                  <SortHeader label="Unreal P&L" k="pnl" />
                  <SortHeader label="Return %" k="returnPct" />
                </tr>
              </thead>
              <tbody>
                {/* Totals row */}
                <tr className="bg-gray-50 border-b border-gray-200 font-semibold text-sm">
                  <td className="px-3 py-3 text-gray-700" colSpan={5}>Total</td>
                  <td className="px-3 py-3 text-gray-900">{fmtUSD(totalMV)}</td>
                  <td className={`px-3 py-3 ${totalPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {totalPnl >= 0 ? '+' : ''}{fmtUSD(totalPnl)}
                  </td>
                  <td className={`px-3 py-3 ${totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {totalReturn >= 0 ? '+' : ''}{fmt(totalReturn)}%
                  </td>
                </tr>
                {sorted.map((pos, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50 text-sm">
                    <td className="px-3 py-3 text-gray-500 text-xs max-w-[120px] truncate">{pos.accountName}</td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-gray-900">{pos.symbol}</div>
                      {pos.description && (
                        <div className="text-xs text-gray-400 truncate max-w-[140px]">{pos.description}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-gray-700">{fmt(pos.qty, 4)}</td>
                    <td className="px-3 py-3 text-gray-700">{fmtUSD(pos.avgCost)}</td>
                    <td className="px-3 py-3 text-gray-700">{fmtUSD(pos.price)}</td>
                    <td className="px-3 py-3 text-gray-900 font-medium">{fmtUSD(pos.marketValue)}</td>
                    <td className={`px-3 py-3 font-medium ${pos.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {pos.pnl >= 0 ? '+' : ''}{fmtUSD(pos.pnl)}
                    </td>
                    <td className={`px-3 py-3 font-medium ${pos.returnPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {pos.returnPct >= 0 ? '+' : ''}{fmt(pos.returnPct)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── MCP panel ────────────────────────────────────────────────────── */}
      <McpPanel />

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}
