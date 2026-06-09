import React from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react-native'

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('mock-jwt'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }))

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}))

jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native')
  return ({ children }: { children: string }) => <Text>{children}</Text>
})

// Mock chatApi.sendMessage - simulates SSE stream
jest.mock('@/services/api', () => ({
  chatApi: {
    sendMessage: jest.fn(
      async (
        _messages: unknown,
        _familyId: unknown,
        onChunk: (c: string) => void,
        onDone: () => void
      ) => {
        onChunk('Hello from ')
        onChunk('the AI!')
        onDone()
      }
    ),
  },
}))

jest.mock('@/store/auth', () => ({
  useAuthStore: jest.fn(() => ({
    user: { id: 'user-1', family_id: 'f1' },
  })),
}))

import ChatScreen from '../app/(tabs)/chat'
import { chatApi } from '@/services/api'

describe('ChatScreen', () => {
  it('renders empty state initially', () => {
    const { getByText } = render(<ChatScreen />)
    expect(getByText('Ask anything about your finances')).toBeTruthy()
  })

  it('renders input and send button', () => {
    const { getByTestId } = render(<ChatScreen />)
    expect(getByTestId('chat-input')).toBeTruthy()
    expect(getByTestId('send-btn')).toBeTruthy()
  })

  it('send button is disabled when input is empty', () => {
    const { getByTestId } = render(<ChatScreen />)
    const btn = getByTestId('send-btn')
    expect(btn.props.accessibilityState?.disabled || btn.props.disabled).toBeTruthy()
  })

  it('sends message and receives streamed response', async () => {
    const { getByTestId, getAllByTestId } = render(<ChatScreen />)

    fireEvent.changeText(getByTestId('chat-input'), 'How much did I spend?')

    await act(async () => {
      fireEvent.press(getByTestId('send-btn'))
    })

    await waitFor(() => {
      expect(chatApi.sendMessage).toHaveBeenCalled()
      const bubbles = getAllByTestId(/message-bubble/)
      expect(bubbles.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('SSE chunks are assembled into assistant message', async () => {
    const { getByTestId, getByText } = render(<ChatScreen />)

    fireEvent.changeText(getByTestId('chat-input'), 'Test message')

    await act(async () => {
      fireEvent.press(getByTestId('send-btn'))
    })

    await waitFor(() => {
      expect(getByText('Hello from the AI!')).toBeTruthy()
    })
  })

  it('clears input after sending', async () => {
    const { getByTestId } = render(<ChatScreen />)
    const input = getByTestId('chat-input')

    fireEvent.changeText(input, 'A question')

    await act(async () => {
      fireEvent.press(getByTestId('send-btn'))
    })

    await waitFor(() => {
      expect(input.props.value).toBe('')
    })
  })

  it('"New chat" button clears messages', async () => {
    const { getByTestId, getByText, queryByText } = render(<ChatScreen />)

    // Send a message
    fireEvent.changeText(getByTestId('chat-input'), 'Hello')
    await act(async () => {
      fireEvent.press(getByTestId('send-btn'))
    })

    await waitFor(() => expect(getByText('Hello')).toBeTruthy())

    // Press "New chat"
    fireEvent.press(getByTestId('new-chat-btn'))

    // Messages should be gone; empty state should return
    expect(queryByText('Hello')).toBeNull()
    expect(getByText('Ask anything about your finances')).toBeTruthy()
  })
})
