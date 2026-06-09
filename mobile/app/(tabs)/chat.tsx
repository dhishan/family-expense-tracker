import { useState, useRef, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  AppState,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import { chatApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'

interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  failed?: boolean
  /** Live status line shown while tools are running (e.g. "Pulling portfolio data…"). */
  status?: string | null
}

// Friendly label per tool name. Server emits tool_call events with the
// raw name; we render a human-readable status line so the user sees
// progress without waiting for Claude to narrate (which costs a full
// 15-20s LLM turn per line — see chat.py system prompt).
const TOOL_LABELS: Record<string, string> = {
  list_accounts: 'Listing accounts',
  get_holdings: 'Pulling portfolio holdings',
  get_account_balances: 'Reading account balances',
  get_account_positions: 'Reading account positions',
  get_activities: 'Pulling recent activity',
  get_cost_basis: 'Computing cost basis',
  portfolio_summary: 'Building portfolio summary',
  macro_indicator: 'Fetching macro data (FRED)',
  macro_series: 'Pulling macro time series',
  price_history: 'Pulling price history',
  ticker_meta: 'Looking up ticker',
  ticker_quote: 'Getting current quote',
  ticker_news: 'Reading recent news',
  ticker_recommendations: 'Checking analyst ratings',
  ticker_price_target: 'Pulling analyst price target',
  ticker_earnings_calendar: 'Checking earnings calendar',
  expense_list: 'Reading expenses',
  expense_summary: 'Summarizing expenses',
  expense_top_merchants: 'Ranking merchants',
  budget_status: 'Checking budget status',
  budget_burn_rate: 'Computing burn rate',
  edgar_company_lookup: 'Looking up SEC filings',
  edgar_recent_filings: 'Pulling SEC filings',
  edgar_company_facts: 'Reading SEC financials',
  edgar_insider_transactions: 'Checking insider transactions',
  web_search: 'Searching the web',
}

function labelForTool(name: string, input?: Record<string, unknown>): string {
  const base = TOOL_LABELS[name] ?? name
  const sym =
    (input?.symbol as string | undefined) ??
    (input?.ticker as string | undefined) ??
    (input?.series_id as string | undefined)
  return sym ? `${base} (${sym})` : base
}

// Notion-inspired markdown styles — slate palette, indigo accents
const markdownStyles = StyleSheet.create({
  body: {
    color: '#334155',   // slate-700
    fontSize: 15,
    lineHeight: 24,
  } as object,
  heading1: {
    color: '#0f172a',   // slate-900
    fontWeight: '700',
    fontSize: 20,
    marginTop: 12,
    marginBottom: 6,
  } as object,
  heading2: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 17,
    marginTop: 10,
    marginBottom: 4,
  } as object,
  heading3: {
    color: '#1e293b',   // slate-800
    fontWeight: '600',
    fontSize: 15,
    marginTop: 8,
    marginBottom: 4,
  } as object,
  strong: {
    color: '#0f172a',
    fontWeight: '700',
  } as object,
  link: {
    color: '#6366f1',   // indigo-500
    textDecorationLine: 'underline',
  } as object,
  blockquote: {
    backgroundColor: '#eef2ff',   // indigo-50
    borderLeftWidth: 3,
    borderLeftColor: '#6366f1',   // indigo-500
    paddingLeft: 12,
    paddingVertical: 4,
    marginVertical: 6,
    borderRadius: 2,
  } as object,
  code_inline: {
    backgroundColor: '#f1f5f9',  // slate-100
    color: '#be185d',            // pink-700 for code
    fontFamily: 'Courier',
    fontSize: 13,
    borderRadius: 3,
    paddingHorizontal: 4,
  } as object,
  fence: {
    backgroundColor: '#1e293b',  // slate-800 dark code block
    borderRadius: 8,
    padding: 12,
    marginVertical: 6,
  } as object,
  code_block: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    padding: 12,
    marginVertical: 6,
  } as object,
  // Tables - striped rows
  table: {
    borderWidth: 1,
    borderColor: '#e2e8f0',  // slate-200
    borderRadius: 6,
    marginVertical: 8,
    overflow: 'hidden',
  } as object,
  thead: {
    backgroundColor: '#f8fafc',  // slate-50
  } as object,
  th: {
    color: '#475569',  // slate-600
    fontWeight: '600',
    fontSize: 12,
    padding: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  } as object,
  td: {
    color: '#334155',
    fontSize: 14,
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',  // slate-100
  } as object,
  tr: {
    backgroundColor: '#fff',
  } as object,
  bullet_list: {
    marginVertical: 4,
  } as object,
  ordered_list: {
    marginVertical: 4,
  } as object,
  list_item: {
    flexDirection: 'row',
    marginBottom: 2,
  } as object,
  paragraph: {
    marginTop: 0,
    marginBottom: 6,
  } as object,
})

export default function ChatScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ conversation_id?: string }>()
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const { user } = useAuthStore()
  const listRef = useRef<FlatList>(null)
  const streamingIdRef = useRef<string | null>(null)

  // ─── Durable conversation state ───────────────────────────────────────────
  //
  // The new chat architecture stores everything server-side in Firestore.
  // The mobile client just needs to remember the IDs of the current
  // conversation + the in-flight assistant turn (if any) so it can
  // re-attach to the SSE stream after the app is backgrounded.
  const convIdRef = useRef<string | null>(null)
  const assistantTurnIdRef = useRef<string | null>(null)
  // Highest event seq we have already rendered. Sent to the resume
  // endpoint as `from_seq` so the server skips replayed events.
  const lastSeqRef = useRef<number>(0)
  // Active SSE cleanup; called on unmount/background/disconnect.
  const streamCleanupRef = useRef<(() => void) | null>(null)

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true })
    }, 80)
  }, [])

  // ─── Load existing conversation if routed in with ?conversation_id=… ──────
  useEffect(() => {
    const convId = params.conversation_id
    if (!convId || convIdRef.current === convId) return
    let cancelled = false
    ;(async () => {
      try {
        const conv = await chatApi.getConversation(convId)
        if (cancelled) return
        convIdRef.current = conv.id
        assistantTurnIdRef.current = null
        lastSeqRef.current = 0
        const ui: UIMessage[] = conv.turns.map((t) => ({
          id: t.id,
          role: t.role,
          content: t.text,
          streaming: t.status === 'streaming',
          failed: t.status === 'error',
        }))
        setMessages(ui)
        // If the last turn was mid-stream, re-attach.
        const last = conv.turns[conv.turns.length - 1]
        if (last && last.role === 'assistant' && last.status === 'streaming') {
          assistantTurnIdRef.current = last.id
          openResumeStream(conv.id, last.id, 0)
        }
      } catch {
        // 404 / network → ignore, user can start a new chat
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.conversation_id])

  const handleNewChat = useCallback(() => {
    if (isStreaming) return
    // Tear down any active stream and reset all conversation state.
    streamCleanupRef.current?.()
    streamCleanupRef.current = null
    convIdRef.current = null
    assistantTurnIdRef.current = null
    lastSeqRef.current = 0
    setMessages([])
    setInput('')
    if (params.conversation_id) {
      router.setParams({ conversation_id: undefined })
    }
  }, [isStreaming, params.conversation_id, router])

  /** Open (or re-open) the SSE stream for a streaming assistant turn. */
  const openResumeStream = useCallback(
    (convId: string, turnId: string, fromSeq: number) => {
      streamCleanupRef.current?.()
      setIsStreaming(true)

      const handlers = {
        onSeq: (seq: number) => {
          if (seq > lastSeqRef.current) lastSeqRef.current = seq
        },
        onText: (chunk: string) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === turnId
                ? { ...m, content: m.content + chunk, status: null }
                : m,
            ),
          )
          scrollToBottom()
        },
        onToolCall: (tool: { id: string; name: string; input: unknown }) => {
          const label = labelForTool(
            tool.name,
            tool.input as Record<string, unknown> | undefined,
          )
          setMessages((prev) =>
            prev.map((m) => (m.id === turnId ? { ...m, status: label } : m)),
          )
          scrollToBottom()
        },
        onToolResult: () => {
          setMessages((prev) =>
            prev.map((m) => (m.id === turnId ? { ...m, status: null } : m)),
          )
        },
        onDone: () => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === turnId
                ? { ...m, streaming: false, status: null }
                : m,
            ),
          )
          setIsStreaming(false)
          streamingIdRef.current = null
          streamCleanupRef.current = null
          scrollToBottom()
        },
        onError: (err: string) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === turnId
                ? {
                    ...m,
                    content: m.content || `Error: ${err}`,
                    streaming: false,
                    failed: true,
                    status: null,
                  }
                : m,
            ),
          )
          setIsStreaming(false)
          streamingIdRef.current = null
          streamCleanupRef.current = null
        },
      }

      chatApi
        .openStream(convId, turnId, fromSeq, handlers)
        .then((cleanup) => {
          streamCleanupRef.current = cleanup
        })
        .catch((e) => {
          handlers.onError(String(e?.message ?? e))
        })
    },
    [scrollToBottom],
  )

  const runChat = useCallback(
    async (text: string, isRetry: boolean) => {
      if (!text || isStreaming) return

      // Build the optimistic UI update first; we'll replace ids with the
      // server-assigned ones once /chat/start responds.
      const tempUserId = `user-temp-${Date.now()}`
      const tempAssistantId = `assistant-temp-${Date.now()}`

      setMessages((prev) => {
        let base = prev
        if (isRetry) {
          while (base.length > 0) {
            const last = base[base.length - 1]
            if (last.role === 'assistant' && (last.failed || !last.content)) {
              base = base.slice(0, -1)
            } else {
              break
            }
          }
          // On retry we don't add a new user message — the existing one
          // is reused.
          return [
            ...base,
            {
              id: tempAssistantId,
              role: 'assistant',
              content: '',
              streaming: true,
            },
          ]
        }
        return [
          ...base,
          { id: tempUserId, role: 'user', content: text },
          {
            id: tempAssistantId,
            role: 'assistant',
            content: '',
            streaming: true,
          },
        ]
      })

      setIsStreaming(true)
      scrollToBottom()

      let started: Awaited<ReturnType<typeof chatApi.start>>
      try {
        started = await chatApi.start({
          conversation_id: convIdRef.current,
          message: text,
          family_id: user?.family_id ?? null,
        })
      } catch (e) {
        const errMsg = (e as Error)?.message ?? 'Failed to start chat'
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempAssistantId
              ? { ...m, content: `Error: ${errMsg}`, streaming: false, failed: true }
              : m,
          ),
        )
        setIsStreaming(false)
        return
      }

      convIdRef.current = started.conversation_id
      assistantTurnIdRef.current = started.assistant_turn_id
      lastSeqRef.current = 0
      streamingIdRef.current = started.assistant_turn_id

      // Swap the temp IDs for the server-assigned ones so resume works
      // even mid-render.
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return { ...m, id: started.user_turn_id }
          if (m.id === tempAssistantId)
            return { ...m, id: started.assistant_turn_id }
          return m
        }),
      )

      openResumeStream(started.conversation_id, started.assistant_turn_id, 0)
    },
    [isStreaming, user?.family_id, scrollToBottom, openResumeStream],
  )

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    await runChat(text, false)
  }, [input, runChat])

  const retryLast = useCallback(async () => {
    let lastUser: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = messages[i].content
        break
      }
    }
    if (!lastUser) return
    await runChat(lastUser, true)
  }, [messages, runChat])

  // ─── App-state: resume the stream when returning from background ──────────
  //
  // iOS suspends the JS runtime within ~5-30s of backgrounding, which tears
  // down our SSE socket. The server-side generation continues regardless
  // (background asyncio task on Cloud Run min_instances=1). When the user
  // foregrounds the app, we re-open the stream against the same turn,
  // sending `from_seq=last_seen` so we only get the events we missed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return
      if (!convIdRef.current || !assistantTurnIdRef.current) return
      if (!isStreaming) return
      openResumeStream(
        convIdRef.current,
        assistantTurnIdRef.current,
        lastSeqRef.current,
      )
    })
    return () => sub.remove()
  }, [isStreaming, openResumeStream])

  // Tear down any active SSE on unmount.
  useEffect(() => {
    return () => {
      streamCleanupRef.current?.()
      streamCleanupRef.current = null
    }
  }, [])

  const renderMessage = ({ item }: { item: UIMessage }) => {
    const isUser = item.role === 'user'
    return (
      <View style={[styles.messageRow, isUser && styles.messageRowUser]}>
        {!isUser && (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>AI</Text>
          </View>
        )}
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAssistant,
          ]}
          testID={`message-bubble-${item.role}`}
        >
          {isUser ? (
            <Text style={styles.userText}>{item.content}</Text>
          ) : (
            <>
              {item.streaming && !item.content ? (
                // Initial loading indicator before first chunk arrives.
                // If a tool is currently running, show its label instead
                // of a generic "Thinking…".
                <View style={styles.loadingDots}>
                  <ActivityIndicator size="small" color="#6366f1" />
                  <Text style={styles.loadingText}>
                    {item.status ?? 'Thinking…'}
                  </Text>
                </View>
              ) : (
                <>
                  <Markdown style={markdownStyles}>
                    {item.content || ' '}
                  </Markdown>
                  {item.streaming && item.status ? (
                    // In-progress tool status (e.g. "Pulling portfolio data")
                    // shown beneath any text already streamed.
                    <View style={styles.statusRow}>
                      <ActivityIndicator size="small" color="#6366f1" />
                      <Text style={styles.statusText}>{item.status}</Text>
                    </View>
                  ) : null}
                </>
              )}
              {item.streaming && item.content ? (
                // Streaming indicator while content is arriving
                <View style={styles.streamingIndicator}>
                  <View style={styles.streamingDot} />
                  <View style={[styles.streamingDot, { animationDelay: '0.2s' }]} />
                  <View style={[styles.streamingDot, { animationDelay: '0.4s' }]} />
                </View>
              ) : null}
              {item.failed ? (
                <TouchableOpacity
                  onPress={retryLast}
                  disabled={isStreaming}
                  style={styles.retryBtn}
                  testID="retry-btn"
                >
                  <Ionicons name="refresh" size={14} color="#2563eb" />
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Chat</Text>
          <Text style={styles.subtitle}>Ask about your finances</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push('/chat-history')}
            testID="chat-history-btn"
            hitSlop={8}
          >
            <Ionicons name="time-outline" size={20} color="#2563eb" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.newChatBtn, isStreaming && styles.newChatBtnDisabled]}
            onPress={handleNewChat}
            disabled={isStreaming}
            testID="new-chat-btn"
          >
            <Ionicons name="create-outline" size={16} color={isStreaming ? '#9ca3af' : '#2563eb'} />
            <Text style={[styles.newChatText, isStreaming && { color: '#9ca3af' }]}>
              New chat
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={[
          styles.messageList,
          messages.length === 0 && styles.messageListEmpty,
        ]}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>💬</Text>
            <Text style={styles.emptyTitle}>Ask anything about your finances</Text>
            <Text style={styles.emptySubtitle}>
              Try: "How much did I spend on dining this month?" or "Which stocks are down
              the most in my portfolio?"
            </Text>
          </View>
        }
        onContentSizeChange={scrollToBottom}
      />

      {/* Input */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
          placeholderTextColor="#94a3b8"
          multiline
          maxLength={2000}
          editable={!isStreaming}
          testID="chat-input"
          returnKeyType="send"
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() || isStreaming) && styles.sendBtnDisabled]}
          onPress={sendMessage}
          disabled={!input.trim() || isStreaming}
          testID="send-btn"
        >
          {isStreaming ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="arrow-up" size={18} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },  // slate-50
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',  // slate-200
  },
  title: { fontSize: 22, fontWeight: '700', color: '#0f172a' },  // slate-900
  subtitle: { fontSize: 13, color: '#94a3b8', marginTop: 2 },    // slate-400
  newChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#dbeafe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#eff6ff',
  },
  newChatBtnDisabled: {
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  newChatText: { fontSize: 13, color: '#2563eb', fontWeight: '500' },
  messageList: { padding: 16, paddingBottom: 8 },
  messageListEmpty: { flex: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'center', paddingHorizontal: 32 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1e293b',  // slate-800
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#94a3b8',  // slate-400
    textAlign: 'center',
    lineHeight: 20,
  },
  messageRow: { flexDirection: 'row', marginBottom: 14, alignItems: 'flex-end' },
  messageRowUser: { justifyContent: 'flex-end' },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#6366f1',  // indigo-500
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  avatarText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  bubble: {
    maxWidth: '82%',
    borderRadius: 16,
    padding: 12,
  },
  bubbleUser: {
    backgroundColor: '#6366f1',  // indigo-500
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#f1f5f9',  // slate-100
  },
  userText: { color: '#fff', fontSize: 15, lineHeight: 22 },
  loadingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  loadingText: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic' },
  streamingIndicator: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 6,
    paddingHorizontal: 2,
  },
  streamingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#c7d2fe',  // indigo-200
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#eef2ff',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingHorizontal: 2,
  },
  statusText: {
    color: '#64748b', // slate-500
    fontSize: 13,
    fontStyle: 'italic',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#eef2ff',  // indigo-50
  },
  retryText: {
    color: '#2563eb',
    fontSize: 13,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',  // slate-200
    gap: 10,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cbd5e1',  // slate-300
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0f172a',  // slate-900
    maxHeight: 120,
    backgroundColor: '#f8fafc',  // slate-50
  },
  sendBtn: {
    backgroundColor: '#6366f1',  // indigo-500
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#c7d2fe' },  // indigo-200
})
