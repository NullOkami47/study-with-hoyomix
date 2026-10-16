import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAccountSession, useAccountSession } from '../account/session'

import { createFocusSessionRepository } from './localRepository'
import {
  createRemoteFocusSessionRepository,
  syncLocalFocusSessions,
  syncFocusSessionsAcrossDevices,
} from './remoteRepository'
import type { FocusSessionRecord } from './types'
import { deriveFocusStatistics } from './statistics'

const record = (overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:25:00.000Z',
  plannedFocusSeconds: 1_500,
  actualFocusSeconds: 1_500,
  status: 'completed',
  phase: 'focus',
  createdAt: '2026-08-25T00:25:00.000Z',
  ...overrides,
})

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

async function seededRepository(records: FocusSessionRecord[]) {
  const repository = createFocusSessionRepository({ indexedDB: undefined })
  for (const value of records) await repository.recordIfAbsent(value)
  return repository
}

beforeEach(() => { resetAccountSession() })

describe('remote focus session repository', () => {
  it('does not continue downloading across an account switch', async () => {
    useAccountSession().publish(true, 'account-a')
    const fetchImpl = vi.fn(async () => {
      useAccountSession().publish(true, 'account-b')
      return jsonResponse({ sessions: [record()], nextCursor: record().id })
    })
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })
    await expect(remote.load()).rejects.toThrow('focus_session_account_changed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not upload local records or restore account records after signing out during download', async () => {
    const local = await seededRepository([record()])
    useAccountSession().publish(true, 'account-a')
    const remote = {
      load: async () => {
        useAccountSession().publish(false)
        return [record({ id: '660e8400-e29b-41d4-a716-446655440000' })]
      },
      merge: vi.fn(),
    }
    await expect(syncFocusSessionsAcrossDevices(local, remote)).rejects.toThrow('focus_session_account_changed')
    expect(remote.merge).not.toHaveBeenCalled()
    expect(await local.list()).toEqual([record()])
  })

  it('binds upload requests to the account that started the operation', async () => {
    useAccountSession().publish(true, 'account-a')
    const fetchImpl = vi.fn(async () => jsonResponse({ insertedIds: [record().id], duplicateIds: [] }))
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })
    await remote.merge([record()])
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-account-user-id')).toBe('account-a')
  })
  it('uploads more than 512 sessions in bounded batches without discarding any', async () => {
    const sessions = Array.from({ length: 513 }, (_, index) => record({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    }))
    const uploaded: FocusSessionRecord[] = []
    const remote = createRemoteFocusSessionRepository({ fetch: async (_path, init) => {
      const batch = JSON.parse(String(init?.body)).sessions as FocusSessionRecord[]
      expect(batch.length).toBeLessThanOrEqual(512)
      uploaded.push(...batch)
      return jsonResponse({ insertedIds: batch.map(item => item.id), duplicateIds: [] })
    } })
    const result = await remote.merge(sessions)
    expect(uploaded).toEqual(sessions)
    expect(result.insertedIds).toEqual(sessions.map(item => item.id))
  })

  it('downloads every page of a large account history', async () => {
    const sessions = Array.from({ length: 513 }, (_, index) => record({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    }))
    const paths: string[] = []
    const remote = createRemoteFocusSessionRepository({ fetch: async path => {
      paths.push(String(path))
      const after = new URL(String(path), 'https://study.example').searchParams.get('after')
      return jsonResponse(after === null
        ? { sessions: sessions.slice(0, 512), nextCursor: sessions[511]!.id }
        : { sessions: sessions.slice(512), nextCursor: null })
    } })
    expect(await remote.load()).toEqual(sessions)
    expect(paths).toHaveLength(2)
    expect(paths[1]).toContain(encodeURIComponent(sessions[511]!.id))
  })

  it('rejects divergent repeated IDs before uploading any batch', async () => {
    const fetchImpl = vi.fn()
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })
    await expect(remote.merge([record(), record({ status: 'interrupted', actualFocusSeconds: 600 })]))
      .rejects.toThrow('focus_session_conflict')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves local and concurrent records when a later upload batch fails', async () => {
    const sessions = Array.from({ length: 513 }, (_, index) => record({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    }))
    const local = await seededRepository(sessions)
    const concurrent = record({ id: '660e8400-e29b-41d4-a716-446655440000' })
    let posts = 0
    const remote = createRemoteFocusSessionRepository({ fetch: async (_path, init) => {
      if (init?.method !== 'POST') return jsonResponse({ sessions: [], nextCursor: null })
      posts += 1
      if (posts === 2) {
        await local.recordIfAbsent(concurrent)
        return jsonResponse({ error: 'offline' }, 503)
      }
      const batch = JSON.parse(String(init.body)).sessions as FocusSessionRecord[]
      return jsonResponse({ insertedIds: batch.map(item => item.id), duplicateIds: [] })
    } })
    await expect(syncFocusSessionsAcrossDevices(local, remote)).rejects.toThrow('remote_focus_503')
    expect(await local.list()).toHaveLength(514)
    expect(await local.list()).toContainEqual(concurrent)
  })

  it('keeps local history unchanged when downloading a later page fails', async () => {
    const local = await seededRepository([record()])
    const remoteRecord = record({ id: '660e8400-e29b-41d4-a716-446655440000' })
    const remote = createRemoteFocusSessionRepository({ fetch: async path =>
      String(path).includes('after=')
        ? jsonResponse({ error: 'offline' }, 503)
        : jsonResponse({ sessions: [remoteRecord], nextCursor: remoteRecord.id }),
    })
    await expect(syncFocusSessionsAcrossDevices(local, remote)).rejects.toThrow('remote_focus_503')
    expect(await local.list()).toEqual([record()])
  })

  it('rejects incomplete acknowledgements instead of reporting dropped sessions as synced', async () => {
    const remote = createRemoteFocusSessionRepository({ fetch: async () =>
      jsonResponse({ insertedIds: [], duplicateIds: [] }),
    })
    await expect(remote.merge([record()])).rejects.toThrow('invalid acknowledgement')
  })

  it('rejects divergent duplicate records downloaded from a legacy worker before any local write', async () => {
    const local = await seededRepository([])
    const remote = createRemoteFocusSessionRepository({ fetch: async () => jsonResponse({ sessions: [
      record(), record({ status: 'interrupted', actualFocusSeconds: 600 }),
    ] }) })
    await expect(syncFocusSessionsAcrossDevices(local, remote)).rejects.toThrow('focus_session_conflict')
    expect(await local.list()).toEqual([])
  })
  it('loads only the exact immutable schema over a same-origin credentialed request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sessions: [record()] }))
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })

    await expect(remote.load()).resolves.toEqual([record()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/focus-sessions?limit=512')
    expect(init.credentials).toBe('same-origin')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('rejects a remote envelope that adds a field or an aggregate', async () => {
    const extra = createRemoteFocusSessionRepository({
      fetch: async () => jsonResponse({ sessions: [record()], totalFocusSeconds: 1_500 }),
    })
    await expect(extra.load()).rejects.toThrow(/invalid shape/u)

    const polluted = createRemoteFocusSessionRepository({
      fetch: async () => jsonResponse({ sessions: [{ ...record(), trackId: 'private-track' }] }),
    })
    await expect(polluted.load()).rejects.toThrow()
  })

  it('merges immutable records and returns the exact inserted and duplicate identifiers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      insertedIds: [record().id],
      duplicateIds: [],
    }))
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })

    await expect(remote.merge([record()])).resolves.toEqual({
      insertedIds: [record().id],
      duplicateIds: [],
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ sessions: [record()] })
  })

  it('never uploads an aggregate or a mutable counter', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ insertedIds: [], duplicateIds: [record().id] }))
    const remote = createRemoteFocusSessionRepository({ fetch: fetchImpl })

    await remote.merge([record()])

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const uploaded = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(Object.keys(uploaded)).toEqual(['sessions'])
    const serialised = String(init.body)
    for (const forbidden of ['totalFocusSeconds', 'completedSessionCount', 'currentStreakDays', 'trackId', 'provider']) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('surfaces a divergent remote conflict as a typed error', async () => {
    const remote = createRemoteFocusSessionRepository({
      fetch: async () => jsonResponse({ error: 'focus_session_conflict', id: record().id }, 409),
    })

    await expect(remote.merge([record()])).rejects.toThrow('remote_focus_409')
  })

  it('keeps local history intact when authenticated focus sync fails', async () => {
    const local = await seededRepository([record()])
    const remote = createRemoteFocusSessionRepository({
      fetch: async () => new Response('offline', { status: 503 }),
    })

    await expect(syncLocalFocusSessions(local, remote)).rejects.toThrow('remote_focus_503')
    await expect(local.list()).resolves.toEqual([record()])
  })

  it('uploads exactly the validated local records on an explicit sync', async () => {
    const local = await seededRepository([record()])
    const merge = vi.fn(async () => ({ insertedIds: [record().id], duplicateIds: [] }))

    await expect(syncLocalFocusSessions(local, { load: vi.fn(), merge })).resolves.toEqual({
      insertedIds: [record().id],
      duplicateIds: [],
    })
    expect(merge).toHaveBeenCalledWith([record()])
  })

  it('restores remote-only sessions and uploads local-only sessions on explicit two-way sync', async () => {
    const localRecord = record()
    const remoteRecord = record({
      id: '550e8400-e29b-41d4-a716-446655440001',
      startedAt: '2026-08-25T01:00:00.000Z',
      endedAt: '2026-08-25T01:25:00.000Z',
      createdAt: '2026-08-25T01:25:00.000Z',
    })
    const local = await seededRepository([localRecord])
    const merge = vi.fn(async () => ({ insertedIds: [localRecord.id], duplicateIds: [] }))
    const remote = { load: vi.fn(async () => [remoteRecord]), merge }
    await expect(syncFocusSessionsAcrossDevices(local, remote)).resolves.toEqual({
      insertedIds: [localRecord.id], duplicateIds: [], downloadedCount: 1,
    })
    expect(merge).toHaveBeenCalledWith([localRecord])
    expect((await local.list()).map(item => item.id).sort()).toEqual([localRecord.id, remoteRecord.id].sort())
  })

  it('downloads account Focus history to a new device even when it has no local sessions', async () => {
    const local = await seededRepository([])
    const remote = { load: vi.fn(async () => [record()]), merge: vi.fn() }
    await expect(syncFocusSessionsAcrossDevices(local, remote)).resolves.toEqual({
      insertedIds: [], duplicateIds: [], downloadedCount: 1,
    })
    expect(remote.merge).not.toHaveBeenCalled()
    expect(await local.list()).toEqual([record()])
  })

  it('retains concurrent local records and derives completed/interrupted statistics after restore', async () => {
    const local = await seededRepository([])
    const interrupted = record({ id: '660e8400-e29b-41d4-a716-446655440000', status: 'interrupted', actualFocusSeconds: 600 })
    const remote = {
      load: async () => {
        await local.recordIfAbsent(interrupted)
        return [record()]
      },
      merge: vi.fn(),
    }
    await syncFocusSessionsAcrossDevices(local, remote)
    const sessions = await local.list()
    expect(sessions).toHaveLength(2)
    const statistics = deriveFocusStatistics(sessions, { now: '2026-08-25T03:00:00.000Z', timeZone: 'UTC' })
    expect(statistics.completedSessionCount).toBe(1)
    expect(statistics.totalFocusSeconds).toBe(2100)
    expect(statistics.today.sessionCount).toBe(2)
    expect(statistics.today.completedSessionCount).toBe(1)
    expect(statistics.calendarDays.find(day => day.dayKey === '2026-08-25')?.sessionCount).toBe(2)
  })

  it('refuses to overwrite divergent immutable Focus records', async () => {
    const local = await seededRepository([record()])
    const conflict = record({ actualFocusSeconds: 700, status: 'interrupted' })
    const remote = { load: vi.fn(async () => [conflict]), merge: vi.fn() }
    await expect(syncFocusSessionsAcrossDevices(local, remote)).rejects.toThrow('focus_session_conflict')
    expect(remote.merge).not.toHaveBeenCalled()
    expect(await local.list()).toEqual([record()])
  })

  it('does not sync when the local history is empty', async () => {
    const local = await seededRepository([])
    const merge = vi.fn(async () => ({ insertedIds: [], duplicateIds: [] }))

    await expect(syncLocalFocusSessions(local, { load: vi.fn(), merge })).resolves.toEqual({
      insertedIds: [],
      duplicateIds: [],
    })
    expect(merge).not.toHaveBeenCalled()
  })
})
