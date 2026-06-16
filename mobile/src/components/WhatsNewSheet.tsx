/**
 * "What's new" modal — shows the active OTA update's commit message on
 * first app launch after that update lands. Tracks acknowledged update
 * IDs in AsyncStorage so the same modal doesn't appear twice.
 *
 * The OTA workflow (.github/workflows/mobile-ota.yml) populates the
 * update message with the commit subjects in the push, e.g.
 *   "feat(chat): model switcher • fix(mobile): edit modal blanks"
 *
 * In dev (no EAS update applied) and on the initial install (no embedded
 * update message), the sheet stays hidden.
 */
import { useEffect, useState } from 'react'
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native'
import * as Updates from 'expo-updates'
import AsyncStorage from '@react-native-async-storage/async-storage'

const ACK_KEY = 'whatsnew:lastAckUpdateId'

function splitBullets(msg: string): string[] {
  if (!msg) return []
  // The OTA workflow joins subjects with " • ". Tolerate other separators.
  return msg
    .split(/\s+•\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function WhatsNewSheet() {
  const [visible, setVisible] = useState(false)
  const [items, setItems] = useState<string[]>([])
  const [updateId, setUpdateId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        // expo-updates surfaces the active update id + manifest message.
        // updateId is non-null only when an EAS update has been applied.
        const id = (Updates as unknown as { updateId?: string | null }).updateId ?? null
        const manifest =
          (Updates as unknown as { manifest?: { message?: string } | null }).manifest ?? null
        const message = manifest?.message ?? ''
        if (!id || !message) return
        const lastAck = await AsyncStorage.getItem(ACK_KEY)
        if (lastAck === id) return
        const parts = splitBullets(message)
        if (parts.length === 0) return
        if (cancelled) return
        setUpdateId(id)
        setItems(parts)
        setVisible(true)
      } catch {
        // Never block app launch on this.
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = async () => {
    setVisible(false)
    if (updateId) {
      try {
        await AsyncStorage.setItem(ACK_KEY, updateId)
      } catch {
        // ignore — worst case the sheet shows once more next launch
      }
    }
  }

  if (!visible) return null

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>What's new</Text>
          <Text style={styles.subtitle}>You just got the latest update.</Text>
          <ScrollView style={styles.list}>
            {items.map((line, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.lineText}>{line}</Text>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity onPress={dismiss} style={styles.btn}>
            <Text style={styles.btnText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 13, color: '#6b7280', marginTop: 4, marginBottom: 12 },
  list: { marginBottom: 16 },
  row: { flexDirection: 'row', paddingVertical: 6 },
  bullet: { color: '#2563eb', fontWeight: '700', marginRight: 8, width: 12 },
  lineText: { color: '#374151', flex: 1, fontSize: 14, lineHeight: 20 },
  btn: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
})
