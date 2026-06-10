import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

function TabIcon({
  name,
  focused,
  color,
}: {
  name: IoniconsName
  focused: boolean
  color: string
}) {
  return <Ionicons name={focused ? name : (`${name}-outline` as IoniconsName)} size={24} color={color} />
}

export default function TabsLayout() {
  // Respect the home-indicator area at the bottom of modern iPhones.
  // Without insets.bottom, the tab labels sit on top of the home bar
  // and get visually clipped.
  const insets = useSafeAreaInsets()

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#2563eb',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopColor: '#e5e7eb',
          borderTopWidth: 1,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 6,
          height: 56 + Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: {
          // Smaller + tighter so 6 tabs fit on an iPhone Pro without
          // truncating "Dashboard" → "Dashbo…" or "Investments" → "Invest…"
          fontSize: 10,
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarItemStyle: {
          paddingHorizontal: 0,
        },
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="home" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="expenses"
        options={{
          title: 'Transactions',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="receipt" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="budgets"
        options={{
          title: 'Budgets',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="wallet" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="investments"
        options={{
          title: 'Stocks',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="trending-up" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="chatbubble" focused={focused} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="settings" focused={focused} color={color} />
          ),
        }}
      />
    </Tabs>
  )
}
