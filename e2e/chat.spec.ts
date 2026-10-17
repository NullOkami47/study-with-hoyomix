import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openControlCentreSection } from '../tests/e2e/support/workspace'

const origin = process.env.CHAT_E2E_ORIGIN || 'https://localhost:4194'
const evidence = process.env.CHAT_E2E_EVIDENCE || 'docs/verification/2026-10-17-chat-browser'

async function learner(browser: Browser, token?: string, visualStyle = 'studio'): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ignoreHTTPSErrors: true })
  await context.addInitScript((style) => {
    const key = 'study-with-hoyomix.ui-preferences'
    localStorage.setItem(key, JSON.stringify({ locale: 'en', visualStyle: style, backgroundMode: 'still', studyTipsEnabled: false }))
  }, visualStyle)
  if (token) {
    await context.addCookies([{ name: '__Host-session', value: token, url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }])
    // Account sync correctly overrides device preferences. Set the disposable
    // fixture account through its real versioned endpoint before opening a page.
    const current = await context.request.get(`${origin}/api/account/ui-preferences`, { headers: { 'x-account-preferences-schema': '2' } })
    expect(current.ok()).toBe(true)
    const saved = await context.request.put(`${origin}/api/account/ui-preferences`, {
      headers: { origin, 'x-account-preferences-schema': '2', 'if-match': current.headers().etag },
      data: { preferences: { locale: 'en', volume: 1, visualStyle, backgroundMode: 'still', studioBlur: 16, studioGlassGray: 26, studioEdge: 68, studyTipsEnabled: false } },
    })
    expect(saved.ok()).toBe(true)
  }
  return context
}

async function openChat(page: Page) {
  const sessionReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session')
  await page.goto('/')
  await sessionReady
  await expect(page.locator('[data-chat-panel]')).toBeHidden()
  await reopenChat(page)
  await expect(page.locator('[data-chat-panel]')).toBeVisible()
  await expect(page.locator('[data-chat-connection="connected"]')).toBeVisible()
}

async function reopenChat(page: Page) {
  await openControlCentreSection(page, 'chat')
  await page.locator('[data-control-centre-open-chat]').click()
}

async function send(page: Page, text: string) {
  await page.locator('[data-chat-composer]').fill(text)
  await page.locator('[data-chat-send]').click()
  const message = page.locator('[data-chat-message]').filter({ hasText: text })
  await expect(message).toHaveCount(1)
  return message
}

test('two independent authenticated browsers exchange, edit and delete persisted messages over actual WebSockets', async ({ browser }) => {
  const one = await learner(browser, process.env.CHAT_E2E_USER_ONE)
  const two = await learner(browser, process.env.CHAT_E2E_USER_TWO)
  try {
    const a = await one.newPage()
    const b = await two.newPage()
    const socketEvidence: Array<{ client: string; direction: string; type: string }> = []
    for (const [page, client] of [[a, 'one'], [b, 'two']] as const) {
      page.on('websocket', socket => {
        if (!socket.url().includes('/api/chat/socket')) return
        socketEvidence.push({ client, direction: 'opened', type: 'WebSocket' })
        socket.on('framereceived', ({ payload }) => {
          try { socketEvidence.push({ client, direction: 'received', type: JSON.parse(String(payload)).type }) } catch { /* Non-JSON heartbeat. */ }
        })
      })
    }
    await Promise.all([openChat(a), openChat(b)])
    const original = 'Let us finish this study session together.'
    const own = await send(a, original)
    const id = await own.getAttribute('data-chat-message')
    expect(id).toBeTruthy()
    await expect(b.locator(`[data-chat-message="${id}"]`)).toContainText(original)
    await expect(b.locator(`[data-chat-edit="${id}"]`)).toHaveCount(0)
    await a.locator(`[data-chat-edit="${id}"]`).click()
    const edited = 'Our shared study session is progressing.'
    await a.locator('[data-chat-composer]').fill(edited)
    await a.locator('[data-chat-send]').click()
    await expect(b.locator(`[data-chat-message="${id}"]`)).toContainText(edited)
    await expect(b.locator(`[data-chat-message="${id}"]`)).not.toContainText(original)
    await b.reload()
    await reopenChat(b)
    await expect(b.locator(`[data-chat-message="${id}"]`)).toContainText(edited)
    await a.locator(`[data-chat-delete="${id}"]`).click()
    await expect(b.locator(`[data-chat-message="${id}"]`)).toHaveCount(0)
    const reply = await send(b, 'The second browser can also send a message.')
    const replyId = await reply.getAttribute('data-chat-message')
    await expect(a.locator(`[data-chat-message="${replyId}"]`)).toBeVisible()
    await expect.poll(() => socketEvidence.filter(event => event.type === 'message' && event.client === 'two').length).toBeGreaterThanOrEqual(2)
    expect(socketEvidence.some(event => event.client === 'two' && event.type === 'delete')).toBe(true)
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'real-websocket-events.json'), JSON.stringify(socketEvidence, null, 2))
    await b.screenshot({ path: join(evidence, 'two-client-chat.png'), fullPage: true })
  } finally { await one.close(); await two.close() }
})

test('history pagination and reopen preserve real persisted messages while fresh pages default to hidden', async ({ browser }) => {
  const context = await learner(browser, process.env.CHAT_E2E_USER_ONE)
  try {
    const page = await context.newPage()
    await openChat(page)
    await expect(page.getByText('Earlier study message 0', { exact: true })).toHaveCount(0)
    const history = page.locator('[data-chat-history]')
    await page.locator('[data-chat-log]').evaluate(element => { element.scrollTop = 0 })
    const anchorId = await page.locator('[data-chat-message]').first().getAttribute('data-chat-message')
    const anchorBefore = await page.locator(`[data-chat-message="${anchorId}"]`).boundingBox()
    await history.click()
    await expect(page.getByText('Earlier study message 0', { exact: true })).toBeVisible()
    const anchorAfter = await page.locator(`[data-chat-message="${anchorId}"]`).boundingBox()
    expect(anchorBefore).not.toBeNull()
    expect(anchorAfter).not.toBeNull()
    expect(Math.abs(anchorAfter!.y - anchorBefore!.y)).toBeLessThanOrEqual(2)
    await page.locator('[data-floating-chat-close]').click()
    await expect(page.locator('[data-chat-panel]')).toBeHidden()
    await reopenChat(page)
    await expect(page.locator('[data-chat-panel]')).toBeVisible()
    await page.reload()
    await expect(page.locator('[data-chat-panel]')).toBeHidden()
  } finally { await context.close() }
})

test('keeps real sockets alive beyond the server stale interval and supports landscape keyboard input', async ({ browser }) => {
  test.setTimeout(150_000)
  const one = await learner(browser, process.env.CHAT_E2E_USER_ONE)
  const two = await learner(browser, process.env.CHAT_E2E_USER_TWO)
  try {
    const a = await one.newPage()
    const b = await two.newPage()
    await a.setViewportSize({ width: 844, height: 390 })
    const frames: string[] = []
    const events: Array<{ elapsedMs: number; event: string }> = []
    const timeline = Date.now()
    let connections = 0
    a.on('websocket', socket => {
      if (!socket.url().includes('/api/chat/socket')) return
      connections++
      events.push({ elapsedMs: Date.now() - timeline, event: 'open' })
      socket.on('close', () => events.push({ elapsedMs: Date.now() - timeline, event: 'close' }))
      socket.on('framesent', ({ payload }) => { if (String(payload) === 'ping') { frames.push('ping'); events.push({ elapsedMs: Date.now() - timeline, event: 'ping' }) } })
      socket.on('framereceived', ({ payload }) => {
        if (String(payload) === 'pong') { frames.push('pong'); events.push({ elapsedMs: Date.now() - timeline, event: 'pong' }) }
        else { try { const type = JSON.parse(String(payload)).type; if (['reset', 'snapshot', 'presence'].includes(type)) events.push({ elapsedMs: Date.now() - timeline, event: type }) } catch { /* Record no message bodies. */ } }
      })
    })
    await Promise.all([openChat(a), openChat(b)])
    const started = Date.now()
    await expect.poll(() => frames.filter(frame => frame === 'pong').length, { timeout: 40_000, intervals: [1000] }).toBeGreaterThan(0)
    const stableConnections = connections
    await expect.poll(() => Date.now() - started, { timeout: 105_000, intervals: [5000] }).toBeGreaterThanOrEqual(95_000)
    await writeFile(join(evidence, 'heartbeat.json'), JSON.stringify({ durationMs: Date.now() - started, stableConnections, finalConnections: connections, frames, events }, null, 2))
    expect(connections).toBe(stableConnections)
    expect(frames.filter(frame => frame === 'pong').length).toBeGreaterThanOrEqual(3)
    const composer = a.locator('[data-chat-composer]')
    await composer.focus()
    await a.keyboard.type('Keyboard input after the stale interval')
    await a.keyboard.press('Shift+Enter')
    await a.keyboard.type('still reaches the other learner.')
    await expect(composer).toBeInViewport({ ratio: 1 })
    await expect(a.locator('[data-chat-send]')).toBeInViewport({ ratio: 1 })
    await a.keyboard.press('Enter')
    await expect(b.locator('[data-chat-message]').filter({ hasText: 'Keyboard input after the stale interval' })).toContainText('still reaches the other learner.')
    await writeFile(join(evidence, 'heartbeat.json'), JSON.stringify({ durationMs: Date.now() - started, stableConnections, finalConnections: connections, frames, events }, null, 2))
    await a.screenshot({ path: join(evidence, 'landscape-keyboard.png'), fullPage: true })
  } finally { await one.close(); await two.close() }
})

test('anonymous readers cannot send and logout revokes a previously valid local session', async ({ browser }) => {
  const anonymous = await learner(browser)
  const signedIn = await learner(browser, process.env.CHAT_E2E_USER_TWO)
  try {
    const reader = await anonymous.newPage()
    await openChat(reader)
    await expect(reader.locator('[data-chat-composer]')).toHaveCount(0)
    const rejected = await anonymous.request.post(`${origin}/api/chat/messages`, { headers: { origin }, data: { requestId: crypto.randomUUID(), type: 'text', text: 'anonymous must not persist' } })
    expect(rejected.status()).toBe(401)
    const page = await signedIn.newPage()
    await openChat(page)
    const logout = await signedIn.request.post(`${origin}/api/logout`, { headers: { origin } })
    expect(logout.ok()).toBe(true)
    const forbidden = await signedIn.request.post(`${origin}/api/chat/messages`, { headers: { origin }, data: { requestId: crypto.randomUUID(), type: 'text', text: 'revoked session must not persist' } })
    expect(forbidden.status()).toBe(401)
    await expect(page.locator('[data-chat-composer]')).toHaveCount(0, { timeout: 40_000 })
    await page.reload()
    await reopenChat(page)
    await expect(page.locator('[data-chat-composer]')).toHaveCount(0)
  } finally { await anonymous.close(); await signedIn.close() }
})

test('an active connection survives rotation and a reduced viewport with the draft and composer reachable', async ({ browser }) => {
  const context = await learner(browser, process.env.CHAT_E2E_USER_ONE)
  try {
    const page = await context.newPage()
    let connections = 0
    page.on('websocket', socket => { if (socket.url().includes('/api/chat/socket')) connections++ })
    await page.setViewportSize({ width: 390, height: 844 })
    await openChat(page)
    const composer = page.locator('[data-chat-composer]')
    await composer.fill('旋轉畫面後仍保留的學習草稿')
    for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 420 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await expect(composer).toBeInViewport({ ratio: 1 })
      await expect(page.locator('[data-chat-send]')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('[data-floating-chat-close]')).toBeInViewport({ ratio: 1 })
      await expect(composer).toHaveValue('旋轉畫面後仍保留的學習草稿')
      await expect(page.locator('[data-chat-connection="connected"]')).toBeVisible()
    }
    expect(connections).toBe(1)
    await composer.focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('[data-chat-stickers]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-chat-sticker="tea"]')).toBeVisible()
    await page.locator('[data-floating-chat-close]').click()
    await reopenChat(page)
    await expect(composer).toHaveValue('旋轉畫面後仍保留的學習草稿')
    await expect(page.locator('[data-chat-connection="connected"]')).toBeVisible()
    expect(connections).toBe(2)
    await writeFile(join(evidence, 'rotation.json'), JSON.stringify({ connections, viewports: ['390x844', '844x390', '390x420', '390x844'], note: 'Reduced viewport tests layout response; this is not a native mobile virtual-keyboard claim.' }, null, 2))
  } finally { await context.close() }
})

for (const [width, height] of [[1440, 1000], [1024, 768], [768, 1024], [390, 844], [375, 812], [320, 568], [844, 390]]) {
  test(`chat remains within ${width}x${height} viewport and keeps input reachable`, async ({ browser }) => {
    for (const style of ['studio', 'cinematic']) {
      const context = await learner(browser, process.env.CHAT_E2E_USER_ONE, style)
      try {
        const page = await context.newPage()
        await page.setViewportSize({ width, height })
        await openChat(page)
        await expect(page.locator('html')).toHaveAttribute('data-theme', style)
        const panel = page.locator('[data-floating-chat]')
        const box = await panel.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(-1)
        expect(box!.y).toBeGreaterThanOrEqual(-1)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
        expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1)
        await expect(page.locator('[data-chat-composer]')).toBeInViewport({ ratio: 1 })
        await expect(page.locator('[data-chat-send]')).toBeInViewport({ ratio: 1 })
        await page.locator('[data-floating-chat-close]').click({ trial: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await mkdir(evidence, { recursive: true })
        await page.screenshot({ path: join(evidence, `chat-${style}-${width}x${height}.png`), fullPage: true })
        await writeFile(join(evidence, `geometry-${style}-${width}x${height}.json`), JSON.stringify({ style, viewport: { width, height }, chat: box }, null, 2))
      } finally { await context.close() }
    }
  })
}
