import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OverlaySheet from './OverlaySheet.vue'

function pointerEvent(type: string, pointerId: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

describe('OverlaySheet', () => {
  let opener: HTMLButtonElement

  beforeEach(() => {
    opener = document.createElement('button')
    opener.textContent = 'Open library'
    document.body.append(opener)
    opener.focus()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('closes with Escape and returns focus to the element that opened it', async () => {
    const wrapper = mount(OverlaySheet, {
      attachTo: document.body,
      props: { open: true, title: 'Library', modal: true },
      slots: { default: '<button data-last-action>Last action</button>' },
    })

    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true')
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
  })

  it('contains Tab focus within an open modal sheet', async () => {
    const wrapper = mount(OverlaySheet, {
      attachTo: document.body,
      props: { open: true, title: 'Library', modal: true },
      slots: { default: '<button data-last-action>Last action</button>' },
    })
    const close = wrapper.get<HTMLButtonElement>('[data-overlay-close]').element
    const last = wrapper.get<HTMLButtonElement>('[data-last-action]').element

    last.focus()
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    wrapper.unmount()
  })

  it('offers an explicit translated close command', async () => {
    const wrapper = mount(OverlaySheet, {
      attachTo: document.body,
      props: { open: true, title: 'Library', modal: true },
    })

    await wrapper.get('[data-overlay-close]').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('consumes the real outside pointer sequence before closing once and returning focus', async () => {
    const closeCount = ref(0)
    const underlyingEvents = ref<string[]>([])
    const Harness = defineComponent({
      components: { OverlaySheet },
      setup() {
        const open = ref(false)
        const close = (): void => {
          closeCount.value += 1
          open.value = false
        }
        const recordUnderlying = (event: Event): void => {
          underlyingEvents.value = [...underlyingEvents.value, event.type]
        }
        return { close, open, recordUnderlying }
      },
      template: `
        <button data-harness-opener type="button" @click="open = true">Open</button>
        <button
          data-underlying-player
          type="button"
          @pointerdown="recordUnderlying"
          @pointerup="recordUnderlying"
          @click="recordUnderlying"
        >Pause</button>
        <OverlaySheet :open="open" title="Library" modal @close="close">
          <button type="button">Inside</button>
        </OverlaySheet>
      `,
    })
    const wrapper = mount(Harness, { attachTo: document.body })
    const harnessOpener = wrapper.get<HTMLButtonElement>('[data-harness-opener]')

    harnessOpener.element.focus()
    await harnessOpener.trigger('click')
    const underlyingPlayer = wrapper.get('[data-underlying-player]').element
    const pointerdown = pointerEvent('pointerdown', 0)
    const pointerup = pointerEvent('pointerup', 0)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })

    underlyingPlayer.dispatchEvent(pointerdown)
    underlyingPlayer.dispatchEvent(pointerup)
    underlyingPlayer.dispatchEvent(click)
    await nextTick()

    expect(pointerdown.defaultPrevented).toBe(true)
    expect(pointerup.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(closeCount.value).toBe(1)
    expect(underlyingEvents.value).toEqual([])
    expect(wrapper.find('[data-overlay-backdrop]').exists()).toBe(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(harnessOpener.element)
    wrapper.unmount()
  })

  it('tracks interleaved outside and inside pointer sequences independently', async () => {
    const underlyingEvents = ref<string[]>([])
    const Harness = defineComponent({
      components: { OverlaySheet },
      setup() {
        const open = ref(false)
        const recordUnderlying = (event: Event): void => {
          underlyingEvents.value = [...underlyingEvents.value, event.type]
        }
        return { open, recordUnderlying }
      },
      template: `
        <button data-harness-opener type="button" @click="open = true">Open</button>
        <button
          data-underlying-player
          type="button"
          @pointerdown="recordUnderlying"
          @pointerup="recordUnderlying"
          @click="recordUnderlying"
        >Pause</button>
        <OverlaySheet :open="open" title="Library" modal @close="open = false">
          <button data-inside-sheet type="button">Inside</button>
        </OverlaySheet>
      `,
    })
    const wrapper = mount(Harness, { attachTo: document.body })
    await wrapper.get('[data-harness-opener]').trigger('click')
    const underlyingPlayer = wrapper.get('[data-underlying-player]').element
    const insideSheet = wrapper.get('[data-inside-sheet]').element
    const outsideDown = pointerEvent('pointerdown', 1)
    const insideDown = pointerEvent('pointerdown', 2)
    const outsideUp = pointerEvent('pointerup', 1)

    underlyingPlayer.dispatchEvent(outsideDown)
    insideSheet.dispatchEvent(insideDown)
    underlyingPlayer.dispatchEvent(outsideUp)
    await nextTick()

    expect(outsideDown.defaultPrevented).toBe(true)
    expect(insideDown.defaultPrevented).toBe(false)
    expect(outsideUp.defaultPrevented).toBe(true)
    expect(underlyingEvents.value).toEqual([])
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('clears only the cancelled pointer and contains a fresh outside sequence', async () => {
    const closeCount = ref(0)
    const underlyingEvents = ref<string[]>([])
    const Harness = defineComponent({
      components: { OverlaySheet },
      setup() {
        const open = ref(false)
        const close = (): void => {
          closeCount.value += 1
          open.value = false
        }
        const recordUnderlying = (event: Event): void => {
          underlyingEvents.value = [...underlyingEvents.value, event.type]
        }
        return { close, open, recordUnderlying }
      },
      template: `
        <button data-harness-opener type="button" @click="open = true">Open</button>
        <button
          data-underlying-player
          type="button"
          @pointerdown="recordUnderlying"
          @pointerup="recordUnderlying"
          @click="recordUnderlying"
        >Pause</button>
        <OverlaySheet :open="open" title="Library" modal @close="close">
          <button type="button">Inside</button>
        </OverlaySheet>
      `,
    })
    const wrapper = mount(Harness, { attachTo: document.body })
    const harnessOpener = wrapper.get<HTMLButtonElement>('[data-harness-opener]')
    harnessOpener.element.focus()
    await harnessOpener.trigger('click')
    const underlyingPlayer = wrapper.get('[data-underlying-player]').element
    const outsideDownTen = pointerEvent('pointerdown', 10)
    const outsideDownEleven = pointerEvent('pointerdown', 11)
    const cancelEleven = pointerEvent('pointercancel', 11)
    const outsideUpTen = pointerEvent('pointerup', 10)
    const cancelledUpEleven = pointerEvent('pointerup', 11)

    underlyingPlayer.dispatchEvent(outsideDownTen)
    underlyingPlayer.dispatchEvent(outsideDownEleven)
    document.body.dispatchEvent(cancelEleven)
    underlyingPlayer.dispatchEvent(outsideUpTen)
    document.body.dispatchEvent(cancelledUpEleven)

    expect(cancelEleven.defaultPrevented).toBe(true)
    expect(outsideUpTen.defaultPrevented).toBe(true)
    expect(cancelledUpEleven.defaultPrevented).toBe(false)

    const freshDown = pointerEvent('pointerdown', 12)
    const freshUp = pointerEvent('pointerup', 12)
    const freshClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    underlyingPlayer.dispatchEvent(freshDown)
    underlyingPlayer.dispatchEvent(freshUp)
    underlyingPlayer.dispatchEvent(freshClick)
    await nextTick()

    expect(freshDown.defaultPrevented).toBe(true)
    expect(freshUp.defaultPrevented).toBe(true)
    expect(freshClick.defaultPrevented).toBe(true)
    expect(closeCount.value).toBe(1)
    expect(underlyingEvents.value).toEqual([])
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(harnessOpener.element)

    const postCloseDown = pointerEvent('pointerdown', 13)
    underlyingPlayer.dispatchEvent(postCloseDown)
    expect(postCloseDown.defaultPrevented).toBe(false)
    expect(underlyingEvents.value).toEqual(['pointerdown'])
    wrapper.unmount()
  })

  it('prefers an explicitly supplied return-focus target over the captured opener', async () => {
    const explicit = document.createElement('button')
    explicit.textContent = 'Live pomodoro control'
    document.body.append(explicit)
    const wrapper = mount(OverlaySheet, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Focus summary',
        modal: true,
        returnFocusTo: () => explicit,
      },
    })

    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await nextTick()

    expect(document.activeElement).toBe(explicit)
    wrapper.unmount()
  })

  it('hands one modal sheet to another without a stale opener or a focus fight', async () => {
    const returnTarget = document.createElement('button')
    returnTarget.textContent = 'Quick action'
    document.body.append(returnTarget)
    const Harness = defineComponent({
      components: { OverlaySheet },
      props: { returnTarget: { type: Object as unknown as () => HTMLElement, required: true } },
      setup(props) {
        const active = ref<'first' | 'second' | 'none'>('first')
        return { active, resolveReturn: () => props.returnTarget }
      },
      template: `
        <OverlaySheet :open="active === 'second'" title="Second" name="second" modal :return-focus-to="resolveReturn" @close="active = 'none'">
          <button data-inside-second type="button">Inside second</button>
        </OverlaySheet>
        <OverlaySheet :open="active === 'first'" title="First" name="first" modal @close="active = 'none'">
          <button data-hand-off type="button" @click="active = 'second'">Hand off</button>
        </OverlaySheet>
      `,
    })
    const wrapper = mount(Harness, { attachTo: document.body, props: { returnTarget } })

    await wrapper.get('[data-hand-off]').trigger('click')
    await nextTick()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[data-overlay-sheet="second"]').element).toBeTruthy()
    expect(wrapper.get('[data-overlay-sheet="second"]').element.contains(document.activeElement))
      .toBe(true)

    await wrapper.get('[data-overlay-sheet="second"]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(0)
    expect(document.activeElement).toBe(returnTarget)
    wrapper.unmount()
  })

  it('removes every modal document listener when unmounted while open', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const wrapper = mount(OverlaySheet, {
      attachTo: document.body,
      props: { open: true, title: 'Library', modal: true },
    })
    const listenerTypes = ['focusin', 'pointerdown', 'pointerup', 'pointercancel', 'click'] as const
    const listeners = listenerTypes.map((type) => ({
      listener: addListener.mock.calls.find(([eventType]) => eventType === type)?.[1],
      type,
    }))

    wrapper.unmount()

    for (const { listener, type } of listeners) {
      expect(listener, `${type} listener`).toBeTypeOf('function')
      expect(removeListener).toHaveBeenCalledWith(type, listener, true)
    }
  })
})
