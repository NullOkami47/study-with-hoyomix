// A disposable local Worker, real D1 and real browser WebSockets. No auth route is
// added to production: fixture users/sessions are inserted directly into local D1.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { build as bundle } from 'esbuild'
import { build, preview } from 'vite'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const root = process.cwd()
if (process.platform === 'win32' && !/^D:/i.test(root)) throw new Error('Run chat E2E from the D drive')
const scratchRoot = resolve(process.env.CHAT_E2E_SCRATCH || (process.platform === 'win32' ? 'D:/hoyomix_preview/chat-browser-runtime' : join(tmpdir(), 'hoyomix-chat-e2e')))
await mkdir(scratchRoot, { recursive: true })
process.env.TEMP = process.env.TMP = scratchRoot
const scratch = await mkdtemp(join(scratchRoot, 'run-'))
const evidence = resolve(process.env.CHAT_E2E_EVIDENCE || 'docs/verification/2026-10-17-chat-browser')
await mkdir(evidence, { recursive: true })
const origin = 'https://localhost:4194'
const secret = randomBytes(48).toString('hex')
const startedAt = new Date().toISOString()
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
async function sourceFingerprint() {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'workers', 'migrations', 'e2e', 'playwright.chat.config.ts', 'scripts/run-chat-e2e.mjs', 'vite.config.ts', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const digest = createHash('sha256')
  for (const name of names) { digest.update(name); digest.update(await readFile(name)) }
  return digest.digest('hex')
}
const sourceHashAtStart = await sourceFingerprint()
let runtime
let server
let passed = false
try {
  const key = join(scratch, 'localhost.key')
  const cert = join(scratch, 'localhost.crt')
  const openssl = process.env.CHAT_E2E_OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl')
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  console.log('[chat fixture] Bundling the production Worker and session helper')
  const [worker, sessionModule] = await Promise.all([
    bundle({ entryPoints: ['workers/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' }),
    bundle({ entryPoints: ['workers/auth/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node' }),
  ])
  const { hashSessionToken } = await import(`data:text/javascript;base64,${Buffer.from(sessionModule.outputFiles[0].text).toString('base64')}`)
  runtime = new Miniflare({ ...convertV4MiniflareOptions({
    host: '127.0.0.1', port: 4195, https: true, httpsKey: await readFile(key, 'utf8'), httpsCert: await readFile(cert, 'utf8'), modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: '2025-12-01',
    durableObjects: { PRESENCE: { className: 'OnlinePresence', useSQLite: true }, CHAT: { className: 'ChatRoom', useSQLite: true } },
    d1Databases: { DB: 'chat-browser-local' },
    bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret, OAUTH_STATE_SECRET: randomBytes(48).toString('hex') },
  }), resourcePersistencePath: join(scratch, 'storage'), resourceTmpPath: join(scratch, 'tmp') })
  await runtime.ready
  console.log('[chat fixture] Applying disposable local D1 migrations')
  const db = await runtime.getD1Database('DB')
  const migrations = (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()
  for (const name of migrations) {
    const sql = await readFile(join('migrations', name), 'utf8')
    // D1 exec splits on newlines; batch complete statements, as in migrations.spec.ts.
    const statements = sql.split(';').map(text => text.trim()).filter(Boolean)
    await db.batch(statements.map(sql => db.prepare(sql)))
  }
  const now = Date.now()
  const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
  for (let i = 0; i < tokens.length; i++) {
    const id = `browser-user-${i + 1}`
    await db.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, `Browser learner ${i + 1}`, 'user', now, now).run()
    await db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .bind(`browser-session-${i}`, id, await hashSessionToken(tokens[i], secret, crypto), now + 3_600_000, now, now).run()
  }
  await db.batch(Array.from({ length: 65 }, (_, i) => db.prepare(`INSERT INTO chat_messages (id,room_id,user_id,author_display_name,content,message_type,created_at,expires_at)
    VALUES (?,?,?,?,?,'text',?,?)`).bind(`history-${String(i).padStart(3, '0')}`, 'global', 'browser-user-1', 'Browser learner 1', `Earlier study message ${i}`, now - 100_000 + i * 1000, now + 86_400_000)))
  delete process.env.VITE_ANALYTICS_ID
  delete process.env.VITE_ANALYTICS_URL
  process.env.VITE_ENABLE_DEMO_CATALOG = 'false'
  console.log('[chat fixture] Building the frontend')
  const dist = join(scratch, 'dist')
  await build({ build: { outDir: dist, emptyOutDir: true }, logLevel: 'warn' })
  const sourceHashAfterBuild = await sourceFingerprint()
  const frontendHash = createHash('sha256')
  for (const name of (await readdir(dist, { recursive: true })).filter(name => /\.(?:js|css|html|webmanifest)$/.test(name)).sort()) {
    frontendHash.update(name)
    frontendHash.update(await readFile(join(dist, name)))
  }
  server = await preview({ build: { outDir: dist }, preview: { host: 'localhost', port: 4194, strictPort: true, https: { key: await readFile(key), cert: await readFile(cert) },
    proxy: { '/api': { target: 'https://127.0.0.1:4195', secure: false, ws: true, changeOrigin: false } } } })
  const env = { ...process.env, CHAT_E2E_ORIGIN: origin, CHAT_E2E_USER_ONE: tokens[0], CHAT_E2E_USER_TWO: tokens[1],
    CHAT_E2E_OUTPUT: join(scratch, 'playwright'), CHAT_E2E_REPORT: join(evidence, 'results.json'), CHAT_E2E_EVIDENCE: evidence }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.chat.config.ts', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  passed = process.exitCode === 0
  await writeFile(join(evidence, 'fixture.json'), JSON.stringify({ origin, migrations, seededUsers: 2, seededHistory: 65,
    startedAt,
    sourceHeadAtStart: sourceHead,
    sourceHashAtStart,
    sourceHashAfterBuild,
    unchangedDuringBuild: sourceHashAtStart === sourceHashAfterBuild,
    workerBundleSha256: createHash('sha256').update(worker.outputFiles[0].text).digest('hex'),
    frontendBundleSha256: frontendHash.digest('hex'),
    transport: 'browser secure WebSocket -> local HTTPS Vite upgrade proxy -> local Miniflare ChatRoom + D1',
    authentication: 'local D1 fixture sessions hashed by production hashSessionToken; no production bypass',
    exitCode: process.exitCode, completedAt: new Date().toISOString() }, null, 2))
} finally {
  server?.httpServer.closeAllConnections?.()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  await runtime?.dispose()
  // The scratch path is newly created under the explicitly selected D-drive root.
  if (!scratch.startsWith(scratchRoot)) throw new Error('Unsafe fixture cleanup path')
  if (passed) await rm(scratch, { recursive: true, force: true })
  else console.log(`[chat fixture] Failure diagnostics retained locally at ${scratch}`)
}
