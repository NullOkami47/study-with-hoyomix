import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DataControls from '../account/DataControls.vue'
import MergeDialog from './MergeDialog.vue'
import {
  createRemoteLibraryRepository,
  type RemoteLibraryRepository,
  type RemoteMergeEnvelope,
} from './remoteRepository'
import { createEmptyLocalLibrary, type LibraryExport } from './types'
import { createLocalLibraryRepository } from './localRepository'
import { createFocusSessionRepository } from '../focus/localRepository'
import { usePreferences } from '../../stores/preferences'

const localLibrary = (): LibraryExport => ({
  ...createEmptyLocalLibrary(),
  favourites: [{ trackId: 'local-track', addedAt: '2026-08-12T00:00:00.000Z' }],
})

const mergeEnvelope = (): RemoteMergeEnvelope => ({
  confirmationToken: `sha256:${'a'.repeat(64)}`,
  preview: {
    merged: localLibrary(),
    addedFavouriteTrackIds: ['local-track'],
    addedPlaylistIds: [],
    playlistConflicts: [],
    preferenceConflicts: [],
    historyConflicts: [],
    addedHistoryIds: [],
  },
})

const remoteStub = (overrides: Partial<RemoteLibraryRepository> = {}): RemoteLibraryRepository => ({
  load: vi.fn(async () => createEmptyLocalLibrary()),
  previewMerge: vi.fn(async () => mergeEnvelope()),
  confirmMerge: vi.fn(async (_library, _token) => localLibrary()),
  recordHistory: vi.fn(async () => []),
  clearHistory: vi.fn(async () => undefined),
  exportAccountData: vi.fn(async () => ({})),
  deleteAccount: vi.fn(async () => undefined),
  ...overrides,
})

describe('remote library merge contract', () => {
  it('requests a detached preview first and sends the confirmation token only on explicit confirmation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if ('confirmationToken' in body) return Response.json({ library: localLibrary() })
      return Response.json(mergeEnvelope())
    })
    const repository = createRemoteLibraryRepository({ fetch: fetcher as typeof fetch })
    const local = localLibrary()

    const envelope = await repository.previewMerge(local)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ library: local })
    expect(envelope).toEqual(mergeEnvelope())

    envelope.preview.merged.favourites[0]!.trackId = 'mutated-view-only'
    expect(local.favourites[0]?.trackId).toBe('local-track')

    const merged = await repository.confirmMerge(local, envelope.confirmationToken)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      library: local,
      confirmationToken: `sha256:${'a'.repeat(64)}`,
    })
    expect(merged.favourites[0]?.trackId).toBe('local-track')
  })

  it('fails closed when a remote preview contains malformed library data', async () => {
    const malformed = mergeEnvelope()
    malformed.preview.merged.preferences = { historyEnabled: false, oauthToken: 'secret' } as never
    const repository = createRemoteLibraryRepository({
      fetch: vi.fn(async () => Response.json(malformed)) as typeof fetch,
    })
    await expect(repository.previewMerge(localLibrary())).rejects.toThrow()
  })
})

describe('MergeDialog', () => {
  it('shows a preview and emits confirmation intent without writing by itself', async () => {
    const remote = remoteStub()
    const wrapper = mount(MergeDialog, { props: { localLibrary: localLibrary(), repository: remote } })
    await flushPromises()

    expect(remote.previewMerge).toHaveBeenCalledOnce()
    expect(remote.confirmMerge).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="merge-added-favourites"]').text()).toContain('1')

    await wrapper.get('[data-testid="confirm-library-merge"]').trigger('click')
    await flushPromises()
    expect(remote.confirmMerge).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toBe(`sha256:${'a'.repeat(64)}`)
  })

  it('can be cancelled without a write', async () => {
    const remote = remoteStub()
    const wrapper = mount(MergeDialog, { props: { localLibrary: localLibrary(), repository: remote } })
    await flushPromises()
    await wrapper.get('[data-testid="cancel-library-merge"]').trigger('click')
    expect(remote.confirmMerge).not.toHaveBeenCalled()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})

describe('DataControls', () => {
  beforeEach(() => { usePreferences().setLocale('en') })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('does not contact the backend on mount and requires exact typed deletion confirmation', async () => {
    const remote = remoteStub()
    const wrapper = mount(DataControls, { props: { repository: remote } })
    expect(remote.exportAccountData).not.toHaveBeenCalled()
    expect(remote.deleteAccount).not.toHaveBeenCalled()
    const button = wrapper.get('[data-testid="delete-account"]')
    for (const invalid of ['delete', 'DELETE ', 'Delete']) {
      await wrapper.get('[data-testid="delete-confirmation"]').setValue(invalid)
      expect(button.attributes('disabled')).toBeDefined()
    }
    await wrapper.get('[data-testid="delete-confirmation"]').setValue('DELETE')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(remote.deleteAccount).toHaveBeenCalledOnce()
    expect(wrapper.emitted('deleted')).toHaveLength(1)
    wrapper.unmount()
  })

  it('exports the account payload only on request and revokes the download URL', async () => {
    const exported = { schemaVersion: 1, uiPreferences: { locale: 'en' }, focusSessions: [] }
    const remote = remoteStub({ exportAccountData: vi.fn(async () => exported) })
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:account-export')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mount(DataControls, { props: { repository: remote } })
    expect(remote.exportAccountData).not.toHaveBeenCalled()
    const exportButton = wrapper.findAll('button').find(button => button.text() === 'Export account data')!
    await exportButton.trigger('click')
    await flushPromises()
    const blob = createObjectURL.mock.calls[0]![0]
    const json = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(JSON.parse(json)).toEqual(exported)
    expect(wrapper.get('[role="status"]').text()).toContain('export is ready')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:account-export')
    wrapper.unmount()
  })

  it('clears remote listening history before local history without clearing Focus', async () => {
    const local = createLocalLibraryRepository()
    await local.setHistoryEnabled(true)
    await local.recordRecent('private-track')
    const focus = createFocusSessionRepository()
    const clearFocus = vi.spyOn(focus, 'clear')
    const remote = remoteStub({ clearHistory: vi.fn(async () => {
      expect((await local.exportLocalLibrary()).recentHistory).toHaveLength(1)
    }) })
    const wrapper = mount(DataControls, { props: { repository: remote, localRepository: local, focusRepository: focus } })
    await wrapper.get('[data-testid="clear-synced-history"]').trigger('click')
    await flushPromises()
    expect((await local.exportLocalLibrary()).recentHistory).toEqual([])
    expect(clearFocus).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toContain('has been cleared')
    wrapper.unmount()
    local.destroy()
  })

  it('retains the local listening history when remote deletion fails', async () => {
    const local = createLocalLibraryRepository()
    await local.setHistoryEnabled(true)
    await local.recordRecent('private-track')
    const remote = remoteStub({ clearHistory: vi.fn(async () => { throw new Error('offline') }) })
    const wrapper = mount(DataControls, { props: { repository: remote, localRepository: local } })
    await wrapper.get('[data-testid="clear-synced-history"]').trigger('click')
    await flushPromises()
    expect((await local.exportLocalLibrary()).recentHistory).toHaveLength(1)
    expect(wrapper.get('[role="status"]').text()).toContain('could not')
    wrapper.unmount()
    local.destroy()
  })

  it('cleans local Focus only after authoritative remote account deletion', async () => {
    const focus = createFocusSessionRepository()
    let remotelyDeleted = false
    const clear = vi.spyOn(focus, 'clear').mockImplementation(async () => { expect(remotelyDeleted).toBe(true) })
    const remote = remoteStub({ deleteAccount: vi.fn(async () => { remotelyDeleted = true }) })
    const wrapper = mount(DataControls, { props: { repository: remote, focusRepository: focus } })
    await wrapper.get('[data-testid="delete-confirmation"]').setValue('DELETE')
    await wrapper.get('[data-testid="delete-account"]').trigger('click')
    await flushPromises()
    expect(clear).toHaveBeenCalledOnce()
    expect(wrapper.emitted('deleted')).toHaveLength(1)
    wrapper.unmount()
  })

  it('reports local Focus cleanup failure while preserving the authoritative remote deletion result', async () => {
    const focus = createFocusSessionRepository()
    vi.spyOn(focus, 'clear').mockRejectedValue(new Error('denied'))
    const wrapper = mount(DataControls, { props: { repository: remoteStub(), focusRepository: focus } })
    await wrapper.get('[data-testid="delete-confirmation"]').setValue('DELETE')
    await wrapper.get('[data-testid="delete-account"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('deleted')).toHaveLength(1)
    expect(wrapper.get('[role="status"]').text()).toContain('local Focus history could not be removed')
    wrapper.unmount()
  })

  it('does not clean local Focus or emit deletion when the remote account deletion fails', async () => {
    const focus = createFocusSessionRepository()
    const clear = vi.spyOn(focus, 'clear')
    const remote = remoteStub({ deleteAccount: vi.fn(async () => { throw new Error('offline') }) })
    const wrapper = mount(DataControls, { props: { repository: remote, focusRepository: focus } })
    await wrapper.get('[data-testid="delete-confirmation"]').setValue('DELETE')
    await wrapper.get('[data-testid="delete-account"]').trigger('click')
    await flushPromises()
    expect(clear).not.toHaveBeenCalled()
    expect(wrapper.emitted('deleted')).toBeUndefined()
    expect(wrapper.get('[role="status"]').text()).toContain('could not')
    wrapper.unmount()
  })

  it('does not expose the obsolete library merge sync action', () => {
    const remote = remoteStub()
    const wrapper = mount(DataControls, { props: { repository: remote } })
    expect(wrapper.find('[data-testid="begin-library-merge"]').exists()).toBe(false)
    expect(remote.previewMerge).not.toHaveBeenCalled()
    expect(wrapper.find('[data-account-preference-sync]').exists()).toBe(false)
    wrapper.unmount()
  })
})
