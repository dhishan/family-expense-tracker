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
