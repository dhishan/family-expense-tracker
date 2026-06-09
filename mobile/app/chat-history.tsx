import { useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native'
import { useRouter, Stack } from 'expo-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { chatApi, type ChatConversationSummary } from '@/services/api'

function formatRelative(updatedAt: string | null): string {
  if (!updatedAt) return ''
  const then = new Date(updatedAt).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(updatedAt).toLocaleDateString()
}

export default function ChatHistoryScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const qc = useQueryClient()

  const { data: conversations, isLoading, refetch } = useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => chatApi.listConversations(50),
    staleTime: 0,
  })

  const deleteMut = useMutation({
    mutationFn: (convId: string) => chatApi.deleteConversation(convId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat', 'conversations'] }),
  })

  const openConv = useCallback(
    (id: string) => {
      // Routes through the (tabs)/chat screen which reads conversation_id
      // from the URL params and loads the full transcript.
      router.replace({ pathname: '/(tabs)/chat', params: { conversation_id: id } })
    },
    [router],
  )

  const confirmDelete = useCallback(
    (conv: ChatConversationSummary) => {
      Alert.alert(
        'Delete chat?',
        conv.title || 'This conversation will be permanently removed.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteMut.mutate(conv.id),
          },
        ],
      )
    },
    [deleteMut],
  )

  const renderItem = useCallback(
    ({ item }: { item: ChatConversationSummary }) => (
      <TouchableOpacity
        style={styles.row}
        onPress={() => openConv(item.id)}
        testID={`chat-row-${item.id}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title || 'Untitled chat'}
          </Text>
          <Text style={styles.meta}>
            {formatRelative(item.updated_at)} · {item.turn_count} turn
            {item.turn_count === 1 ? '' : 's'}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => confirmDelete(item)}
          hitSlop={8}
          style={styles.deleteBtn}
          testID={`chat-delete-${item.id}`}
        >
          <Ionicons name="trash-outline" size={18} color="#94a3b8" />
        </TouchableOpacity>
      </TouchableOpacity>
    ),
    [openConv, confirmDelete],
  )

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={8}
            style={styles.backBtn}
          >
            <Ionicons name="chevron-back" size={22} color="#0f172a" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Recent chats</Text>
          <View style={{ width: 32 }} />
        </View>

        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color="#6366f1" />
          </View>
        ) : (conversations?.length ?? 0) === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyHint}>
              Start a chat from the Chat tab. Past chats will show up here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={conversations}
            keyExtractor={(c) => c.id}
            renderItem={renderItem}
            refreshing={false}
            onRefresh={refetch}
            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          />
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  title: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  meta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  deleteBtn: { padding: 8, marginLeft: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  emptyHint: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 6,
  },
})
