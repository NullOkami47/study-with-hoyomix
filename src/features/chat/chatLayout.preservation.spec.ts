// Generated geometry baselines and seeded layout properties; no user conversation data.
import { mount } from '@vue/test-utils'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import * as chatLayout from './chatLayout'
import {
  CHAT_LAYOUT_STORAGE_KEY,
  CHAT_SAFE_MARGIN,
  clampChatLayout,
  maxChatSize,
  minChatHeight,
  MIN_CHAT_WIDTH,
  parseChatLayout,
  reconcileChatLayout,
  resolveChatLayout,
  serialiseChatLayout,
  type ChatLayout,
  type Rect,
  type Viewport,
} from './chatLayout'
import observed from './__fixtures__/chat-layout-synthetic-baseline.json'
import FloatingChatWindow from './FloatingChatWindow.vue'

type ObservedCase = { fn: string; args: unknown[]; result: unknown }
const cases = (observed as unknown as { cases: ObservedCase[] }).cases
/** JSON stored an omitted `reserved` as null; null and undefined are treated alike by chatLayout.ts. */
const call = (fn: string, args: unknown[]) =>
  (chatLayout as unknown as Record<string, (...values: unknown[]) => unknown>)[fn]!(
    ...args.map((value, index) => value === null && !(index === 0 && (fn === 'parseChatLayout' || fn === 'resolveChatLayout')) ? undefined : value),
  ) ?? null

describe('Wave G: chat layout geometry is unchanged (Property 24 geometry part)', () => {
  it('reproduces every observed output of the remaining chatLayout exports', () => {
    expect(cases.length).toBeGreaterThan(500)
    expect(new Set(cases.map((entry) => entry.fn))).toEqual(new Set([
      'maxChatSize', 'minChatHeight', 'defaultChatLayout', 'defaultNarrowChatLayout',
      'clampChatLayout', 'reconcileChatLayout', 'resolveChatLayout', 'parseChatLayout',
    ]))
    const mismatches = cases.filter((entry) => JSON.stringify(call(entry.fn, entry.args)) !== JSON.stringify(entry.result))
    expect(mismatches.slice(0, 3)).toEqual([])
  })

  const desktop = fc.record({ width: fc.constantFrom(768, 1280, 1440), height: fc.integer({ min: 720, max: 1200 }), top: fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined }) })
  const anyLayout = fc.record({ x: fc.integer({ min: -4000, max: 4000 }), y: fc.integer({ min: -4000, max: 4000 }), width: fc.integer({ min: 1, max: 4000 }), height: fc.integer({ min: 1, max: 4000 }) })

  it('clamps any layout inside the desktop viewport, below the reserved top, at a usable size, idempotently', () => {
    fc.assert(fc.property(desktop, anyLayout, (viewport: Viewport, layout: ChatLayout) => {
      const clamped = clampChatLayout(layout, viewport)
      const top = Math.max(CHAT_SAFE_MARGIN, viewport.top ?? 0)
      expect(clamped.width).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH)
      expect(clamped.width).toBeLessThanOrEqual(maxChatSize(viewport).width)
      expect(clamped.height).toBeGreaterThanOrEqual(minChatHeight(viewport))
      expect(clamped.height).toBeLessThanOrEqual(maxChatSize(viewport).height)
      expect(clamped.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
      expect(clamped.x + clamped.width).toBeLessThanOrEqual(viewport.width - CHAT_SAFE_MARGIN)
      expect(clamped.y).toBeGreaterThanOrEqual(top)
      expect(clamped.y + clamped.height).toBeLessThanOrEqual(viewport.height - CHAT_SAFE_MARGIN)
      expect(clampChatLayout(clamped, viewport)).toEqual(clamped)
    }), { numRuns: 300 })
  })

  it('restores a stored layout the viewport already holds unchanged, and round-trips only the geometry', () => {
    fc.assert(fc.property(desktop, anyLayout, (viewport: Viewport, layout: ChatLayout) => {
      const clamped = clampChatLayout(layout, viewport)
      expect(parseChatLayout(serialiseChatLayout({ ...clamped, extra: 1 } as ChatLayout))).toEqual(clamped)
      expect(resolveChatLayout(serialiseChatLayout(clamped), viewport)).toEqual(clamped)
    }), { numRuns: 200 })
  })
})

// --- FloatingChatWindow at the 768 / 1280 / 1440 desktop widths (3.16) -------------------------
function pointer(type: string, init: { clientX: number; clientY: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: init.clientX, clientY: init.clientY, pointerId: 1, button: 0 })
  return event
}
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height, writable: true })
}
function geometry(element: HTMLElement): ChatLayout {
  const [x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(element.style.transform)?.slice(1) ?? ['0', '0']
  return { x: Number(x), y: Number(y), width: Number.parseFloat(element.style.width), height: Number.parseFloat(element.style.height) }
}
const overlaps = (a: ChatLayout, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
/** The Player card (preferred) and its seek and control rows (protected), docked bottom-left. */
const playerFor = (width: number, height: number): Rect[] => {
  const cardWidth = width >= 1280 ? 480 : width - 32
  const card = { x: 16, y: height - 200, width: cardWidth, height: 184 }
  return [card, { x: 16, y: card.y + 96, width: cardWidth, height: 24 }, { x: 16, y: card.y + 128, width: cardWidth, height: 40 }]
}

beforeEach(() => {
  window.localStorage.clear()
  usePreferences().setLocale('en')
  Element.prototype.setPointerCapture = function setPointerCapture() {}
  Element.prototype.releasePointerCapture = function releasePointerCapture() {}
})
afterEach(() => { document.body.innerHTML = '' })

describe('Wave G: the desktop floating chat keeps drag, resize and Player avoidance (3.16)', () => {
  const scenario = fc.record({
    width: fc.constantFrom(768, 1280, 1440), height: fc.integer({ min: 720, max: 1100 }),
    gesture: fc.constantFrom('move', 'resize'), dx: fc.integer({ min: -2000, max: 2000 }), dy: fc.integer({ min: -2000, max: 2000 }),
  })

  it('opens clear of the Player, follows a gesture through clamp and reconcile, stays on screen and remembers it', async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ width, height, gesture, dx, dy }) => {
      window.localStorage.clear()
      document.body.innerHTML = ''
      setViewport(width, height)
      const regions = playerFor(width, height)
      const wrapper = mount(FloatingChatWindow, { attachTo: document.body, props: { reserved: () => regions }, slots: { default: '<p>chat body</p>' } })
      const chat = wrapper.get<HTMLElement>('[data-floating-chat]').element
      expect(wrapper.get('[data-floating-chat]').attributes('data-chat-narrow')).toBe('false')
      const before = geometry(chat)
      for (const region of regions) expect(overlaps(before, region)).toBe(false)

      const handle = wrapper.get(gesture === 'move' ? '[data-floating-chat-handle]' : '[data-floating-chat-resize]').element
      handle.dispatchEvent(pointer('pointerdown', { clientX: 400, clientY: 400 }))
      handle.dispatchEvent(pointer('pointermove', { clientX: 400 + dx, clientY: 400 + dy }))
      handle.dispatchEvent(pointer('pointerup', { clientX: 400 + dx, clientY: 400 + dy }))
      await wrapper.vm.$nextTick()

      const viewport = { width, height }
      const requested = gesture === 'move'
        ? { ...before, x: before.x + dx, y: before.y + dy }
        : { ...before, width: before.width + dx, height: before.height + dy }
      const after = geometry(chat)
      expect(after).toEqual(reconcileChatLayout(clampChatLayout(requested, viewport), viewport, regions, true))
      expect(after.x).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
      expect(after.y).toBeGreaterThanOrEqual(CHAT_SAFE_MARGIN)
      expect(after.x + after.width).toBeLessThanOrEqual(width - CHAT_SAFE_MARGIN)
      expect(after.y + after.height).toBeLessThanOrEqual(height - CHAT_SAFE_MARGIN)
      for (const region of regions.slice(1)) expect(overlaps(after, region)).toBe(false)
      expect(parseChatLayout(window.localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY))).toEqual(after)
      wrapper.unmount()
    }), { numRuns: 30 })
  })
})
