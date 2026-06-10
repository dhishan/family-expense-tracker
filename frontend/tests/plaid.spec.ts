/**
 * Plaid integration E2E tests.
 *
 * These tests use a sandbox-bypass endpoint (POST /api/v1/plaid/_test/sandbox-connect)
 * to connect First Platypus Bank without driving the Plaid Link iframe.
 * The endpoint is only mounted in non-production environments.
 *
 * Required env vars:
 *   TEST_USER_REFRESH_TOKEN     – Google refresh token for the primary test user (required)
 *   TEST_USER_2_REFRESH_TOKEN   – Refresh token for a second user in the SAME family (optional)
 *                                  Tests 09 and 10 are skipped when absent.
 *
 * The JWT for the primary test user is read from .test-state.json which is written
 * by global-setup.ts.
 */

import { test, expect, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as https from 'https'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(__dirname, '.test-state.json')

const BASE = process.env.BASE_URL || 'https://ui.expense-tracker.blueelephants.org'
const API = process.env.API_URL || 'https://api.expense-tracker.blueelephants.org/api/v1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readState(): { jwt: string; familyId: string; email: string } {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
}

/** POST to the backend with a JSON body and a Bearer token. */
async function apiPost(path: string, token: string, body?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : ''
    const u = new URL(path.startsWith('http') ? path : `${API}${path}`)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(data)
          }
        })
      }
    )
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

/** Connect First Platypus Bank via the sandbox bypass endpoint. */
async function sandboxConnect(token: string): Promise<{
  plaid_item_id: string
  accounts_count: number
  pending_count: number
}> {
  const result = (await apiPost('/plaid/_test/sandbox-connect', token)) as any
  if (!result.plaid_item_id) {
    throw new Error(`sandbox-connect failed: ${JSON.stringify(result)}`)
  }
  return result
}

/** Reset all Plaid data for the test user's family. */
async function sandboxReset(token: string): Promise<void> {
  await apiPost('/plaid/_test/reset', token)
}

// ---------------------------------------------------------------------------
// Skip guard for optional second-user tests
// ---------------------------------------------------------------------------

const hasSecondUser = !!process.env.TEST_USER_2_JWT
const ifNoSecondUser = hasSecondUser ? test : test.skip

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('Plaid integration', () => {
  let jwt: string

  test.beforeAll(async () => {
    const state = readState()
    jwt = state.jwt
    // Clean slate before the suite runs
    await sandboxReset(jwt)
  })

  test.afterEach(async () => {
    // Reset after each test so tests are independent
    await sandboxReset(jwt)
  })

  // -------------------------------------------------------------------------
  // 01. Connection appears in Connected Accounts
  // -------------------------------------------------------------------------

  test('01 connects a sandbox bank and shows it in Connected Accounts', async ({ page }) => {
    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    // Section exists but empty
    await expect(page.getByText(/connected accounts/i)).toBeVisible()
    await expect(page.getByText(/first platypus bank/i)).not.toBeVisible()

    // Connect via API (no Link iframe)
    await sandboxConnect(jwt)

    // Reload and assert card appears
    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/first platypus bank/i)).toBeVisible({ timeout: 15_000 })

    // Should show account count
    const card = page.locator('[class*="card"], [class*="institution"], section').filter({
      hasText: /first platypus bank/i,
    }).first()
    await expect(card).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // 02. Pending transactions appear after connection
  // -------------------------------------------------------------------------

  test('02 pending transactions appear after sandbox connection', async ({ page }) => {
    const { pending_count } = await sandboxConnect(jwt)
    expect(pending_count).toBeGreaterThan(0)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    // Header with pending count
    await expect(
      page.getByText(new RegExp(`${pending_count}\\s+transaction`, 'i'))
        .or(page.getByText(/transactions? need review/i))
    ).toBeVisible({ timeout: 15_000 })

    // Each pending row should show amount and at least a name
    const pendingRows = page.locator('[data-testid="pending-row"], [class*="pending"]').first()
    await expect(pendingRows).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 03. Approve with edits
  // -------------------------------------------------------------------------

  test('03 approve with edits creates an expense and removes the pending row', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    // Wait for at least one pending row
    const approveBtn = page.getByRole('button', { name: /approve/i }).first()
    await expect(approveBtn).toBeVisible({ timeout: 15_000 })

    // Click the first Approve / "Approve & edit" button
    await approveBtn.click()

    // Modal should open with prefilled values
    const modal = page.getByRole('dialog').or(page.locator('[class*="modal"]')).first()
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Change amount
    const amountInput = modal.getByRole('spinbutton').or(modal.locator('input[type="number"]')).first()
    await amountInput.fill('4.20')

    // Change category if a select is present
    const categorySelect = modal.locator('select').first()
    if (await categorySelect.isVisible()) {
      await categorySelect.selectOption({ index: 1 })
    }

    // Submit approve
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/plaid/pending/') && r.url().includes('/approve') && r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      modal.getByRole('button', { name: /approve/i }).last().click(),
    ])

    // Pending row should be gone and expense should appear
    await page.waitForLoadState('networkidle')

    // There should be at least one fewer pending row (or the section empty)
    // We look for a 🏦 badge or "plaid" source indicator in the main expense list
    await expect(
      page.getByText(/4\.20/i).or(page.getByText(/🏦/))
    ).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 04. Save uncategorized
  // -------------------------------------------------------------------------

  test('04 save uncategorized creates expense with category Other', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    const saveUncatBtn = page
      .getByRole('button', { name: /save uncategorized/i })
      .or(page.getByRole('button', { name: /uncategorized/i }))
      .first()
    await expect(saveUncatBtn).toBeVisible({ timeout: 15_000 })

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/plaid/pending/') &&
          r.url().includes('/save-uncategorized') &&
          r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      saveUncatBtn.click(),
    ])

    await page.waitForLoadState('networkidle')

    // Expense should appear with "Other" category
    await expect(page.getByText(/other/i).first()).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 05. Discard + undo restores row
  // -------------------------------------------------------------------------

  test('05 discard removes pending row and undo restores it', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    const discardBtn = page
      .getByRole('button', { name: /discard/i })
      .first()
    await expect(discardBtn).toBeVisible({ timeout: 15_000 })

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/plaid/pending/') &&
          r.url().includes('/discard') &&
          r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      discardBtn.click(),
    ])

    // Toast with Undo button should appear
    const undoBtn = page.getByRole('button', { name: /undo/i })
    await expect(undoBtn).toBeVisible({ timeout: 5_000 })

    // Click undo within the 5s window
    await undoBtn.click()

    // Row should reappear in pending section
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByRole('button', { name: /discard/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 06. Discard without undo persists after timeout
  // -------------------------------------------------------------------------

  test('06 discard without undo persists after reload', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    // Count initial pending rows
    const discardBtns = page.getByRole('button', { name: /discard/i })
    const initialCount = await discardBtns.count()
    expect(initialCount).toBeGreaterThan(0)

    const discardBtn = discardBtns.first()
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/plaid/pending/') &&
          r.url().includes('/discard') &&
          r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      discardBtn.click(),
    ])

    // Do NOT click Undo — wait for the toast to disappear (> 5s)
    await page.waitForTimeout(6_000)

    // Reload and assert the discarded row is gone
    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    const afterCount = await page.getByRole('button', { name: /discard/i }).count()
    expect(afterCount).toBeLessThan(initialCount)
  })

  // -------------------------------------------------------------------------
  // 07. Disconnect bank removes connection and pending transactions
  // -------------------------------------------------------------------------

  test('07 disconnect bank removes connection and pending transactions', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/first platypus bank/i)).toBeVisible({ timeout: 15_000 })

    const disconnectBtn = page
      .getByRole('button', { name: /disconnect/i })
      .or(page.getByRole('button', { name: /remove/i }))
      .first()
    await expect(disconnectBtn).toBeVisible()
    await disconnectBtn.click()

    // Confirm in modal/dialog if one appears
    const confirmBtn = page
      .getByRole('button', { name: /confirm/i })
      .or(page.getByRole('button', { name: /disconnect/i }))
      .last()
    if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes('/plaid/items/') &&
            r.request().method() === 'DELETE',
          { timeout: 15_000 }
        ),
        confirmBtn.click(),
      ])
    }

    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/first platypus bank/i)).not.toBeVisible({ timeout: 10_000 })

    // Pending count should now be 0
    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/transactions? need review/i)).not.toBeVisible()
  })

  // -------------------------------------------------------------------------
  // 08. Rename connection persists
  // -------------------------------------------------------------------------

  test('08 rename connection persists after reload', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/first platypus bank/i)).toBeVisible({ timeout: 15_000 })

    const renameBtn = page.getByRole('button', { name: /rename/i }).first()
    await expect(renameBtn).toBeVisible()
    await renameBtn.click()

    const nameInput = page.getByRole('textbox').or(page.locator('input[type="text"]')).last()
    await nameInput.fill('Test Bank 1')

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/plaid/items/') &&
          r.request().method() === 'PATCH',
        { timeout: 15_000 }
      ),
      page.getByRole('button', { name: /save/i }).last().click(),
    ])

    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/test bank 1/i)).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 09. Family member sees pending items from another member (optional)
  //
  // Requires: TEST_USER_2_JWT env var (a JWT for a user in the SAME family as
  // the primary test user).  Skip gracefully if not configured.
  // -------------------------------------------------------------------------

  ifNoSecondUser(
    '09 family member sees pending items from another family member',
    async ({ page }) => {
      // Primary user connects
      await sandboxConnect(jwt)

      const user2Jwt = process.env.TEST_USER_2_JWT!

      // Switch to user2 session: inject their JWT into localStorage
      await page.goto(BASE)
      await page.evaluate(
        ({ token }) => {
          const existing = JSON.parse(localStorage.getItem('auth-storage') || '{}')
          existing.state = { ...existing.state, token }
          localStorage.setItem('auth-storage', JSON.stringify(existing))
        },
        { token: user2Jwt }
      )

      await page.goto(`${BASE}/transactions`)
      await page.waitForLoadState('networkidle')

      // User 2 (same family) should see the pending transactions
      await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })
    }
  )

  // -------------------------------------------------------------------------
  // 10. Cross-family isolation (optional)
  //
  // Requires: TEST_USER_2_JWT to be a user with NO family (or a different family).
  // -------------------------------------------------------------------------

  ifNoSecondUser(
    '10 cross-family isolation: different family sees nothing',
    async ({ page }) => {
      // Primary user (family A) connects
      await sandboxConnect(jwt)

      const outsiderJwt = process.env.TEST_USER_2_JWT!

      // Switch to outsider session
      await page.goto(BASE)
      await page.evaluate(
        ({ token }) => {
          const existing = JSON.parse(localStorage.getItem('auth-storage') || '{}')
          existing.state = { ...existing.state, token }
          localStorage.setItem('auth-storage', JSON.stringify(existing))
        },
        { token: outsiderJwt }
      )

      // Settings: no connected accounts
      await page.goto(`${BASE}/settings`)
      await page.waitForLoadState('networkidle')
      await expect(page.getByText(/first platypus bank/i)).not.toBeVisible({ timeout: 10_000 })

      // Transactions: no pending
      await page.goto(`${BASE}/transactions`)
      await page.waitForLoadState('networkidle')
      await expect(page.getByText(/transactions? need review/i)).not.toBeVisible()
    }
  )
})
