import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetAccountSession, useAccountSession } from './session'

beforeEach(resetAccountSession)
afterEach(() => { vi.unstubAllGlobals() })

it('exposes the authenticated identity from the authoritative session response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: { id: 'account-a' } })))
  const session = useAccountSession()
  await session.ensure()
  expect(session.userId.value).toBe('account-a')
  session.publish(true, 'account-b')
  expect(session.userId.value).toBe('account-b')
  session.publish(false)
  expect(session.userId.value).toBeNull()
})

it('does not let a session read that predates logout restore the old identity', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const session = useAccountSession()
  const pending = session.ensure()
  session.publish(false)
  finish(Response.json({ user: { id: 'old-account' } }))
  await pending
  expect(session.signedIn.value).toBe(false)
  expect(session.userId.value).toBeNull()
})

it('retains a verified identity during transient refresh failures and clears it on an authoritative 401', async () => {
  const session = useAccountSession()
  session.publish(true, 'account-a')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await session.refresh()
  expect(session.userId.value).toBe('account-a')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
  await session.refresh()
  expect(session.userId.value).toBe('account-a')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  await session.refresh()
  expect(session.userId.value).toBeNull()
})
