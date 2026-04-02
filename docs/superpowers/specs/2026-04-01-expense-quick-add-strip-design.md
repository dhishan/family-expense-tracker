# Expense Quick-Add Strip — Design Spec
_Date: 2026-04-01_

## Overview

Replace the current 7-field modal with a persistent quick-add strip at the top of the Expenses page. The strip is always visible — no tap to open a modal, no scrolling through fields. Designed for fast one-handed mobile entry.

---

## What Changes

### Dropped entirely
- **Payment method** — nobody cares at entry time

### Merged
- **Description + Note** → single **Note** field (optional, short label)

### Demoted to Advanced (collapsed by default)
- **Date** — defaults to today's local date
- **Beneficiary** — defaults to "family"

### Primary fields (always visible in strip)
1. **Category** — dropdown on the left of the strip
2. **Amount** — slider (0–100) + tappable display to type exact value
3. **Note** — optional short text field
4. **Merchant** — typeahead input (not a dropdown)
5. **+** button — submits the expense

---

## UI: Quick-Add Strip

```
┌─────────────────────────────────────────────────────────┐
│ [🛒 Groceries ▾]   [$42 ══●════════]   [Note...]  [+] │
│                     Merchant: [Trader Joe's...        ] │
│                     ▼ Advanced                          │
└─────────────────────────────────────────────────────────┘
```

- Strip lives above the expense list, below the page header
- Always rendered — not behind a button or modal
- On mobile, the strip is compact (~2 rows): category + amount + `+` on row 1, merchant + note on row 2
- **Advanced** chevron below expands to show Date and Beneficiary

### Amount Slider
- Range: **$0–$100**, draggable
- The amount value is displayed as a large tappable number
- Tapping the number opens a numeric keyboard for exact entry (no upper limit)
- Slider position snaps to reflect typed values over $100 by pinning to the right end
- Default: $0 (or last-used amount cleared on submit)

### Category Dropdown
- Shows category emoji + label (e.g. "🛒 Groceries")
- Uses the family's configured category list
- Default: last-used category (persisted in localStorage)

### Merchant Typeahead
- As the user types, suggestions appear from two sources merged:
  1. **Static SF/Bay Area merchant list** (~300 names, bundled as JSON)
  2. **User's past merchants** from Firestore (already fetched for the page)
- No dropdown shown until typing starts
- Max 6 suggestions shown at once
- Optional — can be left blank

### Note Field
- Single short text input, optional
- Placeholder: "Note..."
- Maps to `description` in the backend schema (field renamed in frontend only)

### Advanced Section
- Collapsed by default, chevron to expand
- **Date**: date picker, defaults to today's local date (`toLocalISODate()`)
- **Beneficiary**: select — "Entire Family" or individual member name

---

## Merchant Data

### Static list
- **~300 merchants** targeting SF and Bay Area
- Categories covered: grocery, dining (fast food + sit-down), gas stations, pharmacies, utilities, transit, entertainment, shopping, healthcare
- **Skew toward young crowd + Indian community** in the Bay Area
- Key merchants: Safeway, Trader Joe's, Whole Foods, Rainbow Grocery, Bi-Rite, 99 Ranch Market, India Cash & Carry, Apna Bazar, Patel Brothers, In-N-Out, Chipotle, Philz Coffee, Blue Bottle, Sightglass, Starbucks, Boba Guys, Quickly, Chevron, Walgreens, CVS, BART, Muni, Caltrain, Lyft, Uber, Target, Costco, IKEA Emeryville, AMC Bay Street, Regal, H Mart, Mitsuwa, Nijiya Market, etc.
- Stored as: `frontend/src/data/merchants-bay-area.json` — array of strings
- Bundle size estimate: ~6–8 KB

### Merge logic (frontend)
```ts
function getMerchantSuggestions(query: string, pastMerchants: string[]): string[] {
  const q = query.toLowerCase()
  const staticMatches = BAY_AREA_MERCHANTS.filter(m => m.toLowerCase().includes(q))
  const pastMatches = pastMerchants.filter(m => m.toLowerCase().includes(q))
  // past merchants first (more relevant), then static, deduplicated
  return Array.from(new Set([...pastMatches, ...staticMatches])).slice(0, 6)
}
```

---

## Backend / DB Changes

### Schema impact
- **No new Firestore fields needed** — `description` field already exists, `merchant` already exists
- `payment_method` field: **keep in DB** (existing data has it), just stop collecting it in the UI — backend defaults it to `"other"` if omitted or frontend sends `"other"` always
- No migration needed

---

## What Happens to the Old Modal

- The full 7-field modal is **removed** from Add flow
- **Edit flow keeps the modal** — editing an existing expense still needs all fields accessible (merchant, date, beneficiary, note, category, amount)
- The edit modal can drop payment method from its form too

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/pages/Expenses.tsx` | Replace add modal with QuickAddStrip component; keep edit modal |
| `frontend/src/components/QuickAddStrip.tsx` | New component |
| `frontend/src/data/merchants-bay-area.json` | New static merchant list |
| `frontend/src/types.ts` | No changes needed |

---

## Out of Scope

- Location-aware merchant suggestions (Google Places) — future enhancement
- Splitting an expense across members
- Recurring expenses
- Receipt scanning
