import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import QueueDrawer from './QueueDrawer.vue'
import { clampQueueSize, QUEUE_SIZE_KEY, readQueueSize } from './queueGeometry'
import type { PlaybackStore } from './store'

const current: Track = {
  id: 'current',
  title: 'Current',
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: [],
  workGroupId: 'work',
  needsClassification: true,
  vocalStatus: 'uncertain',
  sources: [],
}

const store = {
  currentIndex: { value: 0 },
  queue: { value: [current] },
  next: vi.fn(),
  previous: vi.fn(),
  playQueueIndex: vi.fn(),
  removeQueueIndex: vi.fn(() => false),
  moveQueueItem: vi.fn(() => false),
  playNext: vi.fn(),
  clearUpcomingQueue: vi.fn(),
} as unknown as Pick<PlaybackStore,
  'currentIndex' | 'next' | 'playQueueIndex' | 'previous' | 'queue' | 'removeQueueIndex' | 'moveQueueItem' | 'playNext' | 'clearUpcomingQueue'
>

describe('QueueDrawer', () => {
  it('clamps persisted desktop dimensions and keeps the mobile sheet independent', () => {
    const storage = { getItem: () => JSON.stringify({ width: 900, height: 800 }) }
    expect(readQueueSize(storage, 600, 500)).toEqual({ width: 568, height: 468 })
    expect(clampQueueSize({ width: 100, height: 100 }, 1200, 900)).toEqual({ width: 320, height: 420 })
    expect(QUEUE_SIZE_KEY).toContain('queue-size')
    const wrapper = mount(QueueDrawer, { props: { store } })
    expect(wrapper.find('[data-queue-resize]').exists()).toBe(true)
    expect(wrapper.get('[data-queue-drawer]').attributes('style')).toContain('--queue-width')
    wrapper.unmount()
  })
  it('is a labelled non-modal drawer and emits close explicitly or on Escape', async () => {
    const wrapper = mount(QueueDrawer, { props: { store } })
    const dialog = wrapper.get('[data-queue-drawer]')

    expect(dialog.attributes('id')).toBe('workspace-queue-drawer')
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('false')
    expect(dialog.attributes('aria-labelledby')).toBe('queue-drawer-title')
    expect(dialog.get('h2').attributes('id')).toBe('queue-drawer-title')

    await dialog.get('[data-queue-close]').trigger('click')
    await dialog.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('focuses the non-modal surface on open and returns focus to its connected opener on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const wrapper = mount(QueueDrawer, { props: { store }, attachTo: document.body })
    expect(document.activeElement).toBe(wrapper.get('[data-queue-drawer]').element)
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('does not steal focus when another surface took focus before the drawer is closed', () => {
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    const wrapper = mount(QueueDrawer, { props: { store }, attachTo: document.body })
    elsewhere.focus()
    wrapper.unmount()
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('exposes responsive surface hooks without owning media suspension', () => {
    const wrapper = mount(QueueDrawer, { props: { store } })
    expect(wrapper.get('[data-queue-drawer]').classes()).toContain('queue-drawer')
    expect(wrapper.find('[data-media-suspended]').exists()).toBe(false)
    expect(wrapper.find('[data-modal-open]').exists()).toBe(false)
  })
})
