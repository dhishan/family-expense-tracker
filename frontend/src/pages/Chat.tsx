import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { useAuthStore } from '../store/auth'
import { PaperAirplaneIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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
              <div key={idx} className="prose prose-sm max-w-none text-gray-800 [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-gray-100 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-auto [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
                <ReactMarkdown>{block.text}</ReactMarkdown>
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { token } = useAuthStore()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

      // Build the messages array for the API (role + content only).
      const userMessage: Message = { role: 'user', blocks: [{ type: 'text', text: text.trim() }] }
      const assistantMessage: Message = { role: 'assistant', blocks: [] }

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setStreaming(true)

      const msgIdx = messages.length + 1 // index of the assistant message we just appended

      // Flatten history to [{role, content}] for the API.
      const history = [
        ...messages.map((m) => ({
          role: m.role,
          content: m.blocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as TextBlock).text)
            .join(''),
        })),
        { role: 'user' as const, content: text.trim() },
      ]

      try {
        const resp = await fetch(`${API_URL}/api/v1/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ messages: history }),
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
              const newBlock: ToolCallBlock = {
                type: 'tool_call',
                id: event.id as string,
                name: event.name as string,
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
    [messages, streaming, token]
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
      <div className="px-4 sm:px-6 py-3 border-b border-gray-200 bg-white shrink-0">
        <h1 className="text-lg font-semibold text-gray-900">Chat with your portfolio</h1>
        <p className="text-xs text-gray-500">Powered by Claude Opus — pulls live data from your connected brokers</p>
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 bg-gray-50">
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
            {streaming && messages[messages.length - 1]?.blocks.length === 0 && (
              <div className="flex justify-start mb-4">
                <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                  <span className="flex gap-1">
                    <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
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
