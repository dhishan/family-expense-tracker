import { test as setup, expect } from '@playwright/test'
import * as https from 'https'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const authFile = join(__dirname, '.auth/user.json')
const STATE_FILE = join(__dirname, '.test-state.json')

const API = process.env.API_URL || 'https://api.expense-tracker.blueelephants.org/api/v1'

function get(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(JSON.parse(data)))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

setup('authenticate test user', async ({ page }) => {
  const baseURL = process.env.BASE_URL || 'https://ui.expense-tracker.blueelephants.org'

  if (!fs.existsSync(STATE_FILE)) {
    throw new Error('global-setup must run before auth.setup — .test-state.json not found')
  }

  const { jwt } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))

  // Fetch full user profile using the JWT from global setup
  const userProfile = await get(`${API}/auth/me`, jwt) as Record<string, unknown>

  // Inject auth state into localStorage
  await page.goto(baseURL)
  await page.evaluate(
    ({ token, user }) => {
      localStorage.setItem(
        'auth-storage',
        JSON.stringify({ state: { user, token, isAuthenticated: true }, version: 0 })
      )
    },
    { token: jwt, user: userProfile }
  )

  await page.context().storageState({ path: authFile })
  console.log(`✅ Browser authenticated as ${userProfile.email}`)
})
