import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import CatalogueDiscovery from './CatalogueDiscovery.vue'
import { createAdminRepository, type AdminDiscoveryStatus } from './client'
import { usePreferences } from '../../stores/preferences'
const candidate = {
  id: 'hoyo-test',
  trackId: 'hoyo-test',
  discovery: {
    videoId: 'abcdefghijk',
    title: 'New Dawn',
    album: 'New Album',
    games: ['genshin'],
    evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
  },
  suggestion: {
    games: ['genshin'],
    album: 'New Album',
    aliases: {},
    relation_ids: [],
    work_group_id: 'work-hoyo-test',
    vocal_status: 'uncertain',
    tabs: [],
    evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
    reasons: ['Official release metadata'],
    confidence: 0.5,
    uncertainties: ['listening_review_required'],
    adapter: 'deterministic',
  },
  classificationReviewed: false,
  sources: [
    {
      provider: 'youtube',
      externalId: 'abcdefghijk',
      status: 'unavailable',
      checkedAt: 1,
      reason: 'not_embeddable',
      confidence: 0,
    },
  ],
  conflicts: [],
  revision: 1,
  stageState: 'pending',
  createdAt: 1,
  updatedAt: 1,
} as any
const status = {
  candidates: [candidate],
  runs: [
    {
      runId: 'run-one',
      createdAt: 1,
      discovered: 1,
      added: 1,
      repeated: 0,
      outcome: 'completed',
    },
  ],
  configured: true,
  sheetsConfigured: true,
  ingestionConfigured: false,
  channelIds: ['UC-official'],
  adapters: [
    { id: 'deterministic', available: true, mode: 'fallback' },
    { id: 'gemini-spark', available: false, mode: 'manual-import-only' },
  ],
  catalogueRevision: 1,
} as AdminDiscoveryStatus
beforeEach(() => usePreferences().setLocale('zh-Hant'))
describe('catalogue discovery UI', () => {
  it('shows classification uncertainty, stable source ID and run history without publishing controls', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'getDiscoveryStatus').mockResolvedValue(status)
    const wrapper = mount(CatalogueDiscovery, { props: { repository: repo } })
    await flushPromises()
    expect(wrapper.text()).toContain('新曲探索')
    expect(wrapper.text()).toContain('New Dawn')
    expect(wrapper.text()).toContain('abcdefghijk')
    expect(wrapper.text()).toContain('run-one')
    expect(wrapper.text()).toContain('50%')
    expect(
      wrapper.find('[data-discovery-stage]').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.find('[data-catalogue-publish]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('runs the scan, refreshes results and edits structured suggestions for human review', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'getDiscoveryStatus').mockResolvedValue(status)
    const scan = vi.spyOn(repo, 'scanDiscovery').mockResolvedValue({})
    const update = vi
      .spyOn(repo, 'updateDiscoveryCandidate')
      .mockResolvedValue({
        ...candidate,
        classificationReviewed: true,
        revision: 2,
      })
    const wrapper = mount(CatalogueDiscovery, { props: { repository: repo } })
    await flushPromises()
    await wrapper.get('[data-discovery-scan]').trigger('click')
    await flushPromises()
    expect(scan).toHaveBeenCalledOnce()
    await wrapper.get('[data-discovery-edit]').trigger('click')
    const s = {
      ...candidate.suggestion,
      vocal_status: 'vocal',
      tabs: ['focus'],
      uncertainties: [],
    }
    await wrapper
      .get('[id="discovery-suggestion-hoyo-test"]')
      .setValue(JSON.stringify(s))
    await wrapper.get('[data-discovery-save]').trigger('click')
    await flushPromises()
    expect(update).toHaveBeenCalledWith('hoyo-test', { suggestion: s }, 1)
    wrapper.unmount()
  })
})


describe('discovery AI artefact revisions', () => {
  const artefact = (revision?: number) => ({
    schemaVersion: 1,
    adapter: 'imported-json',
    suggestions: [
      {
        ...candidate.suggestion,
        videoId: candidate.discovery.videoId,
        ...(revision === undefined ? {} : { revision }),
      },
    ],
  })
  const response = (value: unknown, code = 200) =>
    new Response(JSON.stringify(value), {
      status: code,
      headers: { 'content-type': 'application/json' },
    })

  it.each([1, undefined])(
    'keeps artefact revision %s unchanged so server rejection protects the current manual edit',
    async (revision) => {
      const manualCandidate = {
        ...candidate,
        revision: 4,
        classificationReviewed: true,
        suggestion: { ...candidate.suggestion, album: 'Manually reviewed album' },
      }
      const fetcher = vi.fn<typeof fetch>(async (_path, init) => {
        if (init?.method === 'POST')
          return response({ error: 'stale_candidate' }, 409)
        return response({ ...status, candidates: [manualCandidate] })
      })
      const repo = createAdminRepository({ fetch: fetcher })
      const wrapper = mount(CatalogueDiscovery, { props: { repository: repo } })
      await flushPromises()
      const payload = artefact(revision)
      const input = JSON.stringify(payload)
      await wrapper.get('#discovery-import-mode').setValue('suggestions')
      await wrapper.get('[data-discovery-import-json]').setValue(input)
      await wrapper.get('[data-discovery-import]').trigger('click')
      await flushPromises()
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(writes).toHaveLength(1)
      expect(writes[0][0]).toBe('/api/admin/catalogue/discovery/suggestions')
      expect(JSON.parse(String(writes[0][1]?.body))).toEqual(payload)
      expect(wrapper.get('[role="alert"]').text()).not.toBe('')
      expect(wrapper.text()).toContain('Manually reviewed album')
      expect((wrapper.get('[data-discovery-import-json]').element as HTMLTextAreaElement).value).toBe(input)
      // No silent manual-review PATCH or retry with a refreshed revision.
      expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1)
      wrapper.unmount()
    },
  )

  it('passes a current artefact unchanged and clears the input only after success', async () => {
    const payload = artefact(4)
    const fetcher = vi.fn<typeof fetch>(async (_path, init) =>
      init?.method === 'POST'
        ? response({ imported: 1 })
        : response({ ...status, candidates: [{ ...candidate, revision: 4 }] }),
    )
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    await wrapper.get('#discovery-import-mode').setValue('suggestions')
    await wrapper.get('[data-discovery-import-json]').setValue(JSON.stringify(payload))
    await wrapper.get('[data-discovery-import]').trigger('click')
    await flushPromises()
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual(payload)
    expect((wrapper.get('[data-discovery-import-json]').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
})


describe('candidate recording-identity drafts', () => {
  function conflictingCandidates() {
    return ['recording-a', 'recording-b'].map((id, index) => ({
      ...candidate,
      id,
      trackId: id,
      revision: index === 0 ? 4 : 7,
      discovery: {
        ...candidate.discovery,
        videoId: index === 0 ? 'abcdefghijk' : 'bcdefghijkl',
      },
      conflicts: ['recording_identity_conflict'],
    }))
  }
  const response = (value: unknown, code = 200) =>
    new Response(JSON.stringify(value), {
      status: code,
      headers: { 'content-type': 'application/json' },
    })
  const identityButton = (card: Pick<DOMWrapper<Element>, 'findAll'>) =>
    card.findAll('button').find((button) => button.text() === '記錄身分判定')!

  it('isolates two same-title cards and submits only the chosen candidate draft and revision', async () => {
    const candidates = conflictingCandidates()
    const fetcher = vi.fn<typeof fetch>(async (_path, init) =>
      response(init?.method ? candidates[1] : { ...status, candidates }),
    )
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    const first = wrapper.get('[data-discovery-candidate="recording-a"]')
    const second = wrapper.get('[data-discovery-candidate="recording-b"]')
    expect(first.get('h4').text()).toBe(second.get('h4').text())
    await first.get('#identity-target-recording-a').setValue('canonical-a')
    await first.get('#identity-reason-recording-a').setValue('Evidence for recording A')
    expect((second.get('input').element as HTMLInputElement).value).toBe('')
    expect((second.get('#identity-reason-recording-b').element as HTMLInputElement).value).toBe('')
    expect(identityButton(second).attributes('disabled')).toBeDefined()
    await second.get('#identity-target-recording-b').setValue('  canonical-b  ')
    await second.get('#identity-reason-recording-b').setValue('  Evidence for recording B  ')
    expect((first.get('input').element as HTMLInputElement).value).toBe('canonical-a')
    expect((first.get('#identity-reason-recording-a').element as HTMLInputElement).value).toBe('Evidence for recording A')
    await identityButton(second).trigger('click')
    await flushPromises()
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('/api/admin/catalogue/discovery/recording-b/resolve')
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      revision: 7,
      trackId: 'canonical-b',
      reason: 'Evidence for recording B',
    })
    wrapper.unmount()
  })

  it('clears a successful decision even when refresh fails and leaves the other draft isolated', async () => {
    const candidates = conflictingCandidates()
    let committed = false
    const fetcher = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method) {
        committed = true
        return response({ ...candidates[0], revision: 5, conflicts: [] })
      }
      if (committed) throw new Error('status unavailable')
      return response({ ...status, candidates })
    })
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    const first = wrapper.get('[data-discovery-candidate="recording-a"]')
    const second = wrapper.get('[data-discovery-candidate="recording-b"]')
    await first.get('#identity-target-recording-a').setValue('canonical-a')
    await first.get('#identity-reason-recording-a').setValue('Evidence A')
    await second.get('#identity-target-recording-b').setValue('canonical-b')
    await second.get('#identity-reason-recording-b').setValue('Evidence B')
    await identityButton(first).trigger('click')
    await flushPromises()
    expect((first.get('input').element as HTMLInputElement).value).toBe('')
    expect((first.get('#identity-reason-recording-a').element as HTMLInputElement).value).toBe('')
    expect(identityButton(first).attributes('disabled')).toBeDefined()
    expect((second.get('input').element as HTMLInputElement).value).toBe('canonical-b')
    expect((second.get('#identity-reason-recording-b').element as HTMLInputElement).value).toBe('Evidence B')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1)
    wrapper.unmount()
  })

  it('clears both identity drafts on a successful scan refresh without submitting either decision', async () => {
    const candidates = conflictingCandidates()
    const fetcher = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method) {
        for (const item of candidates) item.revision += 1
        return response({})
      }
      return response({ ...status, candidates })
    })
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    for (const item of candidates) {
      await wrapper.get('#identity-target-' + item.id).setValue('target-' + item.id)
      await wrapper.get('#identity-reason-' + item.id).setValue('Reason for ' + item.id)
    }
    await wrapper.get('[data-discovery-scan]').trigger('click')
    await flushPromises()
    for (const item of candidates) {
      const card = wrapper.get('[data-discovery-candidate="' + item.id + '"]')
      expect((card.get('input').element as HTMLInputElement).value).toBe('')
      expect((card.get('#identity-reason-' + item.id).element as HTMLInputElement).value).toBe('')
      expect(identityButton(card).attributes('disabled')).toBeDefined()
    }
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('/api/admin/catalogue/discovery/scan')
    wrapper.unmount()
  })

  it('requires the chosen card reason and keeps a blank target as its own distinct recording', async () => {
    const candidates = conflictingCandidates()
    const fetcher = vi.fn<typeof fetch>(async (_path, init) =>
      response(init?.method ? candidates[1] : { ...status, candidates }),
    )
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    const first = wrapper.get('[data-discovery-candidate="recording-a"]')
    const second = wrapper.get('[data-discovery-candidate="recording-b"]')
    await first.get('#identity-target-recording-a').setValue('canonical-a')
    await first.get('#identity-reason-recording-a').setValue('Evidence A')
    await second.get('#identity-reason-recording-b').setValue('   ')
    expect(identityButton(second).attributes('disabled')).toBeDefined()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0)
    await second.get('#identity-reason-recording-b').setValue('  Different recording B  ')
    await identityButton(second).trigger('click')
    await flushPromises()
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('/api/admin/catalogue/discovery/recording-b/resolve')
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      revision: 7,
      trackId: 'recording-b',
      reason: 'Different recording B',
    })
    expect(identityButton(first).attributes('disabled')).toBeDefined()
    expect(identityButton(second).attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('does not retry a stale identity decision with the refreshed revision without a new manual submission', async () => {
    const candidates = conflictingCandidates()
    let decisions = 0
    const fetcher = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method) {
        decisions += 1
        if (decisions === 1) {
          candidates[0] = { ...candidates[0], revision: 5 }
          return response({ error: 'stale_candidate' }, 409)
        }
        return response({ ...candidates[0], revision: 6, conflicts: [] })
      }
      return response({ ...status, candidates })
    })
    const wrapper = mount(CatalogueDiscovery, {
      props: { repository: createAdminRepository({ fetch: fetcher }) },
    })
    await flushPromises()
    const first = wrapper.get('[data-discovery-candidate="recording-a"]')
    await first.get('#identity-target-recording-a').setValue('canonical-a')
    await first.get('#identity-reason-recording-a').setValue('Original evidence A')
    await identityButton(first).trigger('click')
    await flushPromises()
    expect(decisions).toBe(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect((first.get('input').element as HTMLInputElement).value).toBe('')
    expect((first.get('#identity-reason-recording-a').element as HTMLInputElement).value).toBe('')
    expect(identityButton(first).attributes('disabled')).toBeDefined()
    const originalWrite = fetcher.mock.calls.find(([, init]) => init?.method)!
    expect(JSON.parse(String(originalWrite[1]?.body))).toEqual({
      revision: 4,
      trackId: 'canonical-a',
      reason: 'Original evidence A',
    })
    await first.get('#identity-reason-recording-a').setValue('Rechecked distinct recording A')
    await identityButton(first).trigger('click')
    await flushPromises()
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method)
    expect(writes).toHaveLength(2)
    expect(JSON.parse(String(writes[1][1]?.body))).toEqual({
      revision: 5,
      trackId: 'recording-a',
      reason: 'Rechecked distinct recording A',
    })
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

})
