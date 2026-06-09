import { useState, useRef, useCallback } from 'react'
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
} from 'react-native'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import { chatApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import type { ChatMessage } from '@/types'

interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  failed?: boolean
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
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const { user } = useAuthStore()
  const listRef = useRef<FlatList>(null)
  const streamingIdRef = useRef<string | null>(null)

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true })
    }, 80)
  }, [])

  const handleNewChat = useCallback(() => {
    if (isStreaming) return
    setMessages([])
    setInput('')
  }, [isStreaming])

  const runChat = useCallback(async (text: string, isRetry: boolean) => {
    if (!text || isStreaming) return

    const assistantId = `assistant-${Date.now()}`
    streamingIdRef.current = assistantId

    let nextMessages: UIMessage[] = []
    setMessages((prev) => {
      // On retry: drop the trailing failed assistant bubble but keep the
      // original user message. On a fresh send: append both user + new
      // assistant bubble.
      let base = prev
      if (isRetry) {
        // Drop trailing assistant bubbles that are failed/empty
        while (base.length > 0) {
          const last = base[base.length - 1]
          if (last.role === 'assistant' && (last.failed || !last.content)) {
            base = base.slice(0, -1)
          } else {
            break
          }
        }
      } else {
        const userMsg: UIMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: text,
        }
        base = [...base, userMsg]
      }
      const assistantMsg: UIMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
      }
      nextMessages = [...base, assistantMsg]
      return nextMessages
    })

    setIsStreaming(true)
    scrollToBottom()

    // Build history for API from the post-mutation message list — exclude
    // the new (empty) assistant bubble.
    const history: ChatMessage[] = nextMessages
      .filter((m) => !(m.role === 'assistant' && m.id === assistantId))
      .map((m) => ({ role: m.role, content: m.content }))
    if (history.length === 0 || history[history.length - 1].content !== text) {
      history.push({ role: 'user', content: text })
    }

    await chatApi.sendMessage(
      history,
      user?.family_id ?? undefined,
      (chunk) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + chunk } : m
          )
        )
        scrollToBottom()
      },
      () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m
          )
        )
        setIsStreaming(false)
        streamingIdRef.current = null
        scrollToBottom()
      },
      (err) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${err}`, streaming: false, failed: true }
              : m
          )
        )
        setIsStreaming(false)
        streamingIdRef.current = null
      }
    )
  }, [isStreaming, user?.family_id, scrollToBottom])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    await runChat(text, false)
  }, [input, runChat])

  const retryLast = useCallback(async () => {
    // Find the most recent user message and re-send it.
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
                // Initial loading indicator before first chunk arrives
                <View style={styles.loadingDots}>
                  <ActivityIndicator size="small" color="#6366f1" />
                  <Text style={styles.loadingText}>Thinking...</Text>
                </View>
              ) : (
                <Markdown style={markdownStyles}>
                  {item.content || ' '}
                </Markdown>
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
