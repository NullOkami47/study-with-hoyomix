import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import CatalogueManager from './CatalogueManager.vue'
import { createAdminRepository } from './client'
import type { ImportBatch } from '../../../workers/catalogue/types'
import { usePreferences } from '../../stores/preferences'
const proposal = {
  changeId: 'change-a',
  entityType: 'track' as const,
  entityKey: 'track-a',
  kind: 'metadata_change' as const,
  before: { title: 'Old' },
  after: { title: 'New' },
  validationState: 'valid' as const,
  messages: [],
  confidence: 0.95,
  decision: 'pending' as const,
}
const initial: ImportBatch = {
  batchId: 'batch-1',
  status: 'validated',
  baseRevision: 1,
  reviewRevision: 1,
  createdAt: 1788739200000,
  updatedAt: 1788739200000,
  publishedAt: null,
  summary: { metadata_change: 1 },
  changes: [proposal],
}
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => {
  usePreferences().setLocale('en')
})
afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers.length = 0
})
function setup(batch: ImportBatch | null = initial, role: 'admin' | 'owner' = 'admin') {
  const repo = createAdminRepository()
  const approveR2AsOwner = vi.spyOn(repo, 'approveCatalogueR2AsOwner')
    .mockImplementation(async () => ({ ...batch!, reviewRevision: batch!.reviewRevision + 1 }))
  vi.spyOn(repo, 'getCatalogueStatus').mockResolvedValue({
    configured: true,
    role,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/test-workbook/edit',
    serviceAccountEmail: 'catalogue@example.iam.gserviceaccount.com',
    lastBatch: batch,
  })
  vi.spyOn(repo, 'syncCatalogue').mockResolvedValue(initial)
  vi.spyOn(repo, 'exportCatalogueSheet').mockResolvedValue({ exported: true })
  vi.spyOn(repo, 'decideCatalogueChange').mockImplementation(async (_b, id, decision) => ({
    ...initial,
    changes: initial.changes.map((c) => ({
      ...c,
      decision: c.changeId === id ? decision : c.decision,
    })),
  }))
  vi.spyOn(repo, 'approveCatalogueHighConfidence').mockResolvedValue({
    ...initial,
    changes: [{ ...proposal, decision: 'approved' }],
  })
  vi.spyOn(repo, 'publishCatalogueBatch').mockResolvedValue({
    ...initial,
    status: 'published',
    changes: [{ ...proposal, decision: 'approved' }],
  })
  const wrapper = mount(CatalogueManager, { props: { repository: repo } })
  wrappers.push(wrapper)
  // The Sheet review pipeline now lives behind its own view; the catalogue browser is the default.
  void wrapper.get('[data-catalogue-view="review"]').trigger('click')
  return { repo, wrapper, approveR2AsOwner }
}
describe('diff-first catalogue manager', () => {
  it('shows staging-only status, summary and a safe Sheet link without auto publishing', async () => {
    const { repo, wrapper } = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('Staging only')
    expect(wrapper.get('[data-catalogue-sheet]').attributes('href')).toContain('docs.google.com')
    expect(wrapper.get('[data-catalogue-summary="metadata_change"]').text()).toContain('1')
    expect(wrapper.get('[data-catalogue-publish]').attributes('disabled')).toBeDefined()
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('PRIVATE KEY')
  })
  it('accepts explicitly, then publishes only on user action', async () => {
    const { repo, wrapper } = setup()
    await flushPromises()
    await wrapper.get('[data-catalogue-accept="change-a"]').trigger('click')
    await flushPromises()
    expect(repo.decideCatalogueChange).toHaveBeenCalledWith('batch-1', 'change-a', 'approved', 1)
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
    await wrapper.get('[data-catalogue-publish]').trigger('click')
    await flushPromises()
    expect(repo.publishCatalogueBatch).toHaveBeenCalledWith('batch-1', 1)
    expect(wrapper.text()).toContain('Published')
  })
  it('offers explicit R2 verification only to an Owner for an evidenced sole-owner blocker', async () => {
    const r2 = {
      ...proposal,
      changeId: 'r2-change', entityType: 'source' as const, entityKey: 'new-r2', kind: 'new_source' as const,
      after: { provider: 'r2', evidence: 'Owner-controlled object verification' },
      validationState: 'error' as const,
      messages: ['r2_owner_verification_required'],
    }
    const admin = setup({ ...initial, status: 'draft', changes: [r2] }, 'admin')
    await flushPromises()
    expect(admin.wrapper.find('[data-catalogue-r2-owner-approve]').exists()).toBe(false)
    const owner = setup({ ...initial, status: 'draft', changes: [r2] }, 'owner')
    await flushPromises()
    const button = owner.wrapper.get('[data-catalogue-r2-owner-approve="r2-change"]')
    expect(button.text()).toContain('R2')
    await button.trigger('click')
    await flushPromises()
    expect(owner.approveR2AsOwner).toHaveBeenCalledWith('batch-1', 'r2-change', 1)
  })
  it('puts blocking issues first and never enables accept/publish for invalid proposals', async () => {
    const { wrapper } = setup({
      ...initial,
      status: 'draft',
      changes: [
        { ...proposal, decision: 'approved' },
        {
          ...proposal,
          changeId: 'bad',
          kind: 'conflict',
          validationState: 'conflict',
          messages: ['source_identity_conflict'],
        },
      ],
    })
    await flushPromises()
    expect(wrapper.findAll('[data-catalogue-change]')[0].attributes('data-catalogue-change')).toBe(
      'bad',
    )
    expect(wrapper.find('[data-catalogue-accept="bad"]').exists()).toBe(false)
    expect(wrapper.get('[data-catalogue-publish]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-catalogue-filter]').setValue('conflict')
    expect(wrapper.findAll('[data-catalogue-change]')).toHaveLength(1)
  })
  it('supports pull, bulk approval and confirmed export without conflating publication', async () => {
    const { repo, wrapper } = setup(null)
    await flushPromises()
    await wrapper.get('[data-catalogue-sync]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-catalogue-bulk]').trigger('click')
    await flushPromises()
    expect(repo.approveCatalogueHighConfidence).toHaveBeenCalledWith('batch-1', 1)
    await wrapper.get('[data-catalogue-export]').trigger('click')
    expect(repo.exportCatalogueSheet).not.toHaveBeenCalled()
    await wrapper.get('[data-catalogue-export-confirm]').trigger('click')
    await flushPromises()
    expect(repo.exportCatalogueSheet).toHaveBeenCalledOnce()
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
  })
  it('shows a bounded error, keeps proposals and never reflects server secrets', async () => {
    const { repo, wrapper } = setup()
    await flushPromises()
    vi.mocked(repo.syncCatalogue).mockRejectedValueOnce(new Error('private-sensitive-key'))
    await wrapper.get('[data-catalogue-sync]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('unavailable')
    expect(wrapper.text()).not.toContain('private-sensitive-key')
    expect(wrapper.find('[data-catalogue-change]').exists()).toBe(true)
  })
  it('edits through the repository, replaces the proposal with the server result and requires approval again', async () => {
    const { repo, wrapper } = setup({ ...initial, changes: [{ ...proposal, decision: 'approved' }] })
    await flushPromises()
    const edit = wrapper.get('[data-catalogue-edit="change-a"]')
    expect(edit.attributes('aria-label')).toContain('Edit')
    const save = vi.spyOn(repo, 'editCatalogueChange').mockResolvedValue({
      ...initial,
      reviewRevision: 2,
      changes: [{ ...proposal, after: { title: 'Server validated title' }, decision: 'pending' }],
    })
    await edit.trigger('click')
    expect(wrapper.get('[data-catalogue-publish]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-catalogue-edit-after]').setValue('{"title":"Manual title"}')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()
    expect(save).toHaveBeenCalledWith('batch-1', 'change-a', { title: 'Manual title' }, 1)
    expect(wrapper.find('[data-catalogue-edit-form]').exists()).toBe(false)
    expect(wrapper.get('[data-catalogue-change="change-a"]').text()).toContain('Server validated title')
    expect(wrapper.get('[data-catalogue-change="change-a"]').text()).toContain('Pending')
    expect(wrapper.get('[data-catalogue-accept="change-a"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-catalogue-publish]').attributes('disabled')).toBeDefined()
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
    await wrapper.get('[data-catalogue-edit="change-a"]').trigger('click')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()
    expect(save).toHaveBeenLastCalledWith('batch-1', 'change-a', { title: 'Server validated title' }, 2)
  })
  it.each(['published', 'rejected'] as const)('does not offer Edit for %s batches', async (status) => {
    const { wrapper } = setup({ ...initial, status })
    await flushPromises()
    expect(wrapper.find('[data-catalogue-edit]').exists()).toBe(false)
  })
  it('does not offer Edit for an error without a structured after payload', async () => {
    const { wrapper } = setup({
      ...initial, changes: [{ ...proposal, after: null, kind: 'validation_error', validationState: 'error' }],
    })
    await flushPromises()
    expect(wrapper.find('[data-catalogue-edit]').exists()).toBe(false)
  })
  it('cancels without saving and blocks malformed JSON locally without replacing server validation', async () => {
    const { repo, wrapper } = setup()
    await flushPromises()
    await wrapper.get('[data-catalogue-edit="change-a"]').trigger('click')
    const save = vi.spyOn(repo, 'editCatalogueChange')
    for (const json of ['{', '[]', 'null', '"not an object"']) {
      await wrapper.get('[data-catalogue-edit-after]').setValue(json)
      await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    }
    expect(save).not.toHaveBeenCalled()
    await wrapper.get('[data-catalogue-edit-cancel]').trigger('click')
    expect(wrapper.find('[data-catalogue-edit-form]').exists()).toBe(false)
    expect(wrapper.get('[data-catalogue-change="change-a"]').text()).toContain('New')
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
  })
  it('keeps the editor and original proposal on server rejection without exposing error details', async () => {
    const { repo, wrapper } = setup()
    await flushPromises()
    await wrapper.get('[data-catalogue-edit="change-a"]').trigger('click')
    vi.spyOn(repo, 'editCatalogueChange').mockRejectedValue(new Error('PRIVATE KEY server-secret'))
    await wrapper.get('[data-catalogue-edit-after]').setValue('{"title":""}')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-catalogue-edit-form]').exists()).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).not.toMatch(/PRIVATE KEY|server-secret/)
    expect(wrapper.get('[data-catalogue-change="change-a"]').text()).toContain('New')
    expect(wrapper.find('[data-catalogue-accept="change-a"]').attributes('disabled')).toBeDefined()
    expect(repo.publishCatalogueBatch).not.toHaveBeenCalled()
  })
})
