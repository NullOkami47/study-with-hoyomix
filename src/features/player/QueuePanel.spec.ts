import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import QueuePanel from './QueuePanel.vue'
import { createPlaybackStore, type PlaybackStore } from './store'

const track = (id: string, title = id): Track => ({
  id,
  title,
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: [],
  workGroupId: 'work',
  needsClassification: true,
  vocalStatus: 'uncertain',
  sources: [],
})

const pointerDescriptors = [
  [Element.prototype, 'setPointerCapture', Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')],
  [Element.prototype, 'releasePointerCapture', Object.getOwnPropertyDescriptor(Element.prototype, 'releasePointerCapture')],
  [HTMLElement.prototype, 'setPointerCapture', Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture')],
  [HTMLElement.prototype, 'releasePointerCapture', Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'releasePointerCapture')],
  [document, 'elementFromPoint', Object.getOwnPropertyDescriptor(document, 'elementFromPoint')],
] as const



function dispatchPointer(target: EventTarget, type: string, pointerId = 1, clientX = 10, clientY = 10): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    clientX: { configurable: true, value: clientX },
    clientY: { configurable: true, value: clientY },
    button: { configurable: true, value: 0 },
  })
  target.dispatchEvent(event)
}

function storeFor(queue: Track[], currentIndex: number): Pick<PlaybackStore,
  'currentIndex' | 'next' | 'playQueueIndex' | 'previous' | 'queue' | 'removeQueueIndex' | 'moveQueueItem' | 'playNext' | 'clearUpcomingQueue'
> {
  return {
    currentIndex: ref(currentIndex),
    queue: ref(queue),
    next: vi.fn(),
    previous: vi.fn(),
    playQueueIndex: vi.fn(),
    removeQueueIndex: vi.fn(() => true),
    moveQueueItem: vi.fn(() => true),
    playNext: vi.fn(),
    clearUpcomingQueue: vi.fn(),
  }
}

describe('QueuePanel', () => {
  it('exposes accessible shuffle and repeat controls backed by persisted store state', async () => {
    const storage = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() }
    const store = createPlaybackStore({ storage, random: () => 0 })
    store.reconcileUpcomingQueue([track('first'), track('second'), track('third')])
    const wrapper = mount(QueuePanel, { props: { store } })
    expect(wrapper.get('[data-queue-shuffle]').attributes('aria-pressed')).toBe('false')
    await wrapper.get('[data-queue-shuffle]').trigger('click')
    expect(store.shuffle.value).toBe(true)
    expect(wrapper.get('[data-queue-shuffle]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[data-queue-repeat]').trigger('click')
    expect(store.repeatMode.value).toBe('all')
    expect(wrapper.get('[data-queue-repeat]').attributes('aria-label')).toContain('All')
    expect(storage.setItem).toHaveBeenCalledWith('hoyomix-player-repeat-v1', 'all')
    wrapper.unmount()
  })
  it('windows a 3,004-track upcoming queue and keeps distant rows reachable by scrolling', async () => {
    const many = Array.from({ length: 3004 }, (_, index) => track(`track-${index}`))
    const wrapper = mount(QueuePanel, { props: { store: storeFor(many, -1) } })
    expect(wrapper.findAll('[data-queue-up-next]').length).toBeLessThan(40)
    expect(wrapper.findAll('[data-queue-play-now]').length).toBeLessThan(40)
    expect(wrapper.text()).toContain('3004')
    const viewport = wrapper.get<HTMLElement>('[data-queue-viewport]')
    viewport.element.scrollTop = 2990 * 62
    await viewport.trigger('scroll')
    expect(wrapper.findAll('[data-queue-up-next]').length).toBeLessThan(40)
    expect(wrapper.find('[data-queue-track="track-2990"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows played history after advancing without duplicating queue tracks', async () => {
    const store = createPlaybackStore({ storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    store.reconcileUpcomingQueue([track('first'), track('second'), track('third')])
    await store.playQueueIndex(0)
    await store.next()
    const wrapper = mount(QueuePanel, { props: { store } })
    expect(wrapper.get('[data-queue-history][data-queue-track="first"]').text()).toContain('first')
    expect(wrapper.get('[data-queue-now-playing]').attributes('data-queue-track')).toBe('second')
    await wrapper.get('[data-queue-history-toggle]').trigger('click')
    expect(wrapper.find('[data-queue-history]').exists()).toBe(false)
    wrapper.unmount()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [target, key, descriptor] of pointerDescriptors) {
      if (descriptor) Object.defineProperty(target, key, 'value' in descriptor ? { ...descriptor, writable: true } : descriptor)
      else Reflect.deleteProperty(target, key)
    }
  })

  it('renders a protected Now Playing row and controls for each upcoming track', () => {
    const first = track('first', 'First')
    const current = track('current', 'Current')
    const second = track('second', 'Second')
    const third = track('third', 'Third')
    const store = storeFor([first, current, second, third], 1)
    const wrapper = mount(QueuePanel, { props: { store } })

    expect(wrapper.get('[data-queue-now-playing]').text()).toContain('Current')
    expect(wrapper.get('[data-queue-now-playing]').attributes('aria-current')).toBe('true')
    expect(wrapper.find('[data-queue-now-playing] [data-queue-remove]').exists()).toBe(false)
    expect(wrapper.findAll('[data-queue-up-next]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-drag-handle]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-play-now]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-play-next]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-remove]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-move-up]')).toHaveLength(2)
    expect(wrapper.findAll('[data-queue-move-down]')).toHaveLength(2)
  })

  it('keeps deterministic queue navigation and routes row actions to the store', async () => {
    const first = track('first', 'First')
    const current = track('current', 'Current')
    const second = track('second', 'Second')
    const store = storeFor([first, current, second], 1)
    const wrapper = mount(QueuePanel, { props: { store } })

    await wrapper.get('[aria-label="Play Second from queue"]').trigger('click')
    expect(store.playQueueIndex).toHaveBeenCalledWith(2)

    await wrapper.get('[data-queue-play-next="second"]').trigger('click')
    expect(store.playNext).toHaveBeenCalledWith(second)

    await wrapper.get('[data-queue-remove="second"]').trigger('click')
    expect(store.removeQueueIndex).toHaveBeenCalledWith(2)

    await wrapper.get('[data-queue-clear]').trigger('click')
    expect(store.clearUpcomingQueue).toHaveBeenCalledOnce()
  })

  it('provides keyboard reorder alternatives without crossing the protected current row', async () => {
    const current = track('current', 'Current')
    const second = track('second', 'Second')
    const third = track('third', 'Third')
    const store = storeFor([current, second, third], 0)
    const wrapper = mount(QueuePanel, { props: { store } })

    expect(wrapper.get('[data-queue-move-up="second"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-queue-move-down="second"]').trigger('click')
    expect(store.moveQueueItem).toHaveBeenCalledWith(1, 2)
    await wrapper.get('[data-queue-move-up="third"]').trigger('click')
    expect(store.moveQueueItem).toHaveBeenCalledWith(2, 1)
  })

  it('hands keyboard focus to the same row\'s inverse control after a move, in both directions', async () => {
    const store = createPlaybackStore()
    store.enqueue(track('first'))
    store.enqueue(track('second'))
    store.enqueue(track('third'))
    store.enqueue(track('fourth'))
    await store.playQueueIndex(0)
    const wrapper = mount(QueuePanel, { props: { store }, attachTo: document.body })
    const order = (): Array<string | undefined> =>
      wrapper.findAll('[data-queue-up-next]').map((row) => row.attributes('data-queue-track'))
    const button = (selector: string): HTMLButtonElement => wrapper.get<HTMLButtonElement>(selector).element
    // `detail` is what separates a keyboard activation from a pointer one, and it is read-only on
    // a UIEvent, so the click is constructed directly rather than through the wrapper's trigger.
    const activate = (selector: string, detail: number): void => {
      button(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
    }

    // Four queued tracks leave three upcoming rows, so the first, a middle and the last position
    // are all exercised rather than only the two-row case the browser fixture happens to have.
    expect(order()).toEqual(['second', 'third', 'fourth'])

    // Front row moving down. The pressed control is the one that becomes disabled, so focus has
    // to land on the same row's Move Up, which is the guaranteed inverse action.
    button('[data-queue-move-down="second"]').focus()
    activate('[data-queue-move-down="second"]', 0)
    await nextTick()
    expect(order()).toEqual(['third', 'second', 'fourth'])
    expect(button('[data-queue-move-up="second"]').disabled).toBe(false)
    expect(document.activeElement).toBe(button('[data-queue-move-up="second"]'))

    // The same row moving back up hands focus to its Move Down, so the handover is a property of
    // the reorder rather than of one direction.
    activate('[data-queue-move-up="second"]', 0)
    await nextTick()
    expect(order()).toEqual(['second', 'third', 'fourth'])
    expect(document.activeElement).toBe(button('[data-queue-move-down="second"]'))

    // Last row moving up is the mirrored edge: that row's Move Up is what disables.
    button('[data-queue-move-up="fourth"]').focus()
    activate('[data-queue-move-up="fourth"]', 0)
    await nextTick()
    expect(order()).toEqual(['second', 'fourth', 'third'])
    expect(button('[data-queue-move-down="fourth"]').disabled).toBe(false)
    expect(document.activeElement).toBe(button('[data-queue-move-down="fourth"]'))

    // A pointer activation must not relocate focus as a side effect of reordering, so the
    // opposite control is deliberately left alone.
    button('[data-queue-move-down="second"]').focus()
    activate('[data-queue-move-down="second"]', 1)
    await nextTick()
    expect(order()).toEqual(['fourth', 'second', 'third'])
    expect(document.activeElement).not.toBe(button('[data-queue-move-up="second"]'))

    wrapper.unmount()
  })

  it('commits one pointer drag by stable track identity and cancels pointercancel cleanly', async () => {
    const current = track('current', 'Current')
    const second = track('second', 'Second')
    const third = track('third', 'Third')
    const store = storeFor([current, second, third], 0)
    const wrapper = mount(QueuePanel, { props: { store } })
    const secondRow = wrapper.get('[data-queue-track="second"]')
    const thirdRow = wrapper.get('[data-queue-track="third"]')
    const secondHandle = secondRow.get('[data-queue-drag-handle]')
    const thirdElement = thirdRow.element

    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => thirdElement) })

    const pointer = (type: string, pointerId: number, clientX = 10, clientY = 10): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        pointerId: { configurable: true, value: pointerId },
        clientX: { configurable: true, value: clientX },
        clientY: { configurable: true, value: clientY },
        button: { configurable: true, value: 0 },
      })
      return event
    }

    secondHandle.element.dispatchEvent(pointer('pointerdown', 7))
    await wrapper.vm.$nextTick()
    expect(secondRow.attributes('data-queue-dragging')).toBe('true')
    secondHandle.element.dispatchEvent(pointer('pointermove', 7, 10, 100))
    secondHandle.element.dispatchEvent(pointer('pointerup', 7, 10, 100))
    await wrapper.vm.$nextTick()
    expect(store.moveQueueItem).toHaveBeenCalledOnce()
    expect(store.moveQueueItem).toHaveBeenCalledWith(1, 2)
    expect(secondRow.attributes('data-queue-dragging')).toBe('false')

    secondHandle.element.dispatchEvent(pointer('pointerdown', 8))
    secondHandle.element.dispatchEvent(pointer('pointermove', 8, 10, 100))
    secondHandle.element.dispatchEvent(pointer('pointercancel', 8))
    await wrapper.vm.$nextTick()
    expect(store.moveQueueItem).toHaveBeenCalledOnce()
  })

  it('cleans up a drag when its source row disappears so another row can start', async () => {
    const store = createPlaybackStore()
    store.enqueue(track('first'))
    store.enqueue(track('second'))
    store.enqueue(track('third'))
    const wrapper = mount(QueuePanel, { props: { store }, attachTo: document.body })
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })

    const sourceHandle = wrapper.get('[data-queue-track="first"] [data-queue-drag-handle]').element
    dispatchPointer(sourceHandle, 'pointerdown', 1)
    await nextTick()
    expect(wrapper.get('[data-queue-track="first"]').attributes('data-queue-dragging')).toBe('true')

    store.removeQueueIndex(0)
    await nextTick()
    expect(sourceHandle.isConnected).toBe(false)
    dispatchPointer(document, 'lostpointercapture', 1)
    dispatchPointer(document, 'pointerup', 1)

    const nextHandle = wrapper.get('[data-queue-track="second"] [data-queue-drag-handle]').element
    dispatchPointer(nextHandle, 'pointerdown', 2)
    await nextTick()
    expect(wrapper.get('[data-queue-track="second"]').attributes('data-queue-dragging')).toBe('true')
    wrapper.unmount()
  })

  it('cancels a drop when its candidate becomes Now Playing before pointerup', async () => {
    const store = createPlaybackStore()
    store.enqueue(track('first'))
    store.enqueue(track('second'))
    store.enqueue(track('third'))
    await store.playQueueIndex(0)
    const wrapper = mount(QueuePanel, { props: { store }, attachTo: document.body })
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    const candidate = wrapper.get('[data-queue-track="second"]').element
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => candidate) })

    const sourceHandle = wrapper.get('[data-queue-track="third"] [data-queue-drag-handle]').element
    dispatchPointer(sourceHandle, 'pointerdown', 3)
    dispatchPointer(sourceHandle, 'pointermove', 3)
    await store.playQueueIndex(1)
    await nextTick()
    expect(wrapper.get('[data-queue-now-playing]').text()).toContain('second')

    dispatchPointer(sourceHandle, 'pointerup', 3)
    await nextTick()
    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second', 'third'])
    expect(wrapper.findAll('[data-queue-up-next]').map((row) => row.attributes('data-queue-track'))).toEqual(['third'])
    wrapper.unmount()
  })

})
