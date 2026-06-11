// Shared types - mirrored from frontend/src/types/index.ts
// Keep in sync manually or via script.

export interface User {
  id: string
  email: string
  display_name: string
  photo_url: string | null
  family_id: string | null
  created_at: string
  updated_at: string
}

export interface Family {
  id: string
  name: string
  created_at: string
  created_by: string
  invite_code: string
  categories: string[]
  beneficiary_labels: Record<string, string>
}

export interface FamilyMember {
  id: string
  email: string
  display_name: string
  photo_url: string | null
}

export interface FamilyWithMembers extends Family {
  members: FamilyMember[]
}

export type ExpenseCategory =
  | 'groceries'
  | 'dining'
  | 'transportation'
  | 'utilities'
  | 'entertainment'
  | 'healthcare'
  | 'shopping'
  | 'travel'
  | 'education'
  | 'other'

export type PaymentMethod =
  | 'cash'
  | 'credit'
  | 'debit'
  | 'bank_transfer'
  | 'paypal'
  | 'venmo'
  | 'other'

export interface Expense {
  id: string
  family_id: string
  amount: number
  currency: string
  date: string
  description: string
  merchant: string | null
  payment_method: PaymentMethod
  category: ExpenseCategory
  beneficiary: string
  tags: string[]
  budget_id?: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ExpenseCreate {
  amount: number
  currency?: string
  date: string
  description: string
  merchant?: string
  payment_method: PaymentMethod
  category: ExpenseCategory
  beneficiary: string
  tags?: string[]
  budget_id?: string | null
}

export interface ExpenseUpdate {
  amount?: number
  currency?: string
  date?: string
  description?: string
  merchant?: string
  payment_method?: PaymentMethod
  category?: ExpenseCategory
  beneficiary?: string
  tags?: string[]
  budget_id?: string | null
}

export interface ExpenseListResponse {
  expenses: Expense[]
  total: number
  page: number
  page_size: number
  has_more: boolean
}

export interface ExpenseSummary {
  total_amount: number
  by_category: Record<string, number>
  by_beneficiary: Record<string, number>
  by_payment_method: Record<string, number>
  expense_count: number
  period_start: string
  period_end: string
}

export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly'

export interface Budget {
  id: string
  family_id: string
  name: string
  amount: number
  period: BudgetPeriod
  category: string | null
  beneficiary: string | null
  start_date: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface BudgetCreate {
  name: string
  amount: number
  period: BudgetPeriod
  category?: string
  beneficiary?: string
  start_date?: string
}

export interface BudgetUpdate {
  name?: string
  amount?: number
  period?: BudgetPeriod
  category?: string
  beneficiary?: string
}

export interface BudgetStatus {
  budget: Budget
  spent: number
  remaining: number
  percentage_used: number
  is_over_budget: boolean
  period_start: string
  period_end: string
}

export interface BudgetListResponse {
  budgets: BudgetStatus[]
  total: number
}

export type NotificationType =
  | 'budget_warning'
  | 'budget_exceeded'
  | 'family_joined'
  | 'expense_added'

export interface Notification {
  id: string
  family_id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  read: boolean
  created_at: string
  related_budget_id: string | null
  related_expense_id: string | null
}

export interface NotificationListResponse {
  notifications: Notification[]
  unread_count: number
  total: number
}

export interface AuthResponse {
  access_token: string
  token_type: string
  user: User
}

// Investments
export interface InvestmentAccount {
  id: string
  name: string
  number?: string
  institution_name?: string
  sync_status?: {
    holdings?: { last_successful_sync?: string | null; initial_sync_completed?: boolean }
    transactions?: { last_successful_sync?: string | null; initial_sync_completed?: boolean }
  }
  cash_restrictions?: unknown
  meta?: Record<string, unknown>
}

export interface HoldingPosition {
  symbol?: { symbol?: { symbol?: string; description?: string } }
  units?: number
  price?: number
  average_purchase_price?: number
  open_pnl?: number
  fractional_units?: number
}

export interface HoldingBalance {
  currency?: { code?: string }
  cash?: number
  buying_power?: number
  total_value?: number
}

export interface HoldingGroup {
  account?: { id?: string; name?: string; institution_name?: string }
  positions?: HoldingPosition[]
  balances?: HoldingBalance[]
}

// Chat
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  family_id?: string
}

// Plaid types — mirrored from frontend/src/types/index.ts
export interface PlaidAccount {
  id: string
  name: string
  mask: string | null
  type: string
  subtype: string | null
  balances: {
    current: number | null
    available: number | null
    iso_currency_code: string | null
  }
}

export interface PlaidItem {
  id: string
  institution_name: string
  status: 'active' | 'needs_reauth' | string
  last_synced_at: string | null
  connected_by_user_id: string
  accounts: PlaidAccount[]
}

export interface PlaidItemsResponse {
  items: PlaidItem[]
}

export interface PendingTransaction {
  id: string
  family_id: string
  connected_by_user_id: string
  plaid_item_id: string
  plaid_transaction_id: string
  account_id: string
  account_name: string
  institution_name: string
  merchant_name: string | null
  name: string | null
  amount: number
  iso_currency_code: string | null
  date: string | null
  authorized_date: string | null
  suggested_category: ExpenseCategory
  plaid_category: string | null
  pending_until_posted: boolean
  is_income?: boolean
  status: 'pending' | 'approved' | 'discarded'
  expense_id: string | null
  suggested_budget_id?: string | null
  created_at: string
  updated_at: string
}

export interface PendingListResponse {
  pending: PendingTransaction[]
  total: number
  page: number
  page_size: number
}

// Category display info
export const CATEGORY_INFO: Record<
  ExpenseCategory,
  { label: string; color: string }
> = {
  groceries: { label: 'Groceries', color: '#16a34a' },
  dining: { label: 'Dining', color: '#ea580c' },
  transportation: { label: 'Transportation', color: '#2563eb' },
  utilities: { label: 'Utilities', color: '#9333ea' },
  entertainment: { label: 'Entertainment', color: '#db2777' },
  healthcare: { label: 'Healthcare', color: '#0d9488' },
  shopping: { label: 'Shopping', color: '#ca8a04' },
  travel: { label: 'Travel', color: '#0891b2' },
  education: { label: 'Education', color: '#4f46e5' },
  other: { label: 'Other', color: '#6b7280' },
}
