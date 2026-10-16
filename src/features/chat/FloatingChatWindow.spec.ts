import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import {
  CHAT_LAYOUT_STORAGE_KEY,
  CHAT_SAFE_MARGIN,
  MIN_CHAT_HEIGHT,
  MIN_CHAT_WIDTH,
  MIN_DERIVED_CHAT_HEIGHT,
  parseChatLayout,
  serialiseChatLayout,
} from './chatLayout'
import FloatingChatWindow from './FloatingChatWindow.vue'

/**
 * jsdom implements neither pointer capture nor a layout engine, so the gestures are
 * driven through the same PointerEvent sequence a browser delivers and the geometry is
 * read from the style the component wrote. What is under test is the component's
 * arithmetic and its clamping, which is exactly the part a browser would not check for
 * us. E2E covers the real pointer path.
 */
function pointer(type: string, init: { clientX: number; clientY: number; pointerId?: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: init.clientX, clientY: init.clientY, pointerId: init.pointerId ?? 1, button: 0 })
  return event
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height, writable: true })
}

function geometry(element: HTMLElement): { x: number; y: number; width: number; height: number } {
  const [x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(element.style.transform)?.slice(1) ?? ['0', '0']
  return {
    x: Number(x),
    y: Number(y),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }
}

function mountWindow(reserved?: () => { x: number; y: number; width: number; height: number } | { x: number; y: number; width: number; height: number }[]) {
  return mount(FloatingChatWindow, {
    attachTo: document.body,
    props: { reserved },
    slots: { default: '<p data-chat-slot>chat body</p>' },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  usePreferences().setLocale('en')
  setViewport(1440, 900)
  // jsdom leaves these undefined; the component treats a refusal as non-fatal, and the
  // stubs keep that path out of the way of the arithmetic under test.
  Element.prototype.setPointerCapture = function setPointerCapture() {}
  Element.prototype.releasePointerCapture = function releasePointerCapture() {}
})

afterEach(() => { document.body.innerHTML = '' })

describe('FloatingChatWindow', () => {
  it('opens at a valid default layout on a first visit and renders the slotted body', () => {
    const wrapper = mountWindow()
    const box = geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element)

    expect(box.x + box.width).toBe(1440 - CHAT_SAFE_MARGIN)
    expect(box.y + box.height).toBe(900 - CHAT_SAFE_MARGIN)
    expect(wrapper.get('[data-chat-slot]').text()).toBe('chat body')
    // A labelled landmark region, not a dialog: the window blocks nothing and traps no
    // focus, so it must not announce itself as something the user has to dismiss.
    const chat = wrapper.get('[data-floating-chat]')
    expect(chat.element.tagName).toBe('SECTION')
    expect(chat.attributes('role')).toBeUndefined()
    expect(chat.attributes('aria-modal')).toBeUndefined()
  })

  it('minimally reconciles and remembers a user layout when Player controls expand into it', async () => {
    const saved = { x: 16, y: 360, width: 352, height: 320 }
    window.localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, serialiseChatLayout(saved))
    setViewport(900, 900)
    let regions = [
      { x: 16, y: 700, width: 868, height: 184 },
      { x: 16, y: 760, width: 868, height: 92 },
    ]
    const wrapper = mountWindow(() => regions)
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]').element

    expect(geometry(chat)).toEqual(saved)

    // The Player grows upward from the bottom edge; its artwork may share space, but its
    // seek and control rows remain clear. A nearer safe placement above those rows wins.
    regions = [
      { x: 16, y: 200, width: 868, height: 684 },
      { x: 16, y: 620, width: 868, height: 24 },
      { x: 16, y: 650, width: 868, height: 180 },
    ]
    wrapper.vm.renegotiate()
    await wrapper.vm.$nextTick()

    const reconciled = geometry(chat)
    expect(reconciled).toEqual({ ...saved, y: 300 })
    expect(parseChatLayout(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY))).toEqual(reconciled)
    for (const protectedRegion of regions.slice(1)) {
      expect(reconciled.x < protectedRegion.x + protectedRegion.width
        && reconciled.x + reconciled.width > protectedRegion.x
        && reconciled.y < protectedRegion.y + protectedRegion.height
        && reconciled.y + reconciled.height > protectedRegion.y).toBe(false)
    }
  })
  it('restores a saved layout and reports the title through aria-labelledby', () => {
    window.localStorage.setItem(
      CHAT_LAYOUT_STORAGE_KEY,
      serialiseChatLayout({ x: 200, y: 120, width: 400, height: 420 }),
    )
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]')

    expect(geometry(chat.element)).toEqual({ x: 200, y: 120, width: 400, height: 420 })
    const labelledBy = chat.attributes('aria-labelledby')!
    expect(wrapper.get(`#${labelledBy}`).text()).toBe('Study chat')
  })

  it('falls back to the default when the saved layout is malformed', () => {
    window.localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, '{"x":null,"width":"wide"}')
    const wrapper = mountWindow()
    const box = geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element)

    expect(box.x + box.width).toBe(1440 - CHAT_SAFE_MARGIN)
  })

  it('pulls a layout saved on a larger display inside the current viewport', () => {
    window.localStorage.setItem(
      CHAT_LAYOUT_STORAGE_KEY,
      serialiseChatLayout({ x: 2400, y: 1300, width: 900, height: 800 }),
    )
    setViewport(1024, 700)
    const wrapper = mountWindow()
    const box = geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element)

    expect(box.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
    expect(box.x + box.width).toBeLessThanOrEqual(1024 - CHAT_SAFE_MARGIN)
    expect(box.y + box.height).toBeLessThanOrEqual(700 - CHAT_SAFE_MARGIN)
  })

  it('keeps the default clear of a reserved player region', () => {
    const player = { x: 16, y: 640, width: 700, height: 200 }
    setViewport(768, 900)
    const wrapper = mountWindow(() => player)
    const box = geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element)

    expect(box.y + box.height).toBeLessThanOrEqual(player.y)
  })

  it('moves on a header drag, persists the result, and never leaves the viewport', async () => {
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]').element
    const handle = wrapper.get('[data-floating-chat-handle]').element
    const before = geometry(chat)

    handle.dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 500 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 300, clientY: 320 }))
    await wrapper.vm.$nextTick()

    const during = geometry(chat)
    expect(during.x).toBe(before.x - 200)
    expect(during.y).toBe(before.y - 180)
    expect(wrapper.get('[data-floating-chat]').attributes('data-chat-dragging')).toBe('true')

    handle.dispatchEvent(pointer('pointerup', { clientX: 300, clientY: 320 }))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-floating-chat]').attributes('data-chat-dragging')).toBe('false')
    expect(parseChatLayout(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY))).toEqual(during)

    // A drag that overshoots the edge stops at the safe margin rather than escaping.
    handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 320 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: -4000, clientY: -4000 }))
    handle.dispatchEvent(pointer('pointerup', { clientX: -4000, clientY: -4000 }))
    await wrapper.vm.$nextTick()

    expect(geometry(chat)).toMatchObject({ x: CHAT_SAFE_MARGIN, y: CHAT_SAFE_MARGIN })
  })

  it('does not start a drag from a control inside the header', async () => {
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]').element
    const handle = wrapper.get('[data-floating-chat-handle]').element
    const before = geometry(chat)

    wrapper.get('[data-floating-chat-close]').element
      .dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 500 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 200 }))
    await wrapper.vm.$nextTick()

    expect(geometry(chat)).toEqual(before)
    expect(wrapper.get('[data-floating-chat]').attributes('data-chat-dragging')).toBe('false')
  })

  it('resizes from the corner handle within the usable bounds', async () => {
    window.localStorage.setItem(
      CHAT_LAYOUT_STORAGE_KEY,
      serialiseChatLayout({ x: 100, y: 100, width: 400, height: 420 }),
    )
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]').element
    const grip = wrapper.get('[data-floating-chat-resize]').element

    grip.dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 520 }))
    grip.dispatchEvent(pointer('pointermove', { clientX: 620, clientY: 660 }))
    await wrapper.vm.$nextTick()

    expect(geometry(chat)).toMatchObject({ width: 520, height: 560 })

    // Dragging far back up stops at the minimum usable size, not below it.
    grip.dispatchEvent(pointer('pointermove', { clientX: 0, clientY: 0 }))
    grip.dispatchEvent(pointer('pointerup', { clientX: 0, clientY: 0 }))
    await wrapper.vm.$nextTick()

    expect(geometry(chat)).toMatchObject({ width: MIN_CHAT_WIDTH, height: MIN_CHAT_HEIGHT })
    expect(parseChatLayout(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)))
      .toMatchObject({ width: MIN_CHAT_WIDTH, height: MIN_CHAT_HEIGHT })
  })

  it('emits close without discarding the remembered layout', async () => {
    const wrapper = mountWindow()
    const handle = wrapper.get('[data-floating-chat-handle]').element
    handle.dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 500 }))
    handle.dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 400 }))
    handle.dispatchEvent(pointer('pointerup', { clientX: 400, clientY: 400 }))
    await wrapper.vm.$nextTick()
    const saved = window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)

    await wrapper.get('[data-floating-chat-close]').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)).toBe(saved)
  })

  it('withholds drag and resize on a narrow viewport while keeping chat and close usable', async () => {
    setViewport(375, 667)
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]')
    const before = chat.element.getAttribute('style')

    expect(chat.attributes('data-chat-narrow')).toBe('true')
    expect(wrapper.find('[data-floating-chat-resize]').exists()).toBe(false)

    wrapper.get('[data-floating-chat-handle]').element
      .dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100 }))
    wrapper.get('[data-floating-chat-handle]').element
      .dispatchEvent(pointer('pointermove', { clientX: 300, clientY: 300 }))
    await wrapper.vm.$nextTick()

    // A gesture writes nothing at all: the sheet's placement belongs to CSS here, so
    // there is no inline box for a drag to move even by accident.
    expect(chat.element.getAttribute('style')).toBe(before)
    expect(chat.element.style.transform).toBe('')
    expect(wrapper.find('[data-floating-chat-close]').exists()).toBe(true)
  })

  /**
   * On a phone the window is not a small floating window -- it is a sheet. Clamping desktop
   * coordinates into a 375px viewport produces something that still behaves like a window
   * whose gestures have been taken away: an arbitrary inset position, a size derived from
   * whatever the user last dragged on a monitor, and no relationship to the player it has
   * to share the screen with.
   *
   * So the geometry is handed to CSS at narrow widths, and the remembered desktop layout is
   * left alone rather than being overwritten by the sheet's placement. A user who opens the
   * site on their phone and then on their laptop finds the window where they left it.
   */
  describe('narrow-screen sheet', () => {
    it('hands its geometry to CSS instead of writing an inline window box', () => {
      setViewport(375, 667)
      const wrapper = mountWindow()
      const chat = wrapper.get<HTMLElement>('[data-floating-chat]')

      expect(chat.attributes('data-chat-narrow')).toBe('true')
      // No inline transform or size: a fixed sheet cannot be expressed as a clamped
      // window box, and leaving both here would let the two fight over placement.
      expect(chat.element.style.transform).toBe('')
      expect(chat.element.style.width).toBe('')
      expect(chat.element.style.height).toBe('')
      // The parts that must survive the switch.
      expect(wrapper.find('[data-floating-chat-close]').exists()).toBe(true)
      expect(wrapper.find('[data-chat-slot]').exists()).toBe(true)
      expect(wrapper.find('[data-floating-chat-resize]').exists()).toBe(false)
      expect(wrapper.find('.chat-window__grip').exists()).toBe(false)
    })

    it('never overwrites the remembered desktop layout with sheet geometry', async () => {
      const saved = serialiseChatLayout({ x: 900, y: 220, width: 420, height: 500 })
      window.localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, saved)
      setViewport(1440, 900)
      const wrapper = mountWindow()

      setViewport(375, 667)
      window.dispatchEvent(new Event('resize'))
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[data-floating-chat]').attributes('data-chat-narrow')).toBe('true')
      expect(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)).toBe(saved)

      // Landscape on the same phone is still narrow, and still must not touch the record.
      setViewport(667, 375)
      window.dispatchEvent(new Event('resize'))
      await wrapper.vm.$nextTick()
      expect(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)).toBe(saved)

      // Back to the monitor: the layout the user chose there, unchanged.
      setViewport(1440, 900)
      window.dispatchEvent(new Event('resize'))
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[data-floating-chat]').attributes('data-chat-narrow')).toBe('false')
      expect(geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element))
        .toEqual({ x: 900, y: 220, width: 420, height: 500 })
      expect(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)).toBe(saved)
    })

    /**
     * The concession the sheet has to make, and the order it makes it in. A landscape phone
     * gives the player most of the viewport, so clearing the whole player card would leave
     * the sheet a header with no body. The player offers weaker claims for exactly this,
     * and the strongest one that still leaves a usable sheet is the one that wins.
     */
    it('gives up the player card for its transport rather than becoming a slit', async () => {
      setViewport(667, 375)
      // The whole card is preferred; only the lower rectangle is protected: the
      // transport. 375 - 105 = 270px of a 375px viewport for the card, which cannot be
      // cleared and leave 140px; the transport at 223 can.
      const wrapper = mountWindow(() => ({ x: 0, y: 105, width: 667, height: 270 }) as never)
      await wrapper.vm.$nextTick()
      const slit = wrapper.get<HTMLElement>('[data-floating-chat]').element
      const band = (element: HTMLElement) => Number.parseFloat(element.style.getPropertyValue('--chat-sheet-block-end'))
      // One region only, so there is nothing weaker to fall back to and the sheet takes it.
      expect(band(slit)).toBe(375 - 105 + CHAT_SAFE_MARGIN)
      wrapper.unmount()

      const laddered = mount(FloatingChatWindow, {
        attachTo: document.body,
        props: {
          reserved: () => [
            { x: 0, y: 105, width: 667, height: 270 },
            { x: 0, y: 223, width: 667, height: 152 },
          ],
        },
        slots: { default: '<p data-chat-slot>chat body</p>' },
      })
      await laddered.vm.$nextTick()
      const sheet = laddered.get<HTMLElement>('[data-floating-chat]').element
      // The transport's claim, not the card's: 375 - 223 + 16 = 168, which leaves
      // 375 - 16 - 168 = 191px of room -- above the 140px floor a sheet needs.
      expect(band(sheet)).toBe(375 - 223 + CHAT_SAFE_MARGIN)
      expect(375 - CHAT_SAFE_MARGIN - band(sheet)).toBeGreaterThanOrEqual(MIN_DERIVED_CHAT_HEIGHT)
      laddered.unmount()
    })

    it('reloading while narrow keeps the desktop layout to come back to', () => {
      const saved = serialiseChatLayout({ x: 900, y: 220, width: 420, height: 500 })
      window.localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, saved)
      setViewport(375, 667)
      const narrow = mountWindow()
      expect(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)).toBe(saved)
      narrow.unmount()

      setViewport(1440, 900)
      const wide = mountWindow()
      expect(geometry(wide.get<HTMLElement>('[data-floating-chat]').element))
        .toEqual({ x: 900, y: 220, width: 420, height: 500 })
    })
  })

  // A window that is still a window: 900px is above the narrow threshold, so the clamp is
  // what keeps it on screen. Below that threshold there is no box to clamp -- the sheet
  // rules own the placement, which the narrow-screen suite covers on its own terms.
  it('re-clamps to a shrunken viewport so the window is never stranded', async () => {
    const wrapper = mountWindow()

    setViewport(900, 600)
    window.dispatchEvent(new Event('resize'))
    await wrapper.vm.$nextTick()

    const box = geometry(wrapper.get<HTMLElement>('[data-floating-chat]').element)
    expect(box.x + box.width).toBeLessThanOrEqual(900 - CHAT_SAFE_MARGIN)
    expect(box.y + box.height).toBeLessThanOrEqual(600 - CHAT_SAFE_MARGIN)
  })

  it('blocks interaction and gestures while a modal owns the screen above it', async () => {
    const wrapper = mountWindow()
    const chat = wrapper.get<HTMLElement>('[data-floating-chat]')
    const before = geometry(chat.element)

    await wrapper.setProps({ inert: true })

    expect(chat.attributes('inert')).toBeDefined()
    expect(chat.attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[data-floating-chat-resize]').exists()).toBe(false)

    wrapper.get('[data-floating-chat-handle]').element
      .dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 500 }))
    wrapper.get('[data-floating-chat-handle]').element
      .dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 200 }))
    await wrapper.vm.$nextTick()

    expect(geometry(chat.element)).toEqual(before)
  })
})
