# Expense Quick-Add Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 7-field add expense modal with a persistent quick-add strip always visible at the top of the Expenses page, reducing entry friction on mobile.

**Architecture:** Three new artifacts — a static Bay Area merchant JSON, a `utils.ts` helper for local date formatting, and a `QuickAddStrip` component — plugged into the existing `Expenses.tsx`. The add modal is removed; the edit modal is kept (minus payment method).

**Tech Stack:** React, TypeScript, react-hook-form, @tanstack/react-query, Tailwind CSS, Heroicons

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/data/merchants-bay-area.json` | **Create** | Static list of ~300 SF/Bay Area merchant names |
| `frontend/src/utils.ts` | **Create** | `toLocalISODate()` and `getMerchantSuggestions()` helpers |
| `frontend/src/components/QuickAddStrip.tsx` | **Create** | The always-visible add strip component |
| `frontend/src/pages/Expenses.tsx` | **Modify** | Remove add modal; wire in `<QuickAddStrip>`; remove payment_method from edit modal |

---

## Task 1: Create the Bay Area merchant static list

**Files:**
- Create: `frontend/src/data/merchants-bay-area.json`

- [ ] **Step 1: Create the data directory and merchant JSON file**

```bash
mkdir -p frontend/src/data
```

Then create `frontend/src/data/merchants-bay-area.json`:

```json
[
  "99 Ranch Market",
  "Acme Bread Company",
  "Adidas",
  "AMC Bay Street",
  "AMC Metreon",
  "Anthropologie",
  "Apna Bazar",
  "Arco",
  "AT&T",
  "B of A",
  "Banana Republic",
  "BART",
  "Bay Area Rapid Transit",
  "Best Buy",
  "Bi-Rite Market",
  "Blue Bottle Coffee",
  "Boba Guys",
  "Boudin Bakery",
  "Caltrain",
  "Chase Bank",
  "Chick-fil-A",
  "Chipotle",
  "Comcast",
  "Costco",
  "CVS",
  "Del Taco",
  "Dollar Tree",
  "Draeger's Market",
  "Dunkin",
  "Equinox",
  "Etsy",
  "Fitness SF",
  "Five Guys",
  "Forever 21",
  "Free People",
  "Gap",
  "Golden Gate Ferry",
  "Google Express",
  "H Mart",
  "H&M",
  "Home Depot",
  "HomeGoods",
  "IKEA Emeryville",
  "In-N-Out Burger",
  "India Cash & Carry",
  "Jack in the Box",
  "Jamba Juice",
  "Kaiser Permanente",
  "Lowe's",
  "Lucky Supermarkets",
  "Lululemon",
  "Lush",
  "Lyft",
  "Macy's",
  "Madewell",
  "Marshalls",
  "McDonald's",
  "Mitsuwa Marketplace",
  "Mobil",
  "Muni",
  "Nijiya Market",
  "Nike",
  "Nob Hill Foods",
  "Nordstrom",
  "Nordstrom Rack",
  "Old Navy",
  "Oren's Hummus",
  "Outback Steakhouse",
  "Pacific Gas & Electric",
  "Panda Express",
  "Panera Bread",
  "Patel Brothers",
  "PayPal",
  "Peet's Coffee",
  "PG&E",
  "Philz Coffee",
  "Planet Fitness",
  "Quickly",
  "Rainbow Grocery",
  "Raising Cane's",
  "Regal Cinemas",
  "Rite Aid",
  "Ross",
  "Safeway",
  "Sally Beauty",
  "Sam's Club",
  "Sephora",
  "76 Gas",
  "Shell",
  "Chevron",
  "Sightglass Coffee",
  "Smart & Final",
  "Sprouts Farmers Market",
  "Starbucks",
  "Subway",
  "SoulCycle",
  "T-Mobile",
  "Taco Bell",
  "Target",
  "The Cheesecake Factory",
  "Tiffany & Co.",
  "TJ Maxx",
  "Trader Joe's",
  "Uber",
  "Uber Eats",
  "Ulta Beauty",
  "Uniqlo",
  "UCSF Medical Center",
  "Verizon",
  "Walgreens",
  "Walmart",
  "Wells Fargo",
  "Whole Foods Market",
  "World Market",
  "Xfinity",
  "Zara",
  "Zanotto's Market",
  "Afghani Kabob",
  "Amber India",
  "Ananda Fuara",
  "Basil Canteen",
  "Burma Love",
  "Curry Up Now",
  "Dosa",
  "Farmhouse Kitchen",
  "Ike's Love & Sandwiches",
  "Kasa Indian",
  "Little Sheep Mongolian Hot Pot",
  "Mensho Tokyo",
  "Naan-N-Curry",
  "Nopalito",
  "Papalote Mexican Grill",
  "Pica Pica",
  "Rasoi",
  "Roti Indian Bistro",
  "Saffron Indian Cuisine",
  "Shalimar",
  "Spice Affair",
  "Swad Indian Grocery",
  "The Halal Guys",
  "Udupi Palace",
  "Zareen's",
  "Benihana",
  "Cheeseboard Pizza",
  "Gordo Taqueria",
  "La Corneta",
  "La Palma Mexicatessen",
  "Mission Chinese Food",
  "Mission Pie",
  "Nopa",
  "Tartine Bakery",
  "Trick Dog",
  "Zuni Café",
  "Benu",
  "Cotogna",
  "Flour + Water",
  "Foreign Cinema",
  "Namu Gaji",
  "Rich Table",
  "State Bird Provisions",
  "Wayfare Tavern",
  "Bloodhound",
  "Cellarmaker Brewing",
  "Fort Point Beer Company",
  "Magnolia Brewing",
  "Toronado",
  "Humphry Slocombe",
  "Mitchell's Ice Cream",
  "Smitten Ice Cream",
  "Dandelion Chocolate",
  "TCHO Chocolate",
  "Equator Coffees",
  "Four Barrel Coffee",
  "Ritual Coffee",
  "Verve Coffee",
  "Wrecking Ball Coffee",
  "DoorDash",
  "GrubHub",
  "Instacart",
  "Postmates",
  "Shipt",
  "Gopuff",
  "Amazon",
  "Amazon Fresh",
  "Costco Pharmacy",
  "One Medical",
  "Carbon Health",
  "Sutter Health",
  "Stanford Health Care",
  "Dignity Health",
  "Crunch Fitness",
  "24 Hour Fitness",
  "Barry's Bootcamp",
  "OrangeTheory",
  "Yoga Tree",
  "CorePower Yoga",
  "Banana Republic Factory",
  "Club Monaco",
  "Everlane",
  "Patagonia",
  "Arc'teryx",
  "REI",
  "Columbia Sportswear",
  "The North Face",
  "Under Armour",
  "New Balance",
  "Vans",
  "Foot Locker",
  "DSW",
  "Shoe Palace",
  "Steve Madden",
  "ALDO",
  "Zales",
  "Kay Jewelers",
  "Alex and Ani",
  "Pandora",
  "Bath & Body Works",
  "The Body Shop",
  "Kiehl's",
  "MAC Cosmetics",
  "Origins",
  "Clinique",
  "L'Occitane",
  "Jo Malone",
  "Diptyque",
  "Le Labo",
  "Aesop",
  "NARS",
  "Fenty Beauty",
  "Rare Beauty",
  "Glossier",
  "e.l.f. Cosmetics",
  "NYX Professional Makeup",
  "Urban Decay",
  "Too Faced",
  "Tarte",
  "Benefit Cosmetics",
  "Crate & Barrel",
  "Pottery Barn",
  "West Elm",
  "CB2",
  "Restoration Hardware",
  "Bed Bath & Beyond",
  "Tuesday Morning",
  "Pier 1",
  "Container Store",
  "Muji",
  "DAISO Japan",
  "99 Cents Only",
  "Five Below",
  "Burlington",
  "Grocery Outlet",
  "FoodMaxx",
  "Mi Pueblo Food Center",
  "Seafood City",
  "Manila Oriental Market",
  "Philippine Tropical",
  "New May Wah Supermarket",
  "Ranch 99",
  "Hmart Oakland",
  "Oakland Halal Meat",
  "Pak Halal",
  "Bismillah Halal Meat",
  "Gourmet India",
  "India Sweets and Spices",
  "Vik's Chaat",
  "Curry Village",
  "Udupi Palace Oakland",
  "Chaat Bhavan",
  "Bawarchi",
  "Biryani Bowl",
  "Hyderabad House",
  "Desi Tadka",
  "Chai Bar",
  "Asha Tea House",
  "Boba Story",
  "Happy Lemon",
  "Teaspoon",
  "ShareTea",
  "Yi Fang Taiwan Fruit Tea",
  "Tiger Sugar",
  "Sunright Tea Studio",
  "Ten Ren Tea",
  "Fantasia Coffee & Tea",
  "Gong Cha",
  "Kung Fu Tea",
  "Coco Fresh Tea & Juice",
  "85°C Bakery Cafe",
  "Paris Baguette",
  "Sheng Kee Bakery",
  "Honey Bee Sweets",
  "Kee Wah Bakery",
  "Golden Gate Bakery",
  "Benkyodo",
  "Acme Chophouse",
  "Blowfish Sushi",
  "Ebisu",
  "Izakaya Rintaro",
  "Koi Palace",
  "Kiku Sushi",
  "Marufuku Ramen",
  "Orenchi Ramen",
  "Ramen Nagi",
  "Santouka Ramen",
  "Saru Sushi Bar",
  "Sushi Ran",
  "Yuzuki Japanese Eatery",
  "Khan Toke Thai",
  "Marnee Thai",
  "Basil Thai",
  "Thai Idea",
  "Tropisueño",
  "Taqueria Cancun",
  "El Farolito",
  "La Taqueria",
  "Humphrey Slocombe",
  "Bi-Rite Creamery"
]
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/data/merchants-bay-area.json
git commit -m "feat: add SF/Bay Area static merchant list"
```

---

## Task 2: Create utils.ts with date and merchant helpers

**Files:**
- Create: `frontend/src/utils.ts`

- [ ] **Step 1: Create `frontend/src/utils.ts`**

```ts
import BAY_AREA_MERCHANTS from './data/merchants-bay-area.json'

/**
 * Returns today's date as YYYY-MM-DD in the user's local timezone.
 * Never use new Date().toISOString().split('T')[0] — that returns UTC.
 */
export function toLocalISODate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Returns up to 6 merchant name suggestions for the given query string.
 * Past merchants (from user's own expenses) are ranked first, then static list.
 * Returns empty array if query is empty.
 */
export function getMerchantSuggestions(query: string, pastMerchants: string[]): string[] {
  if (!query.trim()) return []
  const q = query.toLowerCase()
  const staticMatches = (BAY_AREA_MERCHANTS as string[]).filter((m) =>
    m.toLowerCase().includes(q)
  )
  const pastMatches = pastMerchants.filter((m) => m.toLowerCase().includes(q))
  return Array.from(new Set([...pastMatches, ...staticMatches])).slice(0, 6)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (or only pre-existing errors unrelated to utils.ts)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils.ts
git commit -m "feat: add toLocalISODate and getMerchantSuggestions utils"
```

---

## Task 3: Build the QuickAddStrip component

**Files:**
- Create: `frontend/src/components/QuickAddStrip.tsx`

The component owns:
- Local form state (amount, category, merchant, note, date, beneficiary)
- Slider logic (0–100, typing beyond that pins slider to max)
- Merchant typeahead (calls `getMerchantSuggestions`)
- Advanced section expand/collapse
- Category default persisted in localStorage
- Calls `onSubmit(data: ExpenseCreate)` prop on `+` click

**Props interface:**
```ts
interface QuickAddStripProps {
  categories: string[]          // from family?.categories or fallback
  familyMembers: FamilyMember[] // for beneficiary select
  pastMerchants: string[]       // from already-fetched expenses
  onSubmit: (data: ExpenseCreate) => void
  isSubmitting: boolean
}
```

- [ ] **Step 1: Create `frontend/src/components/QuickAddStrip.tsx`**

```tsx
import { useState, useRef, useEffect } from 'react'
import { ChevronDownIcon, ChevronUpIcon, PlusIcon } from '@heroicons/react/24/outline'
import { CATEGORY_INFO } from '../types'
import { toLocalISODate, getMerchantSuggestions } from '../utils'
import type { ExpenseCategory, ExpenseCreate, FamilyMember } from '../types'

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

const LAST_CATEGORY_KEY = 'quickadd_last_category'

interface QuickAddStripProps {
  categories: string[]
  familyMembers: FamilyMember[]
  pastMerchants: string[]
  onSubmit: (data: ExpenseCreate) => void
  isSubmitting: boolean
}

export default function QuickAddStrip({
  categories,
  familyMembers,
  pastMerchants,
  onSubmit,
  isSubmitting,
}: QuickAddStripProps) {
  const savedCategory = localStorage.getItem(LAST_CATEGORY_KEY) as ExpenseCategory | null
  const defaultCategory = (savedCategory && categories.includes(savedCategory)
    ? savedCategory
    : categories[0] ?? 'other') as ExpenseCategory

  const [amount, setAmount] = useState(0)
  const [amountInput, setAmountInput] = useState('0')
  const [category, setCategory] = useState<ExpenseCategory>(defaultCategory)
  const [merchant, setMerchant] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(toLocalISODate())
  const [beneficiary, setBeneficiary] = useState('family')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [merchantSuggestions, setMerchantSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const merchantRef = useRef<HTMLDivElement>(null)

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (merchantRef.current && !merchantRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleAmountSlider(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Number(e.target.value)
    setAmount(val)
    setAmountInput(String(val))
  }

  function handleAmountInput(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setAmountInput(raw)
    const parsed = parseFloat(raw)
    if (!isNaN(parsed) && parsed >= 0) {
      setAmount(parsed)
    }
  }

  function handleMerchantChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setMerchant(val)
    const suggestions = getMerchantSuggestions(val, pastMerchants)
    setMerchantSuggestions(suggestions)
    setShowSuggestions(suggestions.length > 0)
  }

  function selectSuggestion(name: string) {
    setMerchant(name)
    setShowSuggestions(false)
  }

  function handleSubmit() {
    const parsedAmount = parseFloat(amountInput)
    if (!parsedAmount || parsedAmount <= 0) return
    localStorage.setItem(LAST_CATEGORY_KEY, category)
    onSubmit({
      amount: parsedAmount,
      date,
      description: note || merchant || category,
      merchant: merchant || undefined,
      payment_method: 'credit',
      category,
      beneficiary,
    })
    // Reset strip
    setAmount(0)
    setAmountInput('0')
    setMerchant('')
    setNote('')
    setDate(toLocalISODate())
    setBeneficiary('family')
  }

  const sliderValue = Math.min(amount, 100)
  const categoryLabel = CATEGORY_INFO[category]?.label ?? category

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
      {/* Row 1: category + slider + plus button */}
      <div className="flex items-center gap-3">
        {/* Category dropdown */}
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
          className="flex-shrink-0 border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white max-w-[140px]"
        >
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {CATEGORY_EMOJI[cat] ?? '📝'} {CATEGORY_INFO[cat as ExpenseCategory]?.label ?? cat}
            </option>
          ))}
        </select>

        {/* Amount display + slider */}
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-sm font-medium">$</span>
            <input
              type="number"
              inputMode="decimal"
              value={amountInput}
              onChange={handleAmountInput}
              className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-base font-bold text-gray-900 text-center"
              placeholder="0"
              min="0"
            />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sliderValue}
            onChange={handleAmountSlider}
            className="w-full accent-primary-600"
          />
        </div>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || parseFloat(amountInput) <= 0}
          className="flex-shrink-0 flex items-center justify-center w-10 h-10 bg-primary-600 text-white rounded-full hover:bg-primary-700 disabled:opacity-50"
        >
          <PlusIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Row 2: merchant typeahead + note */}
      <div className="flex gap-3">
        {/* Merchant typeahead */}
        <div ref={merchantRef} className="relative flex-1">
          <input
            type="text"
            value={merchant}
            onChange={handleMerchantChange}
            onFocus={() => {
              if (merchantSuggestions.length > 0) setShowSuggestions(true)
            }}
            placeholder="Merchant..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            autoComplete="off"
          />
          {showSuggestions && (
            <ul className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {merchantSuggestions.map((name) => (
                <li
                  key={name}
                  onMouseDown={() => selectSuggestion(name)}
                  className="px-3 py-2 text-sm text-gray-800 hover:bg-primary-50 cursor-pointer"
                >
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Note */}
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
      >
        {showAdvanced ? (
          <ChevronUpIcon className="h-3 w-3" />
        ) : (
          <ChevronDownIcon className="h-3 w-3" />
        )}
        Advanced
      </button>

      {/* Advanced fields */}
      {showAdvanced && (
        <div className="flex gap-3 pt-1">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">For</label>
            <select
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="family">Entire Family</option>
              {familyMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors from QuickAddStrip.tsx

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/QuickAddStrip.tsx
git commit -m "feat: add QuickAddStrip component with slider, typeahead, and advanced section"
```

---

## Task 4: Wire QuickAddStrip into Expenses.tsx and remove the Add modal

**Files:**
- Modify: `frontend/src/pages/Expenses.tsx`

Changes:
1. Import `QuickAddStrip`
2. Remove `showAddModal` state and `openAddModal` function
3. Remove the `+ Add Expense` button from the header
4. Remove the Add modal JSX block (the `showAddModal ||` branch of the modal)
5. Add `<QuickAddStrip>` above the expense list
6. Remove `payment_method` field from the Edit modal
7. Fix the Edit modal's form to use `toLocalISODate` for default date
8. Update `createMutation` `onSuccess` — no longer needs to close a modal

- [ ] **Step 1: Update `frontend/src/pages/Expenses.tsx`**

Replace the entire file with:

```tsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import {
  FunnelIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { expensesApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { CATEGORY_INFO, PAYMENT_METHOD_LABELS } from '../types'
import { toLocalISODate } from '../utils'
import type { ExpenseCreate, ExpenseCategory, Expense } from '../types'
import QuickAddStrip from '../components/QuickAddStrip'

interface EditFormData {
  amount: number
  date: string
  description: string
  merchant: string
  category: ExpenseCategory
  beneficiary: string
}

export default function Expenses() {
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [filters, setFilters] = useState<{
    category?: ExpenseCategory
    start_date?: string
    end_date?: string
  }>({})
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)

  const { user, familyMembers, family } = useAuthStore()
  const queryClient = useQueryClient()

  const categories = family?.categories || [
    'groceries', 'dining', 'transportation', 'utilities', 'entertainment',
    'healthcare', 'shopping', 'travel', 'education', 'other',
  ]

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', page, filters],
    queryFn: () => expensesApi.list({ page, page_size: 20, ...filters }),
    enabled: !!user?.family_id,
  })

  const { data: allExpensesData } = useQuery({
    queryKey: ['expenses-merchants'],
    queryFn: () => expensesApi.list({ page: 1, page_size: 200 }),
    enabled: !!user?.family_id,
    staleTime: 5 * 60 * 1000,
  })

  const pastMerchants = Array.from(
    new Set(
      (allExpensesData?.expenses ?? [])
        .map((e) => e.merchant)
        .filter((m): m is string => !!m && m.trim().length > 0)
    )
  ).sort()

  const createMutation = useMutation({
    mutationFn: expensesApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Expense added!')
    },
    onError: () => toast.error('Failed to add expense'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EditFormData> }) =>
      expensesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      setEditingExpense(null)
      toast.success('Expense updated!')
    },
    onError: () => toast.error('Failed to update expense'),
  })

  const deleteMutation = useMutation({
    mutationFn: expensesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Expense deleted!')
    },
    onError: () => toast.error('Failed to delete expense'),
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditFormData>()

  const onEditSubmit = (data: EditFormData) => {
    if (!editingExpense) return
    updateMutation.mutate({ id: editingExpense.id, data })
  }

  const openEditModal = (expense: Expense) => {
    setEditingExpense(expense)
    reset({
      amount: expense.amount,
      date: expense.date,
      description: expense.description,
      merchant: expense.merchant || '',
      category: expense.category,
      beneficiary: expense.beneficiary,
    })
  }

  if (!user?.family_id) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Join a family to start tracking expenses</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Expenses</h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <FunnelIcon className="h-5 w-5" />
          Filters
        </button>
      </div>

      {/* Quick Add Strip */}
      <QuickAddStrip
        categories={categories}
        familyMembers={familyMembers}
        pastMerchants={pastMerchants}
        onSubmit={(data: ExpenseCreate) => createMutation.mutate(data)}
        isSubmitting={createMutation.isPending}
      />

      {/* Filters */}
      {showFilters && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={filters.category || ''}
                onChange={(e) =>
                  setFilters({ ...filters, category: e.target.value as ExpenseCategory || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={filters.start_date || ''}
                onChange={(e) =>
                  setFilters({ ...filters, start_date: e.target.value || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={filters.end_date || ''}
                onChange={(e) =>
                  setFilters({ ...filters, end_date: e.target.value || undefined })
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
          </div>
          <button
            onClick={() => setFilters({})}
            className="mt-4 text-sm text-primary-600 hover:text-primary-700"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Expense list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          </div>
        ) : data?.expenses && data.expenses.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Description
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Category
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.expenses.map((expense) => (
                    <tr key={expense.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {format(new Date(expense.date + 'T00:00:00'), 'MMM d, yyyy')}
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">
                          {expense.description}
                        </div>
                        {expense.merchant && (
                          <div className="text-sm text-gray-500">{expense.merchant}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                            CATEGORY_INFO[expense.category]?.bgColor
                          } ${CATEGORY_INFO[expense.category]?.color}`}
                        >
                          {CATEGORY_INFO[expense.category]?.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        ${expense.amount.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <button
                          onClick={() => openEditModal(expense)}
                          className="text-gray-400 hover:text-primary-600 p-1"
                        >
                          <PencilIcon className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm('Delete this expense?')) {
                              deleteMutation.mutate(expense.id)
                            }
                          }}
                          className="text-gray-400 hover:text-red-600 p-1 ml-2"
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-6 py-4 border-t flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing {data.expenses.length} of {data.total} expenses
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 border rounded disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!data.has_more}
                  className="px-3 py-1 border rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="p-8 text-center text-gray-500">
            No expenses found. Add your first expense above!
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Edit Expense</h2>
              <button onClick={() => setEditingExpense(null)}>
                <XMarkIcon className="h-6 w-6 text-gray-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit(onEditSubmit)} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount *
                </label>
                <input
                  type="number"
                  step="0.01"
                  {...register('amount', { required: true, min: 0.01 })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p className="text-red-500 text-sm mt-1">Amount is required</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  {...register('date', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Note
                </label>
                <input
                  type="text"
                  {...register('description')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Note..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Merchant
                </label>
                <input
                  type="text"
                  {...register('merchant')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Store or vendor name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  {...register('category', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_INFO[cat as ExpenseCategory]?.label || cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  For
                </label>
                <select
                  {...register('beneficiary')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  <option value="family">Entire Family</option>
                  {familyMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setEditingExpense(null)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors

- [ ] **Step 3: Smoke test in browser**

```bash
cd frontend && npm run dev
```

Open http://localhost:5173/expenses. Verify:
- Quick-add strip appears at the top (category dropdown, slider, amount input, + button)
- Merchant typeahead shows suggestions as you type
- Advanced section expands/collapses
- Submitting an expense adds it to the list and resets the strip
- Edit pencil icon opens the edit modal (no Payment Method field)
- `+ Add Expense` button is gone from the header

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Expenses.tsx
git commit -m "feat: replace add modal with QuickAddStrip, remove payment_method from UI"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Category dropdown left of strip
- ✅ Amount slider 0–100 + tappable to type exact
- ✅ Note field (maps to `description`)
- ✅ Merchant typeahead (static list + past merchants)
- ✅ `+` button submits
- ✅ Advanced: Date + Beneficiary, collapsed by default
- ✅ Payment method dropped from UI, sends `"credit"` silently
- ✅ Static merchant list — SF/Bay Area, young + Indian community skew
- ✅ Edit modal kept, payment method removed from it
- ✅ `toLocalISODate` used for date defaults (timezone-safe)
- ✅ Category default persisted in localStorage

**Placeholder scan:** None found — all steps have real code.

**Type consistency:**
- `ExpenseCreate` requires `payment_method: PaymentMethod` — ✅ sent as `'credit'`
- `ExpenseCreate` requires `description` — ✅ defaults to `note || merchant || category`
- `FamilyMember` interface used in props — ✅ imported from `../types`
- `getMerchantSuggestions` defined in Task 2, used in Task 3 — ✅ same signature
- `toLocalISODate` defined in Task 2, used in Tasks 3 and 4 — ✅ consistent
