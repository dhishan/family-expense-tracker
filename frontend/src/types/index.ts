// User types
export interface User {
  id: string
  email: string
  display_name: string
  photo_url: string | null
  family_id: string | null
  created_at: string
  updated_at: string
}

// Family types
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

// Expense types
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

// Budget types
export type BudgetPeriod = 'weekly' | 'monthly'

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

// Notification types
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

// Auth types
export interface AuthResponse {
  access_token: string
  token_type: string
  user: User
}

// Category display info
export const CATEGORY_INFO: Record<
  ExpenseCategory,
  { label: string; color: string; bgColor: string }
> = {
  groceries: { label: 'Groceries', color: 'text-green-600', bgColor: 'bg-green-100' },
  dining: { label: 'Dining', color: 'text-orange-600', bgColor: 'bg-orange-100' },
  transportation: { label: 'Transportation', color: 'text-blue-600', bgColor: 'bg-blue-100' },
  utilities: { label: 'Utilities', color: 'text-purple-600', bgColor: 'bg-purple-100' },
  entertainment: { label: 'Entertainment', color: 'text-pink-600', bgColor: 'bg-pink-100' },
  healthcare: { label: 'Healthcare', color: 'text-teal-600', bgColor: 'bg-teal-100' },
  shopping: { label: 'Shopping', color: 'text-yellow-600', bgColor: 'bg-yellow-100' },
  travel: { label: 'Travel', color: 'text-cyan-600', bgColor: 'bg-cyan-100' },
  education: { label: 'Education', color: 'text-indigo-600', bgColor: 'bg-indigo-100' },
  other: { label: 'Other', color: 'text-gray-600', bgColor: 'bg-gray-100' },
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  credit: 'Credit Card',
  debit: 'Debit Card',
  bank_transfer: 'Bank Transfer',
  paypal: 'PayPal',
  venmo: 'Venmo',
  other: 'Other',
}
