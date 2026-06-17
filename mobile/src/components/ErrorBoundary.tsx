import { Component, ReactNode } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import { router } from 'expo-router'
import { logEntry } from '@/utils/debugLog'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err?.message || String(err) }
  }

  componentDidCatch(err: Error, info: { componentStack?: string }) {
    void logEntry('fatal', err?.message || String(err), {
      stack: err?.stack,
      context: { componentStack: info.componentStack },
    })
  }

  reset = () => this.setState({ hasError: false, message: '' })

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#fff' }}>
        <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 8 }}>Something broke</Text>
        <Text style={{ fontSize: 14, color: '#374151', marginBottom: 20 }}>{this.state.message}</Text>
        <TouchableOpacity onPress={this.reset} style={{ backgroundColor: '#2563eb', padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            this.reset()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            router.push('/debug' as any)
          }}
          style={{ padding: 12, alignItems: 'center' }}
        >
          <Text style={{ color: '#2563eb', fontWeight: '600' }}>View debug logs</Text>
        </TouchableOpacity>
      </View>
    )
  }
}
