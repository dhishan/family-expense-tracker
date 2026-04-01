import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL || 'https://ui.expense-tracker.blueelephants.org'
const API = process.env.API_URL || 'https://api.expense-tracker.blueelephants.org/api/v1'

test.describe('Budget creation and display', () => {
  test('can create a budget and it appears in the list', async ({ page }) => {
    await page.goto(`${BASE}/budgets`)

    // Wait for the page to load (not the "join a family" gate)
    await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible()

    const budgetName = `Test Budget ${Date.now()}`

    // Open create modal
    await page.getByRole('button', { name: 'Create Budget' }).first().click()
    await expect(page.getByRole('heading', { name: 'Create Budget' })).toBeVisible()

    // Fill form
    await page.getByPlaceholder('e.g., Monthly Groceries').fill(budgetName)
    await page.getByPlaceholder('0.00').fill('500')

    // Submit
    await page.getByRole('button', { name: 'Create Budget' }).last().click()

    // Toast confirmation
    await expect(page.getByText('Budget created!')).toBeVisible()

    // Budget card should appear
    await expect(page.getByText(budgetName)).toBeVisible({ timeout: 15000 })
  })

  test('budget card shows spent amount and progress bar', async ({ page }) => {
    await page.goto(`${BASE}/budgets`)
    await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible()

    // At least one budget card should exist
    const cards = page.locator('[class*="border-l-4"]')
    await expect(cards.first()).toBeVisible()

    // Each card should show spent and amount
    await expect(cards.first().getByText(/\$.*spent/)).toBeVisible()
  })
})

test.describe('Expense creation', () => {
  test('can add an expense and it appears in the list', async ({ page }) => {
    await page.goto(`${BASE}/expenses`)
    await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible()

    // Open add expense modal
    await page.getByRole('button', { name: 'Add Expense' }).click()
    await expect(page.getByRole('heading', { name: 'Add Expense' })).toBeVisible()

    // Fill form
    await page.getByPlaceholder('0.00').fill('25.50')
    await page.getByPlaceholder('What was this expense for?').fill('Playwright test expense')

    // Submit
    await page.getByRole('button', { name: 'Add Expense' }).last().click()

    // Toast confirmation
    await expect(page.getByText('Expense added!')).toBeVisible()

    // Expense should appear in the list (use first() since prior test runs may have left duplicates)
    await expect(page.getByText('Playwright test expense').first()).toBeVisible()
  })
})

test.describe('Budget and expense integration', () => {
  test('adding an expense updates budget spent amount', async ({ page }) => {
    // Create a budget for groceries
    await page.goto(`${BASE}/budgets`)
    await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible()

    // Use 'utilities' category — no prior test expenses in this category
    const budgetName = `Utilities ${Date.now()}`
    await page.getByRole('button', { name: 'Create Budget' }).first().click()
    await page.getByPlaceholder('e.g., Monthly Groceries').fill(budgetName)
    await page.getByPlaceholder('0.00').fill('200')
    // Category is the 2nd select in the budget form (period, then category)
    await page.locator('select').nth(1).selectOption('utilities')
    await page.getByRole('button', { name: 'Create Budget' }).last().click()
    await expect(page.getByText('Budget created!')).toBeVisible()

    // Add a utilities expense
    await page.goto(`${BASE}/expenses`)
    await page.getByRole('button', { name: 'Add Expense' }).click()
    await expect(page.getByRole('heading', { name: 'Add Expense' })).toBeVisible()
    await page.getByPlaceholder('0.00').fill('45.00')
    await page.getByPlaceholder('What was this expense for?').fill('Electricity bill')
    // Category select — scope to the modal form to avoid the filter select
    await page.locator('form select').first().selectOption('utilities')
    await page.getByRole('button', { name: 'Add Expense' }).last().click()
    await expect(page.getByText('Expense added!')).toBeVisible({ timeout: 10000 })

    // Go back to budgets and verify spent amount updated
    await page.goto(`${BASE}/budgets`)
    await page.waitForLoadState('networkidle')

    const cardAfter = page.locator('[class*="border-l-4"]').filter({ hasText: budgetName })
    await expect(cardAfter.getByText('$45.00 spent')).toBeVisible({ timeout: 10000 })
  })
})
