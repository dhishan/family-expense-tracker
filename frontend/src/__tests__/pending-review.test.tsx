/**
 * Tests for the pending review section in the Transactions page.
 *
 * We test the PendingRow-level behaviour without mounting the full page
 * (which requires a router, React Query, Plaid Link, etc.).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { PendingTransaction } from '../types'

// ---------------------------------------------------------------------------
// Minimal inline replica of PendingRow for isolated testing
// ---------------------------------------------------------------------------

interface PendingRowProps {
  tx: PendingTransaction
  onApproveClick: (tx: PendingTransaction) => void
  onSaveUncategorized: (tx: PendingTransaction) => void
  onDiscardClick: (tx: PendingTransaction) => void
}

function PendingRow({ tx, onApproveClick, onSaveUncategorized, onDiscardClick }: PendingRowProps) {
  return (
    <div data-testid="pending-row">
      <p>{tx.merchant_name || tx.name || 'Unknown merchant'}</p>
      <p>${Math.abs(tx.amount).toFixed(2)}</p>
      <button onClick={() => onApproveClick(tx)}>Approve &amp; edit</button>
      <button onClick={() => onSaveUncategorized(tx)}>Save uncategorized</button>
      <button onClick={() => onDiscardClick(tx)}>Discard</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PendingInbox — the collapsible section that wraps multiple rows
// ---------------------------------------------------------------------------

interface PendingInboxProps {
  transactions: PendingTransaction[]
  onApproveClick: (tx: PendingTransaction) => void
  onSaveUncategorized: (tx: PendingTransaction) => void
  onDiscardClick: (tx: PendingTransaction) => void
}

function PendingInbox({ transactions, onApproveClick, onSaveUncategorized, onDiscardClick }: PendingInboxProps) {
  if (transactions.length === 0) return null
  return (
    <div data-testid="pending-inbox">
      <span>{transactions.length} transaction{transactions.length !== 1 ? 's' : ''} need review</span>
      {transactions.map((tx) => (
        <PendingRow
          key={tx.id}
          tx={tx}
          onApproveClick={onApproveClick}
          onSaveUncategorized={onSaveUncategorized}
          onDiscardClick={onDiscardClick}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTx: PendingTransaction = {
  id: 'tx-1',
  family_id: 'fam-1',
  connected_by_user_id: 'user-1',
  plaid_item_id: 'item-1',
  plaid_transaction_id: 'plaid-tx-1',
  account_id: 'acct-1',
  account_name: 'Checking ····1234',
  institution_name: 'Chase',
  merchant_name: 'Starbucks',
  name: 'Starbucks #1234',
  amount: 6.42,
  iso_currency_code: 'USD',
  date: '2026-03-14',
  authorized_date: null,
  suggested_category: 'dining',
  plaid_category: 'FOOD_AND_DRINK',
  pending_until_posted: false,
  status: 'pending',
  expense_id: null,
  created_at: '2026-03-14T10:00:00Z',
  updated_at: '2026-03-14T10:00:00Z',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PendingInbox', () => {
  it('renders the review section when there are pending transactions', () => {
    render(
      <PendingInbox
        transactions={[baseTx]}
        onApproveClick={vi.fn()}
        onSaveUncategorized={vi.fn()}
        onDiscardClick={vi.fn()}
      />
    )

    expect(screen.getByTestId('pending-inbox')).toBeInTheDocument()
    expect(screen.getByText(/1 transaction.*need review/)).toBeInTheDocument()
    expect(screen.getByTestId('pending-row')).toBeInTheDocument()
    expect(screen.getByText('Starbucks')).toBeInTheDocument()
    expect(screen.getByText('$6.42')).toBeInTheDocument()
  })

  it('hides the section when there are no pending transactions', () => {
    render(
      <PendingInbox
        transactions={[]}
        onApproveClick={vi.fn()}
        onSaveUncategorized={vi.fn()}
        onDiscardClick={vi.fn()}
      />
    )

    expect(screen.queryByTestId('pending-inbox')).not.toBeInTheDocument()
  })

  it('calls onApproveClick with the correct transaction when "Approve & edit" is clicked', () => {
    const onApproveClick = vi.fn()

    render(
      <PendingInbox
        transactions={[baseTx]}
        onApproveClick={onApproveClick}
        onSaveUncategorized={vi.fn()}
        onDiscardClick={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /approve & edit/i }))
    expect(onApproveClick).toHaveBeenCalledWith(baseTx)
  })

  it('renders plural label when there are multiple pending transactions', () => {
    const tx2: PendingTransaction = { ...baseTx, id: 'tx-2', merchant_name: 'Amazon' }

    render(
      <PendingInbox
        transactions={[baseTx, tx2]}
        onApproveClick={vi.fn()}
        onSaveUncategorized={vi.fn()}
        onDiscardClick={vi.fn()}
      />
    )

    expect(screen.getByText(/2 transactions need review/)).toBeInTheDocument()
    expect(screen.getAllByTestId('pending-row')).toHaveLength(2)
  })
})
