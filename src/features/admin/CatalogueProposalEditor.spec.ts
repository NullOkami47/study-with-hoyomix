import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogueManager from './CatalogueManager.vue'
import { createAdminRepository } from './client'
import type { ImportBatch, Proposal } from '../../../workers/catalogue/types'
import { usePreferences } from '../../stores/preferences'

const wrappers: ReturnType<typeof mount>[] = []

beforeEach(() => {
  usePreferences().setLocale('en')
})

afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers.length = 0
})

function mountCatalogueWithProposal(
  afterPayload: Record<string, unknown> | unknown[],
  proposalOverrides?: Partial<Proposal>,
) {
  const repo = createAdminRepository()
  const proposal: Proposal = {
    changeId: 'change-complex',
    entityType: 'track',
    entityKey: 'track-complex',
    kind: 'metadata_change',
    before: { title: 'Old Title' },
    after: afterPayload as Record<string, unknown>,
    validationState: 'valid',
    messages: [],
    confidence: 0.9,
    decision: 'pending',
    ...proposalOverrides,
  }

  const batch: ImportBatch = {
    batchId: 'batch-test',
    status: 'draft',
    baseRevision: 1,
    reviewRevision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    publishedAt: null,
    summary: { metadata_change: 1 },
    changes: [proposal],
  }

  vi.spyOn(repo, 'getCatalogueStatus').mockResolvedValue({
    configured: true,
    role: 'admin',
    sheetUrl: 'https://docs.google.com',
    serviceAccountEmail: 'test@example.com',
    lastBatch: batch,
  })

  const saveSpy = vi.spyOn(repo, 'editCatalogueChange').mockResolvedValue({
    ...batch,
    reviewRevision: 2,
    changes: [{ ...proposal, decision: 'pending' }],
  })

  const wrapper = mount(CatalogueManager, {
    props: { repository: repo },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  // The Sheet review pipeline now lives behind its own view; the catalogue browser is the default.
  void wrapper.get('[data-catalogue-view="review"]').trigger('click')

  return { repo, wrapper, saveSpy }
}

describe('Catalogue Structured Editor', () => {
  it('renders allowed fields as structured inputs and preserves unknown fields and complex structures', async () => {
    const payload = {
      title: 'Original Title',
      focus: 80,
      notes: null,
      custom_scalar: 'custom',
      tags: ['ambient', 'chill'],
      nested_config: { gain: 0.8, loop: true },
    }

    const { wrapper } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    // Title: allowed string -> text input
    const titleInput = wrapper.get<HTMLInputElement>('#catalogue-field-title')
    expect(titleInput.attributes('type')).toBe('text')
    expect(titleInput.element.value).toBe('Original Title')

    // Focus: allowed number -> number input
    const focusInput = wrapper.get<HTMLInputElement>('#catalogue-field-focus')
    expect(focusInput.attributes('type')).toBe('number')
    expect(focusInput.element.value).toBe('80')

    // Notes: allowed null -> text input with placeholder null
    const notesInput = wrapper.get<HTMLInputElement>('#catalogue-field-notes')
    expect(notesInput.attributes('type')).toBe('text')
    expect(notesInput.element.placeholder).toBe('null')

    // custom_scalar: unknown scalar -> preserved (NOT an editable input)
    expect(wrapper.find('#catalogue-field-custom_scalar').exists()).toBe(false)
    expect(wrapper.find('[data-catalogue-preserved-field="custom_scalar"]').exists()).toBe(true)

    // tags & nested_config: complex fields preserved
    expect(wrapper.find('[data-catalogue-preserved-field="tags"]').exists()).toBe(true)
    expect(wrapper.find('[data-catalogue-complex-field="tags"]').text()).toContain('Array (2 items)')
    expect(wrapper.find('[data-catalogue-preserved-field="nested_config"]').exists()).toBe(true)
    expect(wrapper.find('[data-catalogue-complex-field="nested_config"]').text()).toContain('Object (2 keys)')
  })

  it('unknown custom string field preserved unchanged across Form save', async () => {
    const payload = {
      title: 'Track Title',
      custom_field_str: 'unmodified_str_value',
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('#catalogue-field-custom_field_str').exists()).toBe(false)
    expect(wrapper.find('[data-catalogue-preserved-field="custom_field_str"]').exists()).toBe(true)

    await wrapper.get('#catalogue-field-title').setValue('Updated Track Title')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.title).toBe('Updated Track Title')
    expect(saved.custom_field_str).toBe('unmodified_str_value')
    expect(typeof saved.custom_field_str).toBe('string')
  })

  it('unknown custom number field preserved unchanged across Form save', async () => {
    const payload = {
      title: 'Track Title',
      custom_field_num: 42.5,
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('#catalogue-field-custom_field_num').exists()).toBe(false)
    expect(wrapper.find('[data-catalogue-preserved-field="custom_field_num"]').exists()).toBe(true)

    await wrapper.get('#catalogue-field-title').setValue('Updated Track Title')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.title).toBe('Updated Track Title')
    expect(saved.custom_field_num).toBe(42.5)
    expect(typeof saved.custom_field_num).toBe('number')
  })

  it('unknown custom boolean field preserved unchanged across Form save', async () => {
    const payload = {
      title: 'Track Title',
      custom_field_bool: true,
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('#catalogue-field-custom_field_bool').exists()).toBe(false)
    expect(wrapper.find('[data-catalogue-preserved-field="custom_field_bool"]').exists()).toBe(true)

    await wrapper.get('#catalogue-field-title').setValue('Updated Track Title')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.title).toBe('Updated Track Title')
    expect(saved.custom_field_bool).toBe(true)
    expect(typeof saved.custom_field_bool).toBe('boolean')
  })

  it('nested unknown object preserved across Form save', async () => {
    const payload = {
      title: 'Track Title',
      nested_obj: { key: 'val', num: 123 },
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-catalogue-preserved-field="nested_obj"]').exists()).toBe(true)

    await wrapper.get('#catalogue-field-title').setValue('Updated Track Title')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.nested_obj).toEqual({ key: 'val', num: 123 })
  })

  it('array preserved across Form save', async () => {
    const payload = {
      title: 'Track Title',
      tags: ['ambient', 'chill', 'electronic'],
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-catalogue-preserved-field="tags"]').exists()).toBe(true)

    await wrapper.get('#catalogue-field-title').setValue('Updated Track Title')
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.tags).toEqual(['ambient', 'chill', 'electronic'])
  })

  it('valid known number edit remains a number type', async () => {
    const payload = {
      title: 'Track Title',
      focus: 60,
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    const focusInput = wrapper.get<HTMLInputElement>('#catalogue-field-focus')
    await focusInput.setValue('85')

    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.focus).toBe(85)
    expect(typeof saved.focus).toBe('number')
  })

  it('blank numeric input does NOT become 0, displays validation error, and blocks save', async () => {
    const payload = {
      title: 'Track Title',
      focus: 60,
    }
    const { wrapper, saveSpy } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    const focusInput = wrapper.get<HTMLInputElement>('#catalogue-field-focus')
    // Clear numeric input
    await focusInput.setValue('')
    await flushPromises()

    // Validation error must appear
    const errorEl = wrapper.find('[data-catalogue-field-error="focus"]')
    expect(errorEl.exists()).toBe(true)
    expect(errorEl.text().length).toBeGreaterThan(0)

    // Save button must be disabled
    const saveBtn = wrapper.get<HTMLButtonElement>('[data-catalogue-edit-save]')
    expect(saveBtn.attributes('disabled')).toBeDefined()

    // Submitting form must be blocked
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()
    expect(saveSpy).not.toHaveBeenCalled()

    // Now correct to valid number
    await focusInput.setValue('90')
    await flushPromises()

    // Validation error must be cleared
    expect(wrapper.find('[data-catalogue-field-error="focus"]').exists()).toBe(false)
    expect(saveBtn.attributes('disabled')).toBeUndefined()

    // Save should succeed and preserve number
    await wrapper.get('[data-catalogue-edit-form]').trigger('submit')
    await flushPromises()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][2]
    expect(saved.focus).toBe(90)
    expect(typeof saved.focus).toBe('number')
  })

  it('preserves fields losslessly when switching Form <-> Raw JSON mode', async () => {
    const complexPayload = {
      title: 'Form Mode Title',
      focus: 70,
      custom_str: 'scalar_custom',
      custom_num: 999,
      custom_bool: false,
      tags: ['alpha', 'beta'],
      extra: { foo: 'bar' },
    }

    const { wrapper } = mountCatalogueWithProposal(complexPayload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    // Update in form mode
    await wrapper.get('#catalogue-field-title').setValue('Modified in Form')

    // Switch to Raw JSON mode
    const modeButtons = wrapper.findAll('.catalogue-manager__mode-btn')
    const rawBtn = modeButtons.find((btn) => btn.text().includes('Raw JSON'))
    expect(rawBtn).toBeDefined()
    await rawBtn!.trigger('click')
    await flushPromises()

    const rawTextarea = wrapper.get<HTMLTextAreaElement>('[data-catalogue-edit-after]')
    const parsedFromRaw = JSON.parse(rawTextarea.element.value)

    expect(parsedFromRaw).toEqual({
      title: 'Modified in Form',
      focus: 70,
      custom_str: 'scalar_custom',
      custom_num: 999,
      custom_bool: false,
      tags: ['alpha', 'beta'],
      extra: { foo: 'bar' },
    })

    // Switch back to Form mode
    const formBtn = modeButtons.find((btn) => btn.text().includes('Form Editor'))
    expect(formBtn).toBeDefined()
    await formBtn!.trigger('click')
    await flushPromises()

    const titleInput = wrapper.get<HTMLInputElement>('#catalogue-field-title')
    expect(titleInput.element.value).toBe('Modified in Form')
  })

  it('sets initial focus to the visible structured control instead of the hidden textarea', async () => {
    const payload = {
      title: 'Initial Focus Title',
      focus: 65,
    }

    const { wrapper } = mountCatalogueWithProposal(payload)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    const titleInput = wrapper.get<HTMLInputElement>('#catalogue-field-title').element
    expect(document.activeElement).toBe(titleInput)
  })

  it('falls back to Raw JSON mode when payload cannot be safely represented as an object form', async () => {
    const arrayPayload = ['item1', 'item2']
    const { wrapper } = mountCatalogueWithProposal(arrayPayload as unknown as Record<string, unknown>)
    await flushPromises()

    await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
    await flushPromises()

    const rawTextareaWrap = wrapper.find('.catalogue-manager__textarea-wrap')
    expect(rawTextareaWrap.classes()).not.toContain('catalogue-manager__textarea-wrap--hidden')
  })
})
