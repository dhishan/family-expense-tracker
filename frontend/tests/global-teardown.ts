import * as https from 'https'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
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
  const data = await get(`${API}/budgets`, token) as any
  const budgets = (data.budgets ?? []).map((b: any) => b.budget ?? b)
  if (budgets.length > 0) {
    await Promise.all(budgets.map((b: any) => del(`${API}/budgets/${b.id}`, token)))
  }
}

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return

  const { jwt } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))

  console.log('\n🧹 Global teardown: deleting test data...')
  await Promise.all([
    deleteAllExpenses(jwt),
    deleteAllBudgets(jwt),
  ])
  console.log('   ✅ Test data deleted\n')

  fs.unlinkSync(STATE_FILE)
}
