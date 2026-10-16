import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import ProviderControls from './ProviderControls.vue'
import type { AdminProvider } from './client'

const makeProvider = (overrides: Partial<AdminProvider> = {}): AdminProvider => ({
  key: 'chksz',
  adminEnabled: true,
  deploymentAvailable: true,
  effectiveEnabled: true,
  automaticPolicy: 'direct',
  priority: 10,
  status: 'healthy',
  failureClass: null,
  latencyMs: 40,
  checkedAt: 1000,
  updatedAt: 2000,
  ...overrides,
})

const mountControls = (providers: AdminProvider[]) => mount(ProviderControls, {
  props: { providers },
})

describe('ProviderControls', () => {
  it('labels manual-only and direct providers truthfully', () => {
    const wrapper = mountControls([
      makeProvider({ key: 'jellyfin', automaticPolicy: 'never' }),
      makeProvider({ key: 'chksz', automaticPolicy: 'direct' }),
    ])
    expect(wrapper.get('[data-provider-policy="jellyfin"]').text()).toBe('Manual-only')
    expect(wrapper.get('[data-provider-policy="chksz"]').text()).toBe('Automatic direct audio')
  })

  it('exposes ChKSz Owner fallback as a separate safe control', async () => {
    const wrapper = mountControls([makeProvider({
      key: 'chksz',
      automaticPolicy: 'direct',
      ownerKeyConfigured: true,
      ownerFallbackEnabled: false,
      ownerFallbackUsable: false,
    })])
    const control = wrapper.get('[data-chksz-owner-fallback]')

    expect(control.text()).toContain('Use Owner API key as fallback')
    expect(control.text()).toContain('Owner key configured')
    await control.get('input').setValue(true)
    expect(wrapper.emitted('owner-fallback')).toEqual([[true]])
  })

  it('allows disabling a stale Owner fallback after the Owner key is removed', async () => {
    const enabledWrapper = mountControls([makeProvider({
      key: 'chksz',
      automaticPolicy: 'direct',
      ownerKeyConfigured: false,
      ownerFallbackEnabled: true,
      ownerFallbackUsable: false,
    })])
    const enabledControl = enabledWrapper.get('[data-chksz-owner-fallback] input')

    expect(enabledControl.attributes('disabled')).toBeUndefined()
    await enabledControl.setValue(false)
    expect(enabledWrapper.emitted('owner-fallback')).toEqual([[false]])

    const disabledWrapper = mountControls([makeProvider({
      key: 'chksz',
      automaticPolicy: 'direct',
      ownerKeyConfigured: false,
      ownerFallbackEnabled: false,
      ownerFallbackUsable: false,
    })])

    expect(disabledWrapper.get('[data-chksz-owner-fallback] input').attributes('disabled')).toBeDefined()
  })

  it.each(['chksz', 'lx', 'jellyfin'] as const)(
    'disables non-last provider %s immediately without a global confirmation',
    async (key) => {
      const otherKey = key === 'chksz' ? 'lx' : 'chksz'
      const wrapper = mountControls([
        makeProvider({ key, priority: 10 }),
        makeProvider({ key: otherKey, priority: 20 }),
      ])
      await wrapper.find(`[data-provider-toggle="${key}"]`).setValue(false)

      expect(wrapper.emitted('toggle')).toEqual([[key, false]])
      expect(wrapper.find('[data-provider-shutdown-dialog]').exists()).toBe(false)
    },
  )

  it('keeps the checkbox at server state until updated provider props arrive', async () => {
    const providers = [
      makeProvider({ key: 'chksz', priority: 10 }),
      makeProvider({ key: 'lx', priority: 20 }),
    ]
    const wrapper = mountControls(providers)
    const toggle = wrapper.get('[data-provider-toggle="lx"]')

    await toggle.setValue(false)

    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.emitted('toggle')).toEqual([['lx', false]])

    await wrapper.setProps({
      providers: [
        providers[0]!,
        { ...providers[1]!, adminEnabled: false, effectiveEnabled: false },
      ],
    })
    expect((wrapper.get('[data-provider-toggle="lx"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('opens a bounded confirmation for disabling the last effective provider', async () => {
    const wrapper = mountControls([makeProvider({ key: 'chksz' })])
    await wrapper.find('[data-provider-toggle="chksz"]').setValue(false)
    const dialog = wrapper.find('[data-provider-shutdown-dialog]')

    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.text()).toContain('1')
    expect(dialog.text()).toContain('Online playback will be unavailable')
    expect(wrapper.find('[data-provider-shutdown-confirmation]').exists()).toBe(true)
    expect(wrapper.find('[data-provider-shutdown-reason]').exists()).toBe(true)
    expect(wrapper.find('[data-provider-shutdown-cancel]').text()).toContain('Cancel')
    expect(wrapper.find('[data-provider-shutdown-confirm]').text()).toContain('Confirm')
    expect(wrapper.emitted('toggle')).toBeUndefined()
  })

  it('does not confirm unless the phrase is exact and the internal reason is non-blank', async () => {
    const wrapper = mountControls([makeProvider({ key: 'chksz' })])
    await wrapper.find('[data-provider-toggle="chksz"]').setValue(false)
    await wrapper.find('[data-provider-shutdown-confirmation]').setValue('disable all playback')
    await wrapper.find('[data-provider-shutdown-reason]').setValue('   ')
    await wrapper.find('[data-provider-shutdown-confirm]').trigger('submit')

    expect(wrapper.emitted('toggle')).toBeUndefined()
    expect(wrapper.find('[data-provider-shutdown-error]').exists()).toBe(true)
  })

  it('submits the exact phrase and trimmed internal reason', async () => {
    const wrapper = mountControls([makeProvider({ key: 'chksz' })])
    await wrapper.find('[data-provider-toggle="chksz"]').setValue(false)
    await wrapper.find('[data-provider-shutdown-confirmation]').setValue('DISABLE ALL PLAYBACK')
    await wrapper.find('[data-provider-shutdown-reason]').setValue('  maintenance window  ')
    await wrapper.find('[data-provider-shutdown-confirm]').trigger('submit')

    expect(wrapper.emitted('toggle')).toEqual([[
      'chksz',
      false,
      'DISABLE ALL PLAYBACK',
      'maintenance window',
    ]])
  })

  it('cancels the global shutdown flow without mutating state', async () => {
    const wrapper = mountControls([makeProvider({ key: 'chksz' })])
    await wrapper.find('[data-provider-toggle="chksz"]').setValue(false)
    await wrapper.find('[data-provider-shutdown-cancel]').trigger('click')

    expect(wrapper.find('[data-provider-shutdown-dialog]').exists()).toBe(false)
    expect(wrapper.emitted('toggle')).toBeUndefined()
  })

  it('does not count an unavailable Admin-enabled provider as effective shutdown protection', async () => {
    const wrapper = mountControls([
      makeProvider({ key: 'lx', effectiveEnabled: true }),
      makeProvider({
        key: 'chksz',
        adminEnabled: true,
        deploymentAvailable: false,
        effectiveEnabled: false,
      }),
    ])
    await wrapper.find('[data-provider-toggle="lx"]').setValue(false)

    expect(wrapper.find('[data-provider-shutdown-dialog]').exists()).toBe(true)
    expect(wrapper.emitted('toggle')).toBeUndefined()
  })

  it('shows Admin intent, deployment availability, and effective status separately', () => {
    const wrapper = mountControls([
      makeProvider({
        key: 'jellyfin',
        adminEnabled: true,
        deploymentAvailable: false,
        effectiveEnabled: false,
      }),
    ])
    const item = wrapper.find('[data-provider-key="jellyfin"]')
    const toggle = item.find('[data-provider-toggle="jellyfin"]')

    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(toggle.attributes('disabled')).toBeUndefined()
    expect(item.text()).toContain('Unavailable in this deployment')
    expect(item.text()).toContain('Not effective')
  })

  it('blocks an unavailable off-to-on action while keeping ordering controls usable', async () => {
    const wrapper = mountControls([
      makeProvider({
        key: 'jellyfin',
        priority: 1,
        adminEnabled: false,
        deploymentAvailable: false,
        effectiveEnabled: false,
      }),
      makeProvider({
        key: 'lx',
        priority: 2,
      }),
    ])
    const toggle = wrapper.find('[data-provider-toggle="jellyfin"]')
    const moveDown = wrapper.find('[data-provider-move-down="jellyfin"]')

    expect(toggle.attributes('disabled')).toBeDefined()
    expect(moveDown.attributes('disabled')).toBeUndefined()
  })

  describe('canonical provider projection and ordering controls', () => {
    it('renders only the 3 canonical top-level providers in priority order', () => {
      const wrapper = mountControls([
        makeProvider({ key: 'youtube', priority: 1 }),
        makeProvider({ key: 'lx-ikun', priority: 2 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'meting', priority: 5 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
        makeProvider({ key: 'r2', priority: 8 }),
        makeProvider({ key: 'chksz', priority: 10 }),
      ])

      const items = wrapper.findAll('[data-provider-key]')
      expect(items).toHaveLength(3)
      expect(items.map((i) => i.attributes('data-provider-key'))).toEqual(['chksz', 'lx', 'jellyfin'])
      expect(items[0].text()).toContain('ChKSz BYOK')
      expect(items[1].text()).toContain('LX Music')
      expect(items[2].text()).toContain('Jellyfin')

      expect(wrapper.find('[data-provider-key="youtube"]').exists()).toBe(false)
      expect(wrapper.find('[data-provider-key="lx-ikun"]').exists()).toBe(false)
      expect(wrapper.find('[data-provider-key="meting"]').exists()).toBe(false)
      expect(wrapper.find('[data-provider-key="r2"]').exists()).toBe(false)
    })

    it('shows them as an ordered numbered list (1, 2, 3)', () => {
      const wrapper = mountControls([
        makeProvider({ key: 'jellyfin', priority: 5 }),
        makeProvider({ key: 'chksz', priority: 15 }),
        makeProvider({ key: 'lx', priority: 25 }),
      ])

      const badges = wrapper.findAll('[data-provider-order-badge]')
      expect(badges).toHaveLength(3)
      expect(badges.map((b) => b.text().trim())).toEqual(['1', '2', '3'])
      const items = wrapper.findAll('[data-provider-key]')
      expect(items.map((i) => i.attributes('data-provider-key'))).toEqual(['jellyfin', 'chksz', 'lx'])
    })

    it('never exposes arbitrary numeric sliders or priority steppers', () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      expect(wrapper.find('input[type="range"]').exists()).toBe(false)
      expect(wrapper.find('[data-provider-priority]').exists()).toBe(false)
      expect(wrapper.find('[data-provider-priority-output]').exists()).toBe(false)
      expect(wrapper.find('[aria-label="Increase priority"]').exists()).toBe(false)
      expect(wrapper.find('[aria-label="Decrease priority"]').exists()).toBe(false)
    })

    it('provides accessible Move Up and Move Down buttons with appropriate disabled states', () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      // First item (chksz): Move Up disabled, Move Down enabled
      const chkszUp = wrapper.get('[data-provider-move-up="chksz"]')
      const chkszDown = wrapper.get('[data-provider-move-down="chksz"]')
      expect(chkszUp.attributes('aria-label')).toBe('Move ChKSz BYOK up')
      expect(chkszUp.attributes('disabled')).toBeDefined()
      expect(chkszDown.attributes('aria-label')).toBe('Move ChKSz BYOK down')
      expect(chkszDown.attributes('disabled')).toBeUndefined()

      // Second item (lx): Move Up enabled, Move Down enabled
      const lxUp = wrapper.get('[data-provider-move-up="lx"]')
      const lxDown = wrapper.get('[data-provider-move-down="lx"]')
      expect(lxUp.attributes('aria-label')).toBe('Move LX Music up')
      expect(lxUp.attributes('disabled')).toBeUndefined()
      expect(lxDown.attributes('aria-label')).toBe('Move LX Music down')
      expect(lxDown.attributes('disabled')).toBeUndefined()

      // Third item (jellyfin): Move Up enabled, Move Down disabled
      const jellyfinUp = wrapper.get('[data-provider-move-up="jellyfin"]')
      const jellyfinDown = wrapper.get('[data-provider-move-down="jellyfin"]')
      expect(jellyfinUp.attributes('aria-label')).toBe('Move Jellyfin up')
      expect(jellyfinUp.attributes('disabled')).toBeUndefined()
      expect(jellyfinDown.attributes('aria-label')).toBe('Move Jellyfin down')
      expect(jellyfinDown.attributes('disabled')).toBeDefined()
    })

    it('emits order with the full new order when Move Down is clicked', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      await wrapper.get('[data-provider-move-down="chksz"]').trigger('click')
      expect(wrapper.emitted('order')).toEqual([[['lx', 'chksz', 'jellyfin']]])
    })

    it('emits order with the full new order when Move Up is clicked', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      await wrapper.get('[data-provider-move-up="jellyfin"]').trigger('click')
      expect(wrapper.emitted('order')).toEqual([[['chksz', 'jellyfin', 'lx']]])
    })

    it('provides a Reset default order button that emits order with canonical default order', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'jellyfin', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'chksz', priority: 30 }),
      ])

      const resetBtn = wrapper.get('[data-provider-order-reset]')
      expect(resetBtn.text()).toContain('Reset default order')
      await resetBtn.trigger('click')

      expect(wrapper.emitted('order')).toEqual([[['chksz', 'lx', 'jellyfin']]])
    })

    it('disables Move Up, Move Down, and Reset buttons when mutating is active', () => {
      const wrapper = mount(ProviderControls, {
        props: {
          providers: [
            makeProvider({ key: 'chksz', priority: 10 }),
            makeProvider({ key: 'lx', priority: 20 }),
            makeProvider({ key: 'jellyfin', priority: 30 }),
          ],
          mutating: 'order',
        },
      })

      expect(wrapper.get('[data-provider-move-down="chksz"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-provider-move-up="lx"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-provider-move-down="lx"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-provider-move-up="jellyfin"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-provider-order-reset]').attributes('disabled')).toBeDefined()
    })
  })

  describe('drag-and-drop provider reordering', () => {
    const createPointerEvent = (type: string, pointerId = 1, clientX = 10, clientY = 10): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        pointerId: { configurable: true, value: pointerId },
        clientX: { configurable: true, value: clientX },
        clientY: { configurable: true, value: clientY },
        button: { configurable: true, value: 0 },
      })
      return event
    }

    it('renders accessible drag handles for each canonical provider', () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      const handles = wrapper.findAll('[data-provider-drag-handle]')
      expect(handles).toHaveLength(3)

      const jellyfinHandle = wrapper.get('[data-provider-drag-handle="jellyfin"]')
      expect(jellyfinHandle.attributes('aria-label')).toBe('Reorder Jellyfin')
      expect(jellyfinHandle.attributes('aria-grabbed')).toBe('false')

      const chkszHandle = wrapper.get('[data-provider-drag-handle="chksz"]')
      expect(chkszHandle.attributes('aria-label')).toBe('Reorder ChKSz BYOK')

      const lxHandle = wrapper.get('[data-provider-drag-handle="lx"]')
      expect(lxHandle.attributes('aria-label')).toBe('Reorder LX Music')
    })

    it('disables drag handles when mutating is active', () => {
      const wrapper = mount(ProviderControls, {
        props: {
          providers: [
            makeProvider({ key: 'chksz', priority: 10 }),
            makeProvider({ key: 'lx', priority: 20 }),
            makeProvider({ key: 'jellyfin', priority: 30 }),
          ],
          mutating: 'order',
        },
      })

      const handles = wrapper.findAll('[data-provider-drag-handle]')
      expect(handles).toHaveLength(3)
      for (const handle of handles) {
        expect(handle.attributes('disabled')).toBeDefined()
      }
    })

    it('reorders via pointer drag: dragging Jellyfin to the top emits [jellyfin, chksz, lx]', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
      Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })

      const chkszItem = wrapper.get('[data-provider-key="chksz"]').element
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => chkszItem) })

      const jellyfinHandle = wrapper.get('[data-provider-drag-handle="jellyfin"]')
      const jellyfinItem = wrapper.get('[data-provider-key="jellyfin"]')

      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointerdown', 1))
      await wrapper.vm.$nextTick()
      expect(jellyfinItem.attributes('data-provider-dragging')).toBe('true')
      expect(jellyfinHandle.attributes('aria-grabbed')).toBe('true')

      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointermove', 1, 10, 50))
      await wrapper.vm.$nextTick()

      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointerup', 1, 10, 50))
      await wrapper.vm.$nextTick()

      expect(wrapper.emitted('order')).toEqual([[['jellyfin', 'chksz', 'lx']]])
      expect(jellyfinItem.attributes('data-provider-dragging')).toBe('false')
      expect(jellyfinHandle.attributes('aria-grabbed')).toBe('false')
    })

    it('reorders via pointer drag: dragging LX to the top emits [lx, chksz, jellyfin]', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
      Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })

      const chkszItem = wrapper.get('[data-provider-key="chksz"]').element
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => chkszItem) })

      const lxHandle = wrapper.get('[data-provider-drag-handle="lx"]')
      lxHandle.element.dispatchEvent(createPointerEvent('pointerdown', 2))
      await wrapper.vm.$nextTick()
      lxHandle.element.dispatchEvent(createPointerEvent('pointermove', 2, 10, 50))
      lxHandle.element.dispatchEvent(createPointerEvent('pointerup', 2, 10, 50))
      await wrapper.vm.$nextTick()

      expect(wrapper.emitted('order')).toEqual([[['lx', 'chksz', 'jellyfin']]])
    })

    it('cancels pointer drag on pointercancel without emitting order', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
      Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })

      const chkszItem = wrapper.get('[data-provider-key="chksz"]').element
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => chkszItem) })

      const jellyfinHandle = wrapper.get('[data-provider-drag-handle="jellyfin"]')
      const jellyfinItem = wrapper.get('[data-provider-key="jellyfin"]')

      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointerdown', 3))
      await wrapper.vm.$nextTick()
      expect(jellyfinItem.attributes('data-provider-dragging')).toBe('true')

      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointercancel', 3))
      await wrapper.vm.$nextTick()

      expect(wrapper.emitted('order')).toBeUndefined()
      expect(jellyfinItem.attributes('data-provider-dragging')).toBe('false')
    })

    it('supports HTML5 drag-and-drop: dragging Jellyfin to the top emits [jellyfin, chksz, lx]', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      const jellyfinItem = wrapper.get('[data-provider-key="jellyfin"]')
      const chkszItem = wrapper.get('[data-provider-key="chksz"]')

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn(() => '2'),
        effectAllowed: 'move',
        dropEffect: 'move',
      }

      await jellyfinItem.trigger('dragstart', { dataTransfer })
      await chkszItem.trigger('dragover', { dataTransfer })
      await chkszItem.trigger('drop', { dataTransfer })

      expect(wrapper.emitted('order')).toEqual([[['jellyfin', 'chksz', 'lx']]])
    })

    it('performs optimistic reordering and rolls back when mutating resets without prop change', async () => {
      const wrapper = mountControls([
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])

      Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
      Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
      const chkszItem = wrapper.get('[data-provider-key="chksz"]').element
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => chkszItem) })

      const jellyfinHandle = wrapper.get('[data-provider-drag-handle="jellyfin"]')
      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointerdown', 4))
      await wrapper.vm.$nextTick()
      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointermove', 4, 10, 50))
      jellyfinHandle.element.dispatchEvent(createPointerEvent('pointerup', 4, 10, 50))
      await wrapper.vm.$nextTick()

      // Optimistic update should immediately reflect in rendered order
      let renderedKeys = wrapper.findAll('[data-provider-key]').map((el) => el.attributes('data-provider-key'))
      expect(renderedKeys).toEqual(['jellyfin', 'chksz', 'lx'])

      // Simulate mutation start in parent
      await wrapper.setProps({ mutating: 'order' })

      // Simulate mutation error in parent: mutating resets to null but providers unchanged
      await wrapper.setProps({ mutating: null })
      await wrapper.vm.$nextTick()

      // Should roll back to props order
      renderedKeys = wrapper.findAll('[data-provider-key]').map((el) => el.attributes('data-provider-key'))
      expect(renderedKeys).toEqual(['chksz', 'lx', 'jellyfin'])
    })
  })

  describe('unified provider cards', () => {
    it('renders real-time health indicators, latency, and failure class within each card', () => {
      const wrapper = mountControls([
        makeProvider({
          key: 'chksz',
          status: 'healthy',
          latencyMs: 142,
          failureClass: null,
          checkedAt: Date.now() - 30_000,
        }),
        makeProvider({
          key: 'jellyfin',
          status: 'degraded',
          latencyMs: 650,
          failureClass: 'http_502_upstream_gateway',
          checkedAt: Date.now() - 15_000,
        }),
      ])

      const chkszCard = wrapper.find('[data-provider-key="chksz"]')
      expect(chkszCard.find('.provider-health__dot--healthy').exists()).toBe(true)
      expect(chkszCard.find('[data-provider-status-text]').text()).toBe('healthy')
      expect(chkszCard.find('.provider-health__metric--latency').text()).toBe('142 ms')

      const jellyfinCard = wrapper.find('[data-provider-key="jellyfin"]')
      expect(jellyfinCard.find('.provider-health__dot--degraded').exists()).toBe(true)
      expect(jellyfinCard.find('[data-provider-status-text]').text()).toBe('degraded')
      expect(jellyfinCard.find('[data-provider-failure]').attributes('data-provider-failure')).toBe('http_502_upstream_gateway')
      expect(jellyfinCard.find('.provider-health__metric--latency').text()).toBe('650 ms')
    })
  })

  describe('narrow viewport', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/admin/ProviderControls.vue'), 'utf8')

    it('stacks each provider row on narrow viewports', () => {
      const narrow = source.slice(source.indexOf('@media (max-width: 768px)'))
      expect(narrow.startsWith('@media (max-width: 768px)')).toBe(true)
      expect(narrow).toContain('"toggle toggle toggle"')
    })

    it('does not contain any range slider in styles', () => {
      expect(source).not.toContain('input[type="range"]')
    })
  })
})
