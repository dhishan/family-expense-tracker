import { useEffect, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, Alert, SafeAreaView, Share } from 'react-native'
import { Stack, router } from 'expo-router'
import { getLogs, clearLogs, LogEntry } from '@/utils/debugLog'

export default function DebugScreen() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    refresh()
  }, [])

  async function refresh() {
    setLoading(true)
    const rows = await getLogs()
    setLogs(rows)
    setLoading(false)
  }

  async function copyAll() {
    const blob = logs
      .map((l) => `[${l.time}] ${l.level.toUpperCase()} ${l.message}${l.stack ? '\n' + l.stack : ''}${l.context ? '\nctx: ' + JSON.stringify(l.context) : ''}`)
      .join('\n\n')
    if (!blob) {
      Alert.alert('No logs', 'There are no log entries to share.')
      return
    }
    await Share.share({ message: blob, title: 'Debug Logs' })
  }

  async function wipe() {
    Alert.alert('Clear logs?', 'This removes all stored debug logs from the device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearLogs()
          await refresh()
        },
      },
    ])
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f8fafc' }}>
      <Stack.Screen options={{ title: 'Debug Logs', headerBackTitle: 'Back' }} />
      <View style={{ flexDirection: 'row', padding: 12, gap: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#e5e7eb' }}>
        <TouchableOpacity onPress={copyAll} style={{ flex: 1, backgroundColor: '#2563eb', padding: 10, borderRadius: 6, alignItems: 'center' }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={refresh} style={{ flex: 1, backgroundColor: '#e5e7eb', padding: 10, borderRadius: 6, alignItems: 'center' }}>
          <Text style={{ color: '#111827', fontWeight: '600' }}>Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={wipe} style={{ flex: 1, backgroundColor: '#fee2e2', padding: 10, borderRadius: 6, alignItems: 'center' }}>
          <Text style={{ color: '#b91c1c', fontWeight: '600' }}>Clear</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={() => router.back()} style={{ padding: 8, alignItems: 'flex-start' }}>
        <Text style={{ color: '#2563eb' }}>← Back</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 60 }}>
        {loading ? (
          <Text style={{ color: '#6b7280', textAlign: 'center', marginTop: 30 }}>Loading…</Text>
        ) : logs.length === 0 ? (
          <Text style={{ color: '#6b7280', textAlign: 'center', marginTop: 30 }}>No logs yet. Errors caught here will appear after a crash.</Text>
        ) : (
          logs.map((l, i) => (
            <View key={i} style={{ backgroundColor: '#fff', padding: 10, marginBottom: 8, borderRadius: 6, borderLeftWidth: 3, borderLeftColor: levelColor(l.level) }}>
              <Text style={{ fontSize: 11, color: '#6b7280' }}>{l.time} · {l.level.toUpperCase()}</Text>
              <Text style={{ fontSize: 13, marginTop: 4, fontWeight: '600' }}>{l.message}</Text>
              {l.stack ? (
                <Text style={{ fontSize: 11, fontFamily: 'Menlo', color: '#374151', marginTop: 4 }}>{l.stack}</Text>
              ) : null}
              {l.context ? (
                <Text style={{ fontSize: 11, fontFamily: 'Menlo', color: '#6b7280', marginTop: 4 }}>{JSON.stringify(l.context)}</Text>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function levelColor(level: LogEntry['level']): string {
  switch (level) {
    case 'fatal':
      return '#dc2626'
    case 'error':
      return '#ef4444'
    case 'warn':
      return '#f59e0b'
    default:
      return '#3b82f6'
  }
}
