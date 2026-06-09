import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuthStore } from '../store/auth'
import { PaperAirplaneIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from '@heroicons/react/24/outline'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Human-readable labels for tool names — improves status messages.
const TOOL_LABELS: Record<string, string> = {
  list_accounts: 'your brokerage accounts',
  get_holdings: 'your full holdings',
  get_account_balances: 'account balances',
  get_account_positions: 'account positions',
  get_activities: 'recent transactions',
  get_cost_basis: 'cost basis',
  portfolio_summary: 'your portfolio summary',
  macro_indicator: 'macro indicator (FRED)',
  macro_series: 'macro time series (FRED)',
  price_history: 'price history (Tiingo)',
  ticker_meta: 'ticker info (Tiingo)',
  ticker_quote: 'live quote (Finnhub)',
  ticker_news: 'ticker news (Finnhub)',
  ticker_recommendations: 'analyst ratings (Finnhub)',
  ticker_price_target: 'price targets (Finnhub)',
  ticker_earnings_calendar: 'earnings calendar (Finnhub)',
  edgar_company_lookup: 'SEC EDGAR company lookup',
  edgar_recent_filings: 'SEC filings',
  edgar_company_facts: 'SEC financials',
  edgar_insider_transactions: 'insider transactions (SEC)',
  expense_list: 'your expenses',
  expense_summary: 'expense summary',
  expense_top_merchants: 'top merchants',
  budget_status: 'budget status',
  budget_burn_rate: 'budget burn rate',
  web_search: 'the web',
}
function humanizeToolName(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ')
}

// ---- Types ------------------------------------------------------------------

interface TextBlock {
  type: 'text'
  text: string
}

interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  expanded: boolean
}

type MessageBlock = TextBlock | ToolCallBlock

interface Message {
  role: 'user' | 'assistant'
  blocks: MessageBlock[]
}

// ---- Suggested starters -----------------------------------------------------

const STARTERS = [
  'Show me my portfolio',
  'Analyze my concentration risk',
  'What should I consider selling?',
  'How am I positioned for current macro conditions?',
]

// ---- Tool call card ---------------------------------------------------------

function ToolCard({ block, onToggle }: { block: ToolCallBlock; onToggle: () => void }) {
  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 text-xs font-mono overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-600 hover:bg-gray-100 transition-colors"
      >
        {block.expanded ? (
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 shrink-0" />
        )}
        <span className="text-gray-400">tool</span>
        <span className="font-semibold text-gray-700">{block.name}</span>
        {!block.expanded && !block.result && (
          <span className="ml-auto text-gray-400 animate-pulse">running...</span>
        )}
        {!block.expanded && block.result && (
          <span className="ml-auto text-green-600">done</span>
        )}
      </button>
      {block.expanded && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          <div>
            <p className="text-gray-400 mb-1">input</p>
            <pre className="whitespace-pre-wrap break-all text-gray-700">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
          {block.result && (
            <div>
              <p className="text-gray-400 mb-1">result preview</p>
              <pre className="whitespace-pre-wrap break-all text-gray-600">{block.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Single chat bubble -----------------------------------------------------

function Bubble({ msg, onToolToggle }: {
  msg: Message
  onToolToggle: (blockIdx: number) => void
}) {
  const isUser = msg.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[85%] lg:max-w-[75%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-primary-600 text-white rounded-tr-sm'
            : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
        }`}
      >
        {msg.blocks.map((block, idx) => {
          if (block.type === 'text') {
            if (isUser) {
              return <p key={idx} className="whitespace-pre-wrap text-sm">{block.text}</p>
            }
            return (
              <div
                key={idx}
                className={[
                  // Tailwind Typography base
                  'prose prose-sm prose-slate max-w-none',
                  // Body text — softer than black, more readable on long-form
                  'prose-p:text-slate-700 prose-p:leading-relaxed prose-p:my-2',
                  // Headings — refined hierarchy, looser tracking
                  'prose-headings:font-semibold prose-headings:text-slate-900 prose-headings:tracking-tight',
                  'prose-h1:text-lg prose-h1:mt-5 prose-h1:mb-2',
                  'prose-h2:text-base prose-h2:mt-5 prose-h2:mb-2 prose-h2:pb-1 prose-h2:border-b prose-h2:border-slate-200',
                  'prose-h3:text-sm prose-h3:mt-4 prose-h3:mb-1.5',
                  // Emphasis
                  'prose-strong:text-slate-900 prose-strong:font-semibold',
                  'prose-em:text-slate-700',
                  // Links — indigo, underline only on hover
                  'prose-a:text-indigo-600 prose-a:font-medium prose-a:no-underline hover:prose-a:underline',
                  // Lists — tighter
                  'prose-ul:my-2 prose-ol:my-2 prose-li:text-slate-700 prose-li:my-0.5 prose-li:marker:text-slate-400',
                  // Inline code — pink accent on subtle bg, no quote marks
                  'prose-code:text-pink-700 prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-normal prose-code:text-[0.85em]',
                  "prose-code:before:content-[''] prose-code:after:content-['']",
                  // Fenced code blocks — dark
                  'prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-pre:rounded-lg prose-pre:p-3 prose-pre:my-3',
                  // Blockquote — soft indigo left bar with tinted bg
                  'prose-blockquote:border-l-indigo-300 prose-blockquote:bg-indigo-50/40 prose-blockquote:py-1 prose-blockquote:px-3',
                  'prose-blockquote:not-italic prose-blockquote:text-slate-700 prose-blockquote:rounded-r',
                  // HR
                  'prose-hr:my-4 prose-hr:border-slate-200',
                ].join(' ')}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Wrap tables so they can scroll horizontally on narrow screens
                    // without overflowing the chat bubble.
                    table: ({ children }) => (
                      <div className="my-3 overflow-x-auto rounded-md border border-slate-200">
                        <table className="w-full text-sm border-collapse">{children}</table>
                      </div>
                    ),
                    thead: ({ children }) => (
                      <thead className="bg-slate-50">{children}</thead>
                    ),
                    tr: ({ children }) => (
                      <tr className="border-b border-slate-100 last:border-b-0 even:bg-slate-50/40 hover:bg-slate-50/80">
                        {children}
                      </tr>
                    ),
                    th: ({ children }) => (
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 border-b border-slate-200">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="px-3 py-2 text-slate-700 align-top whitespace-normal">
                        {children}
                      </td>
                    ),
                  }}
                >
                  {block.text}
                </ReactMarkdown>
              </div>
            )
          }
          if (block.type === 'tool_call') {
            return (
              <ToolCard
                key={idx}
                block={block}
                onToggle={() => onToolToggle(idx)}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

// ---- Main page --------------------------------------------------------------

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string>('Thinking…')
  const [stickToBottom, setStickToBottom] = useState(true)
  // Durable conversation tracking. null = next /chat/start creates a new
  // conversation; once set, subsequent sends continue the same one
  // server-side. Reset by "New chat".
  const [conversationId, setConversationId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { token } = useAuthStore()

  // Detect when the user scrolls up — pause auto-scroll until they return
  // to the bottom. Without this, every streamed token snaps the view down
  // and the user can't read previous messages while a response is in flight.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickToBottom(distanceFromBottom < 80) // px tolerance
  }, [])

  useEffect(() => {
    if (stickToBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, stickToBottom])

  const jumpToLatest = useCallback(() => {
    setStickToBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const toggleToolBlock = useCallback((msgIdx: number, blockIdx: number) => {
    setMessages((prev) =>
      prev.map((m, mi) => {
        if (mi !== msgIdx) return m
        return {
          ...m,
          blocks: m.blocks.map((b, bi) => {
            if (bi !== blockIdx || b.type !== 'tool_call') return b
            return { ...b, expanded: !b.expanded }
          }),
        }
      })
    )
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return
      setDraft('')

      // Optimistic UI: append the user message + an empty assistant
      // bubble that will fill in as the SSE stream arrives.
      const userMessage: Message = { role: 'user', blocks: [{ type: 'text', text: text.trim() }] }
      const assistantMessage: Message = { role: 'assistant', blocks: [] }

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setStreaming(true)
      setActivity('Thinking…')

      const msgIdx = messages.length + 1 // index of the assistant message we just appended

      try {
        // 1) Kick off generation server-side. Returns immediately with
        //    {conversation_id, user_turn_id, assistant_turn_id}.
        const startResp = await fetch(`${API_URL}/api/v1/chat/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            message: text.trim(),
          }),
        })
        if (!startResp.ok) {
          const errText = await startResp.text()
          throw new Error(`HTTP ${startResp.status}: ${errText}`)
        }
        const started = (await startResp.json()) as {
          conversation_id: string
          user_turn_id: string
          assistant_turn_id: string
        }
        setConversationId(started.conversation_id)

        // 2) Open the resumable SSE stream for the assistant turn.
        const streamUrl =
          `${API_URL}/api/v1/chat/conversations/${encodeURIComponent(started.conversation_id)}` +
          `/turns/${encodeURIComponent(started.assistant_turn_id)}/stream?from_seq=0`
        const resp = await fetch(streamUrl, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
        })

        if (!resp.ok) {
          const errText = await resp.text()
          throw new Error(`HTTP ${resp.status}: ${errText}`)
        }

        const reader = resp.body?.getReader()
        if (!reader) throw new Error('No response body')
        const decoder = new TextDecoder()
        let buffer = ''

        // Track which block index is the current active text block in assistant msg
        let currentTextBlockIdx = -1

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (!raw) continue

            let event: Record<string, unknown>
            try {
              event = JSON.parse(raw)
            } catch {
              continue
            }

            const evType = event.type as string

            if (evType === 'text') {
              setActivity('Writing response…')
              const chunk = event.text as string
              setMessages((prev) =>
                prev.map((m, mi) => {
                  if (mi !== msgIdx) return m
                  const blocks = [...m.blocks]
                  if (currentTextBlockIdx >= 0 && blocks[currentTextBlockIdx]?.type === 'text') {
                    const existing = blocks[currentTextBlockIdx] as TextBlock
                    blocks[currentTextBlockIdx] = { ...existing, text: existing.text + chunk }
                  } else {
                    currentTextBlockIdx = blocks.length
                    blocks.push({ type: 'text', text: chunk })
                  }
                  return { ...m, blocks }
                })
              )
            } else if (evType === 'tool_call') {
              currentTextBlockIdx = -1 // next text chunk starts a new block
              const toolName = event.name as string
              setActivity(`Calling ${humanizeToolName(toolName)}…`)
              const newBlock: ToolCallBlock = {
                type: 'tool_call',
                id: event.id as string,
                name: toolName,
                input: (event.input as Record<string, unknown>) ?? {},
                expanded: false,
              }
              setMessages((prev) =>
                prev.map((m, mi) => {
                  if (mi !== msgIdx) return m
                  return { ...m, blocks: [...m.blocks, newBlock] }
                })
              )
            } else if (evType === 'tool_result') {
              const toolId = event.id as string
              const preview = event.content_preview as string
              const toolName = event.name as string
              setActivity(`Reading ${humanizeToolName(toolName)} results…`)
              setMessages((prev) =>
                prev.map((m, mi) => {
                  if (mi !== msgIdx) return m
                  const blocks = m.blocks.map((b) => {
                    if (b.type === 'tool_call' && b.id === toolId) {
                      return { ...b, result: preview }
                    }
                    return b
                  })
                  return { ...m, blocks }
                })
              )
            } else if (evType === 'status') {
              const phase = event.phase as string
              if (phase === 'thinking') setActivity('Thinking through next step…')
            } else if (evType === 'done') {
              break
            } else if (evType === 'error') {
              throw new Error(event.message as string)
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        setMessages((prev) =>
          prev.map((m, mi) => {
            if (mi !== msgIdx) return m
            return {
              ...m,
              blocks: [
                ...m.blocks,
                { type: 'text', text: `Error: ${errMsg}` },
              ],
            }
          })
        )
      } finally {
        setStreaming(false)
      }
    },
    [messages, streaming, token, conversationId]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(draft)
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-[calc(100vh-4rem-2rem)] lg:h-[calc(100vh-4rem-4rem)] -m-4 sm:-m-6 lg:-m-8">
      {/* Header */}
      <div className="px-4 sm:px-6 py-3 border-b border-gray-200 bg-white shrink-0 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900">Chat with your portfolio</h1>
            {streaming && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-xs font-medium text-indigo-700 max-w-xs truncate">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
                </span>
                <span className="truncate">{activity}</span>
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">Powered by Claude — pulls live data from your brokers, FRED, Tiingo, Finnhub, and SEC EDGAR</p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setMessages([])
              setConversationId(null)
            }}
            aria-label="Start a new chat"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            <PlusIcon className="h-4 w-4" />
            New chat
          </button>
        )}
      </div>

      {/* Message area */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 bg-gray-50 relative"
      >
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-6">
            <div className="text-center">
              <p className="text-2xl mb-1">📈</p>
              <p className="text-gray-600 font-medium">Ask anything about your portfolio</p>
              <p className="text-gray-400 text-sm mt-1">
                Claude will pull live data from your connected brokers and search the web for macro context.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="px-4 py-2 rounded-full border border-gray-200 bg-white text-sm text-gray-700 hover:border-primary-400 hover:text-primary-700 hover:bg-primary-50 transition-colors shadow-sm"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, mi) => (
              <Bubble
                key={mi}
                msg={msg}
                onToolToggle={(bi) => toggleToolBlock(mi, bi)}
              />
            ))}
            {streaming && (
              <div className="flex justify-start mb-4">
                <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm flex items-center gap-2">
                  <span className="flex gap-1">
                    <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                  <span className="text-xs text-slate-600 font-medium">{activity}</span>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />

        {/* Floating "jump to latest" — appears when user is scrolled up while a response streams in */}
        {!stickToBottom && messages.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label="Jump to latest message"
            className="sticky bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900/90 text-white text-xs font-medium shadow-lg hover:bg-slate-900 transition-colors"
          >
            <ChevronDownIcon className="h-4 w-4" />
            {streaming ? 'Streaming — jump to latest' : 'Jump to latest'}
          </button>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-6 py-3">
        <div className="flex items-end gap-3 max-w-4xl mx-auto">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your portfolio..."
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-transparent disabled:opacity-50 transition-shadow"
            style={{ maxHeight: '8rem', overflowY: 'auto' }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`
            }}
          />
          <button
            onClick={() => sendMessage(draft)}
            disabled={!draft.trim() || streaming}
            className="shrink-0 flex items-center justify-center h-10 w-10 rounded-xl bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </div>
        <p className="text-center text-xs text-gray-400 mt-2">
          Press Enter to send &middot; Shift+Enter for newline
        </p>
      </div>
    </div>
  )
}
