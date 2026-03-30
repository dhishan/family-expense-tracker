/**
 * One-time script to get a Google OAuth refresh token for test automation.
 *
 * Run from the frontend/ directory:
 *   node tests/get-refresh-token.mjs
 *
 * Reads VITE_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from .env.test
 */
import * as http from 'http'
import * as https from 'https'
import { parse } from 'url'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// Load .env.test
const __dirname = dirname(fileURLToPath(import.meta.url))
try {
  const envFile = readFileSync(resolve(__dirname, '../.env.test'), 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
} catch {}

const CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI = 'http://localhost:9999'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing VITE_GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in frontend/.env.test')
  process.exit(1)
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  }).toString()

console.log('\nOpen this URL in your browser:\n')
console.log(authUrl)
console.log('\nWaiting for Google to redirect to localhost:9999 ...\n')

const server = http.createServer(async (req, res) => {
  const { query } = parse(req.url, true)
  const code = query.code

  if (!code) {
    res.end('No code — try again.')
    return
  }

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString()

  const tokens = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const r = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (c) => (data += c))
      resp.on('end', () => resolve(JSON.parse(data)))
    })
    r.on('error', reject)
    r.write(body)
    r.end()
  })

  if (tokens.refresh_token) {
    console.log('✅ Success!\n')
    console.log('Add this to frontend/.env.test:')
    console.log(`GOOGLE_TEST_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log('\nAnd save as a GitHub secret:')
    console.log(`gh secret set GOOGLE_TEST_REFRESH_TOKEN --body "${tokens.refresh_token}" --repo dhishan/family-expense-tracker`)
    res.end('Done! You can close this tab.')
  } else {
    console.error('No refresh_token returned:', tokens)
    res.end('Failed — check terminal.')
  }

  server.close()
})

server.listen(9999)
