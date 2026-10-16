vi.mock('../backgrounds/staticDefinitions', async () => import('../../test/fixtures/staticBackgrounds'))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { usePreferences } from '../../stores/preferences'
import { createBackgroundStore } from '../backgrounds/store'
import { listStaticBackgrounds } from '../backgrounds/catalogue'
import { createAccountFocusRepository } from '../focus/accountRepository'
import type { FocusSessionRecord } from '../focus/types'
import { captureAccountPreferences } from './accountPreferences'
import { resetAccountSession, useAccountSession } from './session'
import { createWorkspaceAccountSync } from './workspaceSync'

const cleanup: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); resetAccountSession(); localStorage.clear() })
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); resetAccountSession(); vi.useRealTimers(); vi.unstubAllGlobals() })
it.each([false, true])('restores settings, multi-selection and Focus at workspace startup (legacy profile: %s)', async legacy => {
  const preferences = usePreferences(), player = { volume: ref(.4), setVolume(value: number) { this.volume.value = value } }
  preferences.setLocale('en'); preferences.setVisualStyle('cinematic')
  const session = useAccountSession()
  const focus = createAccountFocusRepository(session.userId)
  cleanup.push(focus.destroy)
  const record: FocusSessionRecord = { id: '11111111-1111-4111-8111-111111111111', schemaVersion: 1, phase: 'focus',
    startedAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T00:01:00.000Z', createdAt: '2026-10-16T00:01:00.000Z',
    plannedFocusSeconds: 60, actualFocusSeconds: 60, status: 'completed' }
  let saved = { ...captureAccountPreferences(preferences, player), locale: 'zh-Hant' as const, visualStyle: 'studio' as const,
    backgroundPlaybackMode: 'sequential' as const, backgroundQualityMode: '1440p' as const }
  if (legacy) {
    delete (saved as Partial<typeof saved>).backgroundPlaybackMode
    delete (saved as Partial<typeof saved>).backgroundQualityMode
  }
  const remoteRecords = [record]
  const requests: { path: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET'
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body: payload })
    if (path === '/api/session') return Response.json({ user: { id: 'account-A' } })
    if (path === '/api/account/ui-preferences') {
      if (method === 'PUT') saved = payload.preferences
      return Response.json({ preferences: saved })
    }
    if (path.startsWith('/api/focus-sessions')) {
      if (method === 'POST') {
        const insertedIds: string[] = []
        for (const value of payload.sessions as FocusSessionRecord[]) {
          if (!remoteRecords.some(record => record.id === value.id)) { remoteRecords.push(value); insertedIds.push(value.id) }
        }
        return Response.json({ insertedIds, duplicateIds: [] })
      }
      return Response.json({ sessions: remoteRecords })
    }
    return new Response(null, { status: 404 })
  })
  const choices = ['zzz-belle-lofi-girl', listStaticBackgrounds().find(b => b.id !== 'zzz-belle-lofi-girl')!.id]
  let remoteSelection = { selectedIds: choices, autoRotate: true, intervalSeconds: 600 as const }
  const writes: typeof remoteSelection[] = []
  const backgrounds = createBackgroundStore({ repository: { list: async () => listStaticBackgrounds(),
    getAccountSelection: async () => remoteSelection,
    saveAccountSelection: async value => { remoteSelection = value as typeof remoteSelection; writes.push(remoteSelection); return value },
  } })
  backgrounds.setPlaybackMode('sequential')
  backgrounds.setQualityMode('native')
  cleanup.push(backgrounds.destroy)
  const sync = createWorkspaceAccountSync({ preferences, player, backgrounds, focus }); cleanup.push(sync.destroy)
  await flushPromises()
  expect(preferences.locale.value).toBe('zh-Hant')
  expect(preferences.visualStyle.value).toBe('studio')
  expect(backgrounds.selection.value.selectedIds).toEqual(choices)
  expect(backgrounds.qualityMode.value).toBe(legacy ? 'native' : '1440p')
  expect(await focus.repository.list()).toEqual([record])
  expect(requests.filter(r => r.method === 'PUT' || r.method === 'POST')).toHaveLength(legacy ? 1 : 0)
  // Minute-by-minute account/catalogue refreshes must not restart a ten-minute
  // rotation deadline or choose a different preloaded Random target.
  await vi.advanceTimersByTimeAsync(600_000)
  expect(backgrounds.current.value?.id).toBe(choices[1])
  preferences.setStudioBlur(20); player.setVolume(.7)
  backgrounds.toggle(choices[1], false)
  const completed = { ...record, id: '22222222-2222-4222-8222-222222222222' }
  focus.claimRun(completed.id); await focus.timerRepository.recordIfAbsent(completed)
  await vi.advanceTimersByTimeAsync(800); await flushPromises()
  expect(saved.studioBlur).toBe(20); expect(saved.volume).toBe(.7)
  expect(writes.at(-1)?.selectedIds).toEqual(['zzz-belle-lofi-girl'])
  expect(remoteRecords.map(record => record.id)).toContain(completed.id)
})
