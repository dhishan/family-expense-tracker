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
