import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AdminConfirmDialog from './AdminConfirmDialog.vue'

describe('AdminConfirmDialog', () => {
  let openerButton: HTMLButtonElement | null = null
  let backgroundButton: HTMLButtonElement | null = null

  beforeEach(() => {
    openerButton = document.createElement('button')
    openerButton.id = 'opener-btn'
    openerButton.textContent = 'Open Dialog'
    document.body.appendChild(openerButton)

    backgroundButton = document.createElement('button')
    backgroundButton.id = 'background-btn'
    backgroundButton.textContent = 'Background Control'
    document.body.appendChild(backgroundButton)
  })

  afterEach(() => {
    openerButton?.remove()
    backgroundButton?.remove()
    document.body.innerHTML = ''
  })

  it('renders title, description and handles confirm and cancel', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      props: {
        open: true,
        title: 'Delete Resource?',
        description: 'Are you sure you want to proceed?',
        teleport: false,
      },
    })

    expect(wrapper.text()).toContain('Delete Resource?')
    expect(wrapper.text()).toContain('Are you sure you want to proceed?')

    await wrapper.get('[data-admin-cancel-button]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)

    await wrapper.get('[data-admin-confirm-button]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('enforces required confirmation phrase and reason', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      props: {
        open: true,
        title: 'Emergency Shutdown',
        requirePhrase: 'DISABLE ALL PLAYBACK',
        requireReason: true,
        teleport: false,
      },
    })

    const confirmBtn = wrapper.get('[data-admin-confirm-button]')
    expect(confirmBtn.attributes('disabled')).toBeDefined()

    // Wrong phrase
    await wrapper.get('[data-admin-confirm-input]').setValue('wrong phrase')
    await wrapper.get('[data-admin-reason-input]').setValue('testing')
    expect(confirmBtn.attributes('disabled')).toBeDefined()

    // Correct phrase, empty reason
    await wrapper.get('[data-admin-confirm-input]').setValue('DISABLE ALL PLAYBACK')
    await wrapper.get('[data-admin-reason-input]').setValue('   ')
    expect(confirmBtn.attributes('disabled')).toBeDefined()

    // Correct phrase and reason
    await wrapper.get('[data-admin-reason-input]').setValue('Valid reason')
    expect(confirmBtn.attributes('disabled')).toBeUndefined()

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('confirm')).toEqual([
      [{ confirmation: 'DISABLE ALL PLAYBACK', reason: 'Valid reason' }],
    ])

    wrapper.unmount()
  })

  it('sets initial focus to phrase input if requirePhrase is set', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Emergency Shutdown',
        requirePhrase: 'DISABLE ALL PLAYBACK',
        teleport: false,
      },
    })
    await nextTick()
    const input = wrapper.get('[data-admin-confirm-input]').element
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('sets initial focus to cancel button when no inputs are required', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Simple Confirm',
        teleport: false,
      },
    })
    await nextTick()
    const cancelBtn = wrapper.get('[data-admin-cancel-button]').element
    expect(document.activeElement).toBe(cancelBtn)
    wrapper.unmount()
  })

  it('wraps Tab from last focusable element to first', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Tab Wrap Test',
        teleport: false,
      },
    })
    await nextTick()

    const cancelBtn = wrapper.get('[data-admin-cancel-button]').element as HTMLElement
    const confirmBtn = wrapper.get('[data-admin-confirm-button]').element as HTMLElement

    // Focus last element
    confirmBtn.focus()
    expect(document.activeElement).toBe(confirmBtn)

    // Press Tab
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(tabEvent)
    await nextTick()

    expect(document.activeElement).toBe(cancelBtn)
    wrapper.unmount()
  })

  it('wraps Shift+Tab from first focusable element to last', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Shift+Tab Wrap Test',
        teleport: false,
      },
    })
    await nextTick()

    const cancelBtn = wrapper.get('[data-admin-cancel-button]').element as HTMLElement
    const confirmBtn = wrapper.get('[data-admin-confirm-button]').element as HTMLElement

    // Focus first element
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    // Press Shift+Tab
    const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(shiftTabEvent)
    await nextTick()

    expect(document.activeElement).toBe(confirmBtn)
    wrapper.unmount()
  })

  it('cancels on Escape key', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      props: {
        open: true,
        title: 'Escape Test',
        teleport: false,
      },
    })
    await nextTick()

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(escapeEvent)
    await nextTick()

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('returns focus to the exact opener after closing', async () => {
    openerButton!.focus()
    expect(document.activeElement).toBe(openerButton)

    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Restore Focus Test',
        teleport: false,
      },
    })
    await nextTick()

    expect(document.activeElement).not.toBe(openerButton)

    // Close the dialog
    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(openerButton)
    wrapper.unmount()
  })

  it('prevents background controls from receiving keyboard focus while open', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Modal Trapping Test',
        teleport: false,
      },
    })
    await nextTick()

    // Attempt to focus a background element
    backgroundButton!.focus()
    document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await nextTick()

    expect(document.activeElement).not.toBe(backgroundButton)
    const dialog = wrapper.get('[data-admin-confirm-dialog]').element
    expect(dialog.contains(document.activeElement)).toBe(true)

    wrapper.unmount()
  })

  it('emits EXACTLY ONE confirm on submit button activation', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Single Confirmation Emission Regression',
        teleport: false,
      },
    })
    await nextTick()

    const confirmBtn = wrapper.get('[data-admin-confirm-button]')
    // Click submit button - in real browser, this triggers click and then form submit
    await confirmBtn.trigger('click')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  describe('parent harness focus restoration', () => {
    function createHarness() {
      return defineComponent({
        components: { AdminConfirmDialog },
        setup() {
          const isOpen = ref(false)
          return { isOpen }
        },
        template: `
          <div>
            <button id="test-opener-btn" @click="isOpen = true">Open Dialog</button>
            <AdminConfirmDialog
              :open="isOpen"
              title="Parent Harness Test"
              :teleport="false"
              @cancel="isOpen = false"
            />
          </div>
        `,
      })
    }

    it('A. opener -> open dialog -> click Cancel -> parent sets open=false -> exact opener regains focus', async () => {
      const Harness = createHarness()
      const wrapper = mount(Harness, { attachTo: document.body })
      const opener = wrapper.get('#test-opener-btn').element as HTMLButtonElement
      opener.focus()
      expect(document.activeElement).toBe(opener)

      await wrapper.get('#test-opener-btn').trigger('click')
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(true)
      expect(document.activeElement).not.toBe(opener)

      await wrapper.get('[data-admin-cancel-button]').trigger('click')
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(false)
      await nextTick()
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })

    it('B. opener -> open dialog -> Escape -> parent sets open=false -> exact opener regains focus', async () => {
      const Harness = createHarness()
      const wrapper = mount(Harness, { attachTo: document.body })
      const opener = wrapper.get('#test-opener-btn').element as HTMLButtonElement
      opener.focus()
      expect(document.activeElement).toBe(opener)

      await wrapper.get('#test-opener-btn').trigger('click')
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(true)
      expect(document.activeElement).not.toBe(opener)

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      window.dispatchEvent(escapeEvent)
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(false)
      await nextTick()
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })

    it('C. backdrop dismiss -> same focus restoration', async () => {
      const Harness = createHarness()
      const wrapper = mount(Harness, { attachTo: document.body })
      const opener = wrapper.get('#test-opener-btn').element as HTMLButtonElement
      opener.focus()
      expect(document.activeElement).toBe(opener)

      await wrapper.get('#test-opener-btn').trigger('click')
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(true)
      expect(document.activeElement).not.toBe(opener)

      await wrapper.get('[data-admin-dialog-backdrop]').trigger('click')
      await nextTick()
      expect(wrapper.vm.isOpen).toBe(false)
      await nextTick()
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })
  })
})
