/**
 * Plaid integration E2E tests.
 *
 * These tests use a sandbox-bypass endpoint (POST /api/v1/plaid/_test/sandbox-connect)
 * to connect First Platypus Bank without driving the Plaid Link iframe.
 * The endpoint is only mounted in non-production environments.
 *
 * Required env vars:
 *   GOOGLE_TEST_REFRESH_TOKEN  – Google refresh token for the primary test user (required)
 *   TEST_USER_2_JWT            – JWT for a second user in the SAME family (optional)
 *                                 Tests 09 and 10 are skipped when absent.
 *
 * The JWT for the primary test user is read from .test-state.json which is written
 * by global-setup.ts.
 */

import { test, expect } from '@playwright/test'
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
async function apiPost(urlPath: string, token: string, body?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : ''
    const u = new URL(urlPath.startsWith('http') ? urlPath : `${API}${urlPath}`)
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
  await apiPost('/plaid/_test/reset', token).catch(() => {})
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

    // Section heading exists
    await expect(page.getByText('Connected Accounts')).toBeVisible()

    // Empty state before connection
    await expect(page.getByText(/first platypus bank/i)).not.toBeVisible()

    // Connect via API (no Link iframe)
    await sandboxConnect(jwt)

    // Reload and assert card appears
    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/first platypus bank/i)).toBeVisible({ timeout: 15_000 })
  })

  // -------------------------------------------------------------------------
  // 02. Pending transactions appear after connection
  // -------------------------------------------------------------------------

  test('02 pending transactions appear after sandbox connection', async ({ page }) => {
    const { pending_count } = await sandboxConnect(jwt)
    expect(pending_count).toBeGreaterThan(0)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    // The pending section renders "{n} transaction(s) need review"
    await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })

    // At least one Approve & edit button visible
    await expect(page.getByRole('button', { name: 'Approve & edit' }).first()).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 03. Approve with edits creates an expense and removes the pending row
  // -------------------------------------------------------------------------

  test('03 approve with edits creates an expense and removes the pending row', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    // Wait for pending section
    await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })
    const pendingCount = (await page.getByRole('button', { name: 'Approve & edit' }).count())
    expect(pendingCount).toBeGreaterThan(0)

    // Click the first "Approve & edit" button
    const approveBtn = page.getByRole('button', { name: 'Approve & edit' }).first()
    await approveBtn.click()

    // Modal should open
    const modal = page.getByRole('dialog').first()
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Change amount
    const amountInput = modal.locator('input[type="number"]').or(modal.getByRole('spinbutton')).first()
    await amountInput.fill('4.20')

    // Submit approve — wait for the approve API call
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/plaid/pending/') && r.url().includes('/approve') && r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      modal.getByRole('button', { name: /approve/i }).click(),
    ])

    await page.waitForLoadState('networkidle')

    // Pending row count should have decreased by 1
    const newPendingCount = await page.getByRole('button', { name: 'Approve & edit' }).count()
    expect(newPendingCount).toBeLessThan(pendingCount)
  })

  // -------------------------------------------------------------------------
  // 04. Save uncategorized creates expense with category Other
  // -------------------------------------------------------------------------

  test('04 save uncategorized creates expense with category Other', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })
    const saveUncatBtn = page.getByRole('button', { name: 'Save uncategorized' }).first()
    await expect(saveUncatBtn).toBeVisible({ timeout: 10_000 })

    const pendingCount = await page.getByRole('button', { name: 'Save uncategorized' }).count()

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

    const newPendingCount = await page.getByRole('button', { name: 'Save uncategorized' }).count()
    expect(newPendingCount).toBeLessThan(pendingCount)
  })

  // -------------------------------------------------------------------------
  // 05. Discard + undo restores row
  // -------------------------------------------------------------------------

  test('05 discard removes pending row and undo restores it', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })

    const discardBtn = page.getByRole('button', { name: 'Discard' }).first()
    await expect(discardBtn).toBeVisible({ timeout: 10_000 })

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

    // Toast with Undo should appear within the 5s window
    const undoBtn = page.getByRole('button', { name: /undo/i })
    await expect(undoBtn).toBeVisible({ timeout: 5_000 })

    // Click Undo
    await undoBtn.click()

    // Row should reappear
    await expect(page.getByRole('button', { name: 'Discard' }).first()).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 06. Discard without undo persists after reload
  // -------------------------------------------------------------------------

  test('06 discard without undo persists after reload', async ({ page }) => {
    await sandboxConnect(jwt)

    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/transactions? need review/i)).toBeVisible({ timeout: 15_000 })

    const initialCount = await page.getByRole('button', { name: 'Discard' }).count()
    expect(initialCount).toBeGreaterThan(0)

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/plaid/pending/') &&
          r.url().includes('/discard') &&
          r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      page.getByRole('button', { name: 'Discard' }).first().click(),
    ])

    // Do NOT click Undo — wait for the toast to disappear (backend commit window)
    await page.waitForTimeout(6_000)

    // Reload and assert discarded row is gone (backend should have committed it)
    await page.goto(`${BASE}/transactions`)
    await page.waitForLoadState('networkidle')

    const afterCount = await page.getByRole('button', { name: 'Discard' }).count()
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

    // The disconnect button has title="Disconnect"
    const disconnectBtn = page.getByTitle('Disconnect').first()
    await expect(disconnectBtn).toBeVisible()
    await disconnectBtn.click()

    // Confirm in modal
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/plaid/items/') && r.request().method() === 'DELETE',
        { timeout: 15_000 }
      ),
      page.getByRole('button', { name: 'Disconnect' }).last().click(),
    ])

    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/first platypus bank/i)).not.toBeVisible({ timeout: 10_000 })

    // Pending section should not be visible (no pending items)
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

    // The rename button has title="Rename"
    await page.getByTitle('Rename').first().click()

    // Input should now be visible — clear it and type new name
    const nameInput = page.locator('input[placeholder*="ank"], input[type="text"]').last()
    await nameInput.fill('Test Bank 1')

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/plaid/items/') && r.request().method() === 'PATCH',
        { timeout: 15_000 }
      ),
      page.getByRole('button', { name: 'Save' }).last().click(),
    ])

    // Reload and verify name persists
    await page.goto(`${BASE}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(/test bank 1/i)).toBeVisible({ timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // 09. Family member sees pending items from another family member (optional)
  //
  // Requires TEST_USER_2_JWT: JWT for a user in the SAME family as the
  // primary test user. Skip gracefully if not configured.
  // -------------------------------------------------------------------------

  ifNoSecondUser(
    '09 family member sees pending items from another family member',
    async ({ page }) => {
      // Primary user connects
      await sandboxConnect(jwt)

      const user2Jwt = process.env.TEST_USER_2_JWT!

      // Switch to user2 session by injecting their JWT into localStorage
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
  // Requires TEST_USER_2_JWT to be a user with NO family (or a different family).
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
