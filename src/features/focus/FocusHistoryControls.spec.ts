import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import { createFocusSessionRepository } from './localRepository'
import type { FocusSessionRecord } from './types'
import FocusHistoryControls from './FocusHistoryControls.vue'

function focusRecord(): FocusSessionRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    schemaVersion: 1,
    startedAt: '2026-08-25T00:00:00.000Z',
    endedAt: '2026-08-25T00:25:00.000Z',
    plannedFocusSeconds: 1_500,
    actualFocusSeconds: 1_500,
    status: 'completed',
    phase: 'focus',
    createdAt: '2026-08-25T00:25:00.000Z',
  }
}

const createObjectURL = vi.fn((_blob: Blob) => 'blob:focus-history')
const revokeObjectURL = vi.fn()

beforeEach(() => {
  usePreferences().setLocale('en')
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FocusHistoryControls', () => {
  it('downloads the exact local export and revokes its temporary object URL', async () => {
    const repository = createFocusSessionRepository()
    await repository.recordIfAbsent(focusRecord())
    const wrapper = mount(FocusHistoryControls, { props: { repository } })

    await wrapper.get('[data-testid="focus-export"]').trigger('click')
    await flushPromises()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('application/json')
    const exported = JSON.parse(await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })) as { schemaVersion: number; sessions: FocusSessionRecord[] }
    expect(exported).toEqual({ schemaVersion: 1, sessions: [focusRecord()] })
    expect(wrapper.get('[data-testid="focus-clear-status"][role="status"]').text())
      .toContain('export is ready')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:focus-history')
  })

  it('requires a distinct confirmation before clearing only Focus history', async () => {
    const repository = createFocusSessionRepository()
    await repository.recordIfAbsent(focusRecord())
    const wrapper = mount(FocusHistoryControls, { props: { repository } })

    await wrapper.get('[data-testid="focus-clear"]').trigger('click')
    expect(await repository.list()).toHaveLength(1)
    expect(wrapper.get('[data-testid="focus-clear-confirm"]').text()).toContain('Confirm')

    await wrapper.get('[data-testid="focus-clear-confirm"]').trigger('click')
    await flushPromises()

    expect(await repository.list()).toEqual([])
    expect(wrapper.get('[data-testid="focus-clear-status"][role="status"]').text())
      .toContain('Focus history cleared')
  })

  it('delegates automatic immutable sync to the workspace lifecycle', async () => {
    const repository = createFocusSessionRepository()
    await repository.recordIfAbsent(focusRecord())
    const remoteRepository = {
      load: vi.fn(async () => []),
      merge: vi.fn(async () => ({ insertedIds: [focusRecord().id], duplicateIds: [] })),
    }
    const wrapper = mount(FocusHistoryControls, {
      props: { repository, remoteRepository, signedIn: true },
    })
    await flushPromises()

    expect(remoteRepository.merge).not.toHaveBeenCalled()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    await flushPromises()

    expect(remoteRepository.merge).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="focus-sync-status"][role="status"]').text())
      .toContain('synchronise automatically')
  })

  it('keeps local history available independently of the sync lifecycle', async () => {
    const repository = createFocusSessionRepository()
    const secondRecord = {
      ...focusRecord(),
      id: '55555555-5555-4555-8555-555555555555',
      startedAt: '2026-08-25T01:00:00.000Z',
      endedAt: '2026-08-25T01:25:00.000Z',
      createdAt: '2026-08-25T01:25:00.000Z',
    }
    await repository.recordIfAbsent(focusRecord())
    await repository.recordIfAbsent(secondRecord)
    const remoteRepository = {
      load: vi.fn(async () => []),
      merge: vi.fn(async () => { throw new Error('remote_focus_503') }),
    }
    const wrapper = mount(FocusHistoryControls, {
      props: { repository, remoteRepository, signedIn: true },
    })
    const beforeSync = await repository.list()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    await flushPromises()

    expect(await repository.list()).toEqual(beforeSync)
    expect(wrapper.get('[data-testid="focus-sync-status"][role="status"]').text())
      .toContain('synchronise automatically')
  })

  it('offers no sync control while anonymous', async () => {
    const repository = createFocusSessionRepository()
    const wrapper = mount(FocusHistoryControls, { props: { repository } })
    await flushPromises()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
  })

  it('does not start a competing download when mounted or signed out', async () => {
    const repository = createFocusSessionRepository()
    await repository.recordIfAbsent(focusRecord())
    let finishDownload!: (records: FocusSessionRecord[]) => void
    const remoteRepository = {
      load: () => new Promise<FocusSessionRecord[]>(resolve => { finishDownload = resolve }),
      merge: vi.fn(async () => ({ insertedIds: [], duplicateIds: [] })),
    }
    const wrapper = mount(FocusHistoryControls, { props: { repository, remoteRepository, signedIn: true } })
    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    await wrapper.setProps({ signedIn: false })
    expect(finishDownload).toBeUndefined()
    await flushPromises()
    expect(remoteRepository.merge).not.toHaveBeenCalled()
    expect(await repository.list()).toEqual([focusRecord()])
  })

  it('removes automatic-sync information when the account signs out', async () => {
    const repository = createFocusSessionRepository()
    const remoteRepository = {
      load: vi.fn(async () => []),
      merge: vi.fn(async () => ({ insertedIds: [], duplicateIds: [] })),
    }
    const wrapper = mount(FocusHistoryControls, {
      props: { repository, remoteRepository, signedIn: true },
    })

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)

    await wrapper.setProps({ signedIn: false })

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="focus-sync-status"]').exists()).toBe(false)
    expect(remoteRepository.merge).not.toHaveBeenCalled()
  })

  it('opens the calendar and distinguishes recoverable from fatal capacity status', async () => {
    const repository = createFocusSessionRepository()
    const wrapper = mount(FocusHistoryControls, {
      props: { repository, historyStatus: 'pending_overflow' },
    })

    expect(wrapper.get('[data-focus-storage-status][role="status"]').text())
      .toContain('only for this tab')
    expect(wrapper.get('[data-focus-history-status][role="status"]').text())
      .toMatch(/recoverable/iu)
    await wrapper.get('[data-testid="focus-open-calendar"]').trigger('click')
    expect(wrapper.emitted('open-calendar')).toHaveLength(1)

    await wrapper.setProps({ historyStatus: 'overflow_full' })
    const fatalStatus = wrapper.get('[data-focus-history-status][role="status"]').text()
    expect(fatalStatus).toMatch(/fatal/iu)
    expect(fatalStatus).toContain('could not be retained')
    expect(fatalStatus).not.toMatch(/no data loss|nothing was lost/iu)
  })
})
