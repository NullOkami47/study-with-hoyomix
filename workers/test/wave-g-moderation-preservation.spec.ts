// Wave G preservation (task 26, Property 2; requirements 3.3, 3.9, 3.20). Observation-first: every
// expectation below was observed on the unfixed tree (8c23f12) and must still hold after 27.1.
// L-20 changes moderator deletes of equal- or higher-ranked authors (403) and the audit row count,
// so those inputs are deliberately left out: deletes here always come from an actor who outranks
// the author, and no test counts audit rows for delete or ban (the fix keeps one, D14).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import fc from 'fast-check'
import { readFile, readdir } from 'node:fs/promises'
import { Miniflare } from './miniflare-compat'
import { issueSession } from '../auth/session'

const origin = 'https://study.example'
const secret = 'wave-g-moderation-preservation-secret-at-least-32'
const ROLES = ['user', 'moderator', 'admin', 'owner'] as const
type Role = typeof ROLES[number]
const RANK: Record<Role, number> = { user: 0, moderator: 1, admin: 2, owner: 3 }
const DAY = 86_400_000
let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
const tokens: Record<string, string> = {}

const call = (route: string, user: string, method = 'GET', body?: unknown) =>
  runtime.dispatchFetch(origin + route, {
    method,
    headers: { origin, cookie: '__Host-session=' + tokens[user], 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const moderate = (actor: string, body: Record<string, unknown>) => call('/api/chat/moderation', actor, 'POST', body)
const seedMessage = async (id: string, author: string, content = 'Wave G preservation fixture', age = 0) => {
  const now = Date.now()
  await db.prepare("INSERT INTO chat_messages(id,user_id,author_display_name,content,message_type,created_at,expires_at) VALUES(?,?,?,?,'text',?,?)")
    .bind(id, author, author, content, now - age, now - age + 30 * DAY).run()
  await db.prepare("UPDATE chat_retention_state SET message_count=message_count+1 WHERE room_id='global'").run()
}
const reset = () => db.batch([
  db.prepare('DELETE FROM chat_reports'), db.prepare('DELETE FROM chat_message_versions'),
  db.prepare('DELETE FROM chat_request_receipts'), db.prepare('DELETE FROM chat_messages'),
  db.prepare('DELETE FROM chat_send_state'), db.prepare('DELETE FROM chat_bans'),
  db.prepare('DELETE FROM filter_rules'), db.prepare('DELETE FROM moderation_actions'),
  db.prepare('DELETE FROM admin_audit_log'),
  db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL WHERE room_id='global'"),
])

beforeAll(async () => {
  // Same disposable fixture as chat-policy-api.spec.ts: the real Worker and ChatRoom, with only the
  // autonomous alarm suppressed so seeded rows stay where the test put them.
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: "import worker,{ChatRoom as ProductionChatRoom} from './workers/index'; export default worker; export class ChatRoom extends ProductionChatRoom { async alarm(){} }" }, bundle: true, write: false, format: 'esm', platform: 'browser' })
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-12-01', durableObjects: { CHAT: { className: 'ChatRoom', useSQLite: true } }, d1Databases: { DB: 'wave-g-moderation-preservation' }, bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret } })
  db = await runtime.getD1Database('DB')
  for (const file of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) await db.batch((await readFile('migrations/' + file, 'utf8')).split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)))
  const now = Date.now()
  for (const role of ROLES) for (const prefix of ['actor', 'author']) {
    const id = `${prefix}-${role}`
    await db.prepare('INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, id, role, now, now).run()
    tokens[id] = (await issueSession(db as never, id, secret, now, crypto)).token
  }
})
beforeEach(async () => { await reset() })
afterAll(async () => { await runtime?.dispose() })

const actorRole = fc.constantFrom(...ROLES)
const targetRole = fc.constantFrom(...ROLES)
/** An author the actor outranks: outside the L-20 bug condition, allowed before and after the fix. */
const outrankedPair = fc.constantFrom(...ROLES.filter(r => r !== 'user'))
  .chain(actor => fc.tuple(fc.constant(actor), fc.constantFrom(...ROLES.filter(r => RANK[r] < RANK[actor]))))

describe('Wave G: ban, unban and moderator delete keep their rank rules (3.3, 3.9)', () => {
  it('bans and unbans exactly when the actor is staff and strictly outranks the target', async () => {
    await fc.assert(fc.asyncProperty(actorRole, targetRole, fc.constantFrom('ban', 'unban'), fc.boolean(), async (actor, target, action, temporary) => {
      await reset()
      const userId = `author-${target}`
      const now = Date.now()
      if (action === 'unban') await db.prepare("INSERT INTO chat_bans(id,user_id,actor_user_id,reason,expires_at,created_at) VALUES(?,?,'actor-owner','fixture',NULL,?)").bind(crypto.randomUUID(), userId, now).run()
      const expiresAt = temporary && action === 'ban' ? new Date(now + DAY).toISOString() : undefined
      const response = await moderate(`actor-${actor}`, { action, userId, ...(expiresAt ? { expiresAt } : {}) })
      const allowed = actor !== 'user' && RANK[target] < RANK[actor]
      expect(response.status).toBe(allowed ? 200 : 403)
      const ban = await db.prepare('SELECT expires_at AS expiresAt FROM chat_bans WHERE user_id=?').bind(userId).first<{ expiresAt: number | null }>()
      if (action === 'ban') {
        if (allowed) expect(ban).toEqual({ expiresAt: expiresAt ? Date.parse(expiresAt) : null })
        else expect(ban).toBeNull()
      } else if (allowed) expect(ban).toBeNull()
      else expect(ban).toEqual({ expiresAt: null })
    }), { numRuns: 40, endOnFailure: true })
  })

  it('lets moderators, admins and owners delete a message by an author they outrank, and records the message ID', async () => {
    await fc.assert(fc.asyncProperty(outrankedPair, async ([actor, author]) => {
      await reset()
      const id = `m-${actor}-${author}`
      await seedMessage(id, `author-${author}`)
      const response = await moderate(`actor-${actor}`, { action: 'delete', messageId: id })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(await db.prepare('SELECT deleted_at FROM chat_messages WHERE id=?').bind(id).first('deleted_at')).not.toBeNull()
      const history = await (await call('/api/chat', 'actor-user')).json() as { messages: Array<{ id: string; content: string; deletedAt: string | null }> }
      const shown = history.messages.find(m => m.id === id)
      if (shown) expect(shown).toMatchObject({ content: '', deletedAt: expect.any(String) })
      // At least one audit record names the message (the fix keeps exactly one; the count is L-20's).
      const audits = JSON.stringify([
        ...(await db.prepare('SELECT * FROM admin_audit_log').all()).results,
        ...(await db.prepare('SELECT * FROM moderation_actions').all()).results,
      ])
      expect(audits).toContain(id)
    }), { numRuns: 12, endOnFailure: true })
  })

  it('refuses every moderation action from a plain user and changes nothing', async () => {
    await fc.assert(fc.asyncProperty(targetRole, fc.constantFrom('delete', 'ban', 'unban', 'filter', 'remove_filter', 'settings'), async (author, action) => {
      await reset()
      await seedMessage('m-plain', `author-${author}`)
      const body: Record<string, unknown> = action === 'delete' ? { action, messageId: 'm-plain' }
        : action === 'filter' ? { action, filter: { id: 'f-plain', kind: 'literal', pattern: 'plain', enabled: true } }
          : action === 'remove_filter' ? { action, filterId: 'f-plain' }
            : action === 'settings' ? { action, intervalMs: 1000 } : { action, userId: `author-${author}` }
      expect((await moderate('actor-user', body)).status).toBe(403)
      expect(await db.prepare("SELECT deleted_at FROM chat_messages WHERE id='m-plain'").first('deleted_at')).toBeNull()
      for (const table of ['chat_bans', 'filter_rules', 'moderation_actions', 'admin_audit_log']) {
        expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'), table).toBe(0)
      }
    }), { numRuns: 15, endOnFailure: true })
  })

  it('keeps filter and settings management for admins and owners only', async () => {
    for (const role of ROLES) {
      await reset()
      const allowed = role === 'admin' || role === 'owner'
      const filter = await moderate(`actor-${role}`, { action: 'filter', filter: { id: 'f-role', kind: 'literal', pattern: 'wavegword', enabled: true } })
      expect(filter.status, role).toBe(allowed ? 200 : 403)
      expect(await db.prepare("SELECT COUNT(*) AS n FROM filter_rules WHERE id='f-role'").first('n')).toBe(allowed ? 1 : 0)
      const settings = await moderate(`actor-${role}`, { action: 'settings', intervalMs: 1500 })
      expect(settings.status, role).toBe(allowed ? 200 : 403)
      if (allowed) {
        expect((await moderate(`actor-${role}`, { action: 'remove_filter', filterId: 'f-role' })).status).toBe(200)
        expect(await db.prepare("SELECT COUNT(*) AS n FROM filter_rules WHERE id='f-role'").first('n')).toBe(0)
      }
    }
  })
})

describe('Wave G: authors delete their own messages under the existing rules (3.3)', () => {
  it('allows the author within five minutes, refuses after, and refuses everyone else', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...ROLES), fc.constantFrom(...ROLES), fc.boolean(), fc.boolean(), async (author, other, own, expired) => {
      await reset()
      const authorId = `author-${author}`
      await seedMessage('m-self', authorId, 'Own message fixture', expired ? 301_000 : 1_000)
      const caller = own ? authorId : `actor-${other}`
      const response = await call('/api/chat/messages/m-self', caller, 'DELETE')
      const deletedAt = await db.prepare("SELECT deleted_at FROM chat_messages WHERE id='m-self'").first('deleted_at')
      if (own && !expired) {
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(deletedAt).not.toBeNull()
      } else {
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ error: own ? 'edit_window_expired' : 'forbidden' })
        expect(deletedAt).toBeNull()
      }
    }), { numRuns: 30, endOnFailure: true })
  })
})

describe('Wave G: the U+001F reply marker stays server-owned and decoded everywhere (3.20)', () => {
  const withMarker = fc.tuple(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.constantFrom('\u001f', '\u001freply:abc\u001f', '\u001freply:'))
    .map(([before, after, mark]) => `${before}${mark}${after}`)

  it('rejects any user-typed text that carries the marker, on send and on edit', async () => {
    await fc.assert(fc.asyncProperty(withMarker, async (typed) => {
      await reset()
      const send = await call('/api/chat/messages', 'author-user', 'POST', { type: 'text', text: typed, requestId: 'marker-send' })
      expect(send.status).toBe(400)
      expect(await db.prepare('SELECT COUNT(*) AS n FROM chat_messages').first('n')).toBe(0)
      await seedMessage('m-edit', 'author-user', 'editable fixture')
      const edit = await call('/api/chat/messages/m-edit', 'author-user', 'PATCH', { text: typed })
      expect(edit.status).toBe(400)
      expect(await db.prepare("SELECT content FROM chat_messages WHERE id='m-edit'").first('content')).toBe('editable fixture')
    }), { numRuns: 15, endOnFailure: true })
  })

  it('decodes a real reply before masking in the public view and in every moderation view', async () => {
    await seedMessage('m-parent', 'author-moderator', 'parent fixture')
    expect((await moderate('actor-owner', { action: 'filter', filter: { id: 'f-reply', kind: 'literal', pattern: 'reply', enabled: true } })).status).toBe(200)
    const sent = await call('/api/chat/messages', 'author-user', 'POST', { type: 'text', text: 'hello wavegsecret', replyToId: 'm-parent', requestId: 'marker-reply' })
    expect(sent.status).toBe(201)
    const { message } = await sent.json() as { message: { id: string; content: string; replyToId: string | null } }
    expect(message).toMatchObject({ content: 'hello wavegsecret', replyToId: 'm-parent' })
    expect(await db.prepare('SELECT content FROM chat_messages WHERE id=?').bind(message.id).first('content')).toBe('\u001freply:m-parent\u001fhello wavegsecret')
    expect((await moderate('actor-owner', { action: 'filter', filter: { id: 'f-secret', kind: 'literal', pattern: 'wavegsecret', enabled: true } })).status).toBe(200)
    const history = await (await call('/api/chat', 'actor-user')).json() as { messages: Array<{ id: string; content: string; replyToId: string | null }> }
    expect(history.messages.find(m => m.id === message.id)).toMatchObject({ content: 'hello ***', replyToId: 'm-parent' })
    await db.prepare("INSERT INTO chat_reports(id,reporter_user_id,message_id,reason,created_at) VALUES('r-reply','author-admin',?,'fixture',?)").bind(message.id, Date.now()).run()
    const listing = await (await call('/api/chat/moderation', 'actor-moderator')).json() as { reports: Array<{ messageId: string; content: string }> }
    expect(listing.reports.find(r => r.messageId === message.id)?.content).toBe('hello wavegsecret')
    const detail = await (await call(`/api/chat/moderation/messages/${message.id}`, 'actor-moderator')).json() as { message: { content: string } }
    expect(detail.message.content).toBe('hello wavegsecret')
    expect(JSON.stringify([listing, detail])).not.toContain('\u001f')
  })
})
