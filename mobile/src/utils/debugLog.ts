import AsyncStorage from '@react-native-async-storage/async-storage'

// Lightweight ring-buffer of recent log entries persisted to AsyncStorage
// so a user can open the "Debug" screen after a crash and share what
// the app saw. Cheap, no external dependency. Keep last 100 entries.

const KEY = 'debug:logs:v1'
const MAX_ENTRIES = 100

export type LogLevel = 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  time: string
  level: LogLevel
  message: string
  stack?: string
  context?: Record<string, unknown>
}

let buffer: LogEntry[] = []
let loaded = false

async function load() {
  if (loaded) return
  try {
    const raw = await AsyncStorage.getItem(KEY)
    buffer = raw ? JSON.parse(raw) : []
  } catch {
    buffer = []
  }
  loaded = true
}

async function persist() {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(buffer))
  } catch {
    // best-effort
  }
}

export async function logEntry(level: LogLevel, message: string, opts?: { stack?: string; context?: Record<string, unknown> }) {
  await load()
  buffer.unshift({
    time: new Date().toISOString(),
    level,
    message,
    stack: opts?.stack,
    context: opts?.context,
  })
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(0, MAX_ENTRIES)
  await persist()
}

export async function getLogs(): Promise<LogEntry[]> {
  await load()
  return buffer.slice()
}

export async function clearLogs() {
  buffer = []
  await persist()
}

export function installGlobalErrorHandler() {
  // Capture JS-level fatal errors. The original handler (red box in dev,
  // silent in prod) still runs after we log.
  const prev = (global as { ErrorUtils?: { getGlobalHandler: () => (e: Error, isFatal?: boolean) => void; setGlobalHandler: (fn: (e: Error, isFatal?: boolean) => void) => void } }).ErrorUtils
  if (!prev) return
  const original = prev.getGlobalHandler()
  prev.setGlobalHandler((err: Error, isFatal?: boolean) => {
    logEntry(isFatal ? 'fatal' : 'error', err?.message || String(err), { stack: err?.stack }).catch(() => {})
    original(err, isFatal)
  })
}
