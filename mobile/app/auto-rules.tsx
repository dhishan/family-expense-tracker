import { useState, useCallback } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native'
import { router } from 'expo-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rulesApi } from '@/services/api'
import { CATEGORY_INFO } from '@/types'
import type { MerchantRule } from '@/types'

const CATEGORY_EMOJI: Record<string, string> = {
  groceries: '🛒',
  dining: '🍽',
  transportation: '🚗',
  utilities: '💡',
  entertainment: '🎬',
  healthcare: '🏥',
  shopping: '🛍',
  travel: '✈️',
  education: '📚',
  other: '📝',
}

export default function AutoRulesScreen() {
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'merchant'],
    queryFn: rulesApi.list,
  })

  const rules: MerchantRule[] = (data ?? []).slice().sort(
    (a, b) => b.applied_count - a.applied_count
  )

  const deleteMutation = useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
    },
    onError: () => Alert.alert('Error', 'Failed to delete rule.'),
  })

  const handleDelete = useCallback((rule: MerchantRule) => {
    Alert.alert(
      'Delete rule?',
      `Future "${rule.merchant}" transactions will no longer be auto-categorised.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteMutation.mutate(rule.id),
        },
      ]
    )
  }, [deleteMutation])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await queryClient.invalidateQueries({ queryKey: ['rules', 'merchant'] })
    setRefreshing(false)
  }, [queryClient])

  const renderRule = ({ item }: { item: MerchantRule }) => {
    const catLabel = CATEGORY_INFO[item.category]?.label ?? item.category
    const emoji = CATEGORY_EMOJI[item.category] ?? '📝'
    return (
      <View style={styles.ruleRow} testID={`rule-row-${item.id}`}>
        <View style={styles.ruleBody}>
          <Text style={styles.ruleMerchant} numberOfLines={1}>{item.merchant}</Text>
          <View style={styles.ruleMeta}>
            <Text style={styles.ruleCat}>{emoji} {catLabel}</Text>
          </View>
          <Text style={styles.ruleFootnote}>
            Applied {item.applied_count} time{item.applied_count !== 1 ? 's' : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item)}
          testID={`delete-rule-${item.id}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.deleteBtnText}>Delete</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Auto-Rules</Text>
        <View style={{ width: 56 }} />
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={rules}
          keyExtractor={(item) => item.id}
          contentContainerStyle={rules.length === 0 ? styles.emptyContainer : { paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563eb" />
          }
          testID="rules-list"
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No auto-rules yet</Text>
              <Text style={styles.emptySubtitle}>
                When approving a transaction, check "Always apply to future" to create a rule.
              </Text>
            </View>
          }
          renderItem={renderRule}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { width: 56 },
  backText: { fontSize: 17, color: '#2563eb' },
  title: { fontSize: 17, fontWeight: '600', color: '#111827' },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 10,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  ruleBody: { flex: 1, marginRight: 12 },
  ruleMerchant: { fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 2 },
  ruleMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  ruleCat: { fontSize: 13, color: '#374151' },
  ruleFootnote: { fontSize: 11, color: '#9ca3af' },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fca5a5',
    backgroundColor: '#fef2f2',
  },
  deleteBtnText: { fontSize: 13, color: '#dc2626', fontWeight: '500' },
  emptyContainer: { flex: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    paddingTop: 80,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#374151', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#9ca3af', textAlign: 'center', lineHeight: 20 },
})
