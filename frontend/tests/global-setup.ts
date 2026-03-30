import * as https from 'https'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(__dirname, '.test-state.json')

const API = process.env.API_URL || 'https://api.expense-tracker.blueelephants.org/api/v1'

function post(hostname: string, path: string, body: string, headers: Record<string, string>): Promise<unknown> {
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

function del(url: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume()
        res.on('end', resolve)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function getFreshIdToken(): Promise<string> {
  const refreshToken = process.env.GOOGLE_TEST_REFRESH_TOKEN
  const clientId = process.env.VITE_GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!refreshToken) throw new Error('GOOGLE_TEST_REFRESH_TOKEN is required')
  if (!clientId) throw new Error('VITE_GOOGLE_CLIENT_ID is required')
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is required')

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString()

  const tokens = await post('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  }) as Record<string, string>

  if (!tokens.id_token) throw new Error(`Failed to get id_token: ${JSON.stringify(tokens)}`)
  return tokens.id_token
}

async function deleteAllExpenses(token: string) {
  let page = 1
  while (true) {
    const data = await get(`${API}/expenses?page=${page}&page_size=100`, token) as any
    const expenses = data.expenses ?? []
    if (expenses.length === 0) break
    await Promise.all(expenses.map((e: any) => del(`${API}/expenses/${e.id}`, token)))
    if (!data.has_more) break
    page++
  }
}

async function deleteAllBudgets(token: string) {
  let page = 1
  while (true) {
    const data = await get(`${API}/budgets`, token) as any
    const budgets = (data.budgets ?? []).map((b: any) => b.budget ?? b)
    if (budgets.length === 0) break
    await Promise.all(budgets.map((b: any) => del(`${API}/budgets/${b.id}`, token)))
    // Budgets endpoint returns all at once (no pagination), so exit after first pass
    break
  }
}

export default async function globalSetup() {
  console.log('\n🔧 Global setup: authenticating test user...')

  const idToken = await getFreshIdToken()

  const authRes = await post('api.expense-tracker.blueelephants.org', '/api/v1/auth/google',
    JSON.stringify({ token: idToken, token_type: 'id_token' }),
    { 'Content-Type': 'application/json' }
  ) as Record<string, unknown>

  if (!authRes.access_token) throw new Error(`Backend auth failed: ${JSON.stringify(authRes)}`)
  const jwt = authRes.access_token as string

  // Get user profile
  const user = await get(`${API}/auth/me`, jwt) as Record<string, unknown>
  console.log(`   ✅ Authenticated as ${user.email}`)

  let familyId = user.family_id as string | null

  if (!familyId) {
    console.log('   🏠 Creating test family...')
    const family = await post('api.expense-tracker.blueelephants.org', '/api/v1/families',
      JSON.stringify({ name: 'Test Family' }),
      { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }
    ) as Record<string, unknown>
    familyId = family.id as string
    console.log(`   ✅ Test family created: ${familyId}`)
  } else {
    console.log(`   🏠 Using existing test family: ${familyId}`)
  }

  // Wipe all test data from previous runs
  console.log('   🧹 Cleaning up previous test data...')
  await Promise.all([
    deleteAllExpenses(jwt),
    deleteAllBudgets(jwt),
  ])
  console.log('   ✅ Clean slate ready\n')

  // Save state for teardown and auth.setup.ts
  fs.writeFileSync(STATE_FILE, JSON.stringify({ jwt, familyId, email: user.email }))
}
