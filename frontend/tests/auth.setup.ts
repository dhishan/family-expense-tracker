import { test as setup, expect } from '@playwright/test'
import * as https from 'https'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const authFile = join(__dirname, '.auth/user.json')

async function post(hostname: string, path: string, body: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(JSON.parse(data)))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function getFreshIdToken(): Promise<string> {
  const refreshToken = process.env.GOOGLE_TEST_REFRESH_TOKEN
  const clientId = process.env.VITE_GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!refreshToken) throw new Error('GOOGLE_TEST_REFRESH_TOKEN env var is required')
  if (!clientId) throw new Error('VITE_GOOGLE_CLIENT_ID env var is required')
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var is required')

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString()

  const tokens = await post('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  }) as Record<string, string>

  if (!tokens.id_token) {
    throw new Error(`Failed to get id_token from Google: ${JSON.stringify(tokens)}`)
  }

  return tokens.id_token
}

setup('authenticate via Google refresh token', async ({ page }) => {
  const baseURL = process.env.BASE_URL || 'https://ui.expense-tracker.blueelephants.org'
  const apiBase = process.env.API_URL || 'https://api.expense-tracker.blueelephants.org/api/v1'

  // Step 1: Exchange refresh token for fresh Google ID token
  const idToken = await getFreshIdToken()

  // Step 2: Exchange Google ID token for app JWT
  const authBody = JSON.stringify({ token: idToken, token_type: 'id_token' })
  const authRes = await post('api.expense-tracker.blueelephants.org', '/api/v1/auth/google', authBody, {
    'Content-Type': 'application/json',
  }) as Record<string, unknown>

  if (!authRes.access_token) {
    throw new Error(`Backend auth failed: ${JSON.stringify(authRes)}`)
  }

  const jwt = authRes.access_token as string
  const user = authRes.user

  // Step 3: Fetch full user profile
  const userRes = await page.request.get(`${apiBase}/auth/me`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  expect(userRes.ok(), `Failed to fetch user profile: ${await userRes.text()}`).toBeTruthy()
  const userProfile = await userRes.json()

  // Step 4: Inject auth state into localStorage
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
  console.log(`✅ Authenticated as ${userProfile.email}`)
})
