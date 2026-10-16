import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import NoticeCentre from './NoticeCentre.vue'
import { createNoticeCentreStore, type NoticeCentreStore } from './noticeCentre'

const memoryStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

const jsonResponse = (notices: unknown[]): Response =>
  new Response(JSON.stringify({ notices }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 'notice-1',
  revisionId: 'rev-1',
  severity: 'info',
  targeting: 'everyone',
  content: { en: 'Scheduled maintenance tonight.' },
  startAt: null,
  endAt: null,
  publishedAt: 1_000,
  ...overrides,
})

const storeWith = (...notices: unknown[]): NoticeCentreStore =>
  createNoticeCentreStore({
    fetch: vi.fn(async () => jsonResponse(notices)) as unknown as typeof fetch,
    storage: memoryStorage(),
  })

const mountCentre = async (store: NoticeCentreStore) => {
  const wrapper = mount(NoticeCentre, { props: { store } })
  await flushPromises()
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('NoticeCentre', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('renders nothing when there are no active notices', async () => {
    const wrapper = await mountCentre(storeWith())

    expect(wrapper.find('[data-notice-centre]').exists()).toBe(false)
  })

  it('refreshes on mount and renders the active notice text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([notice()])) as unknown as typeof fetch
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    const wrapper = await mountCentre(store)

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-notice-centre]').isVisible()).toBe(true)
    expect(wrapper.get('[data-notice="notice-1"]').text())
      .toContain('Scheduled maintenance tonight.')
  })

  it('labels the region and announces notices politely', async () => {
    const wrapper = await mountCentre(storeWith(notice()))
    const region = wrapper.get('[data-notice-centre]')

    expect(region.attributes('role')).toBe('region')
    expect(region.attributes('aria-label')).toBe('Announcements')
    expect(region.attributes('aria-live')).toBe('polite')
  })

  it('marks a critical notice as an assertive alert', async () => {
    const wrapper = await mountCentre(storeWith(notice({ severity: 'critical' })))
    const entry = wrapper.get('[data-notice="notice-1"]')

    expect(entry.attributes('role')).toBe('alert')
    expect(entry.attributes('data-notice-severity')).toBe('critical')
  })

  it.each([
    ['info', 'status'],
    ['warning', 'status'],
  ] as const)('renders a %s notice as a status region', async (severity, role) => {
    const wrapper = await mountCentre(storeWith(notice({ severity })))

    expect(wrapper.get('[data-notice="notice-1"]').attributes('role')).toBe(role)
    expect(wrapper.get('[data-notice="notice-1"]').attributes('data-notice-severity'))
      .toBe(severity)
  })

  it('names the severity for assistive technology', async () => {
    const wrapper = await mountCentre(storeWith(notice({ severity: 'warning' })))

    expect(wrapper.get('[data-notice-severity-label]').text()).toBe('Warning')
  })

  it('orders critical notices first', async () => {
    const wrapper = await mountCentre(storeWith(
      notice({ id: 'a', revisionId: 'ra', severity: 'info' }),
      notice({ id: 'b', revisionId: 'rb', severity: 'critical' }),
    ))

    const ids = wrapper.findAll('[data-notice]').map((entry) => entry.attributes('data-notice'))
    expect(ids).toEqual(['b', 'a'])
  })

  it('dismisses a notice on click and keeps it hidden', async () => {
    const store = storeWith(notice())
    const wrapper = await mountCentre(store)

    await wrapper.get('[data-notice-dismiss="rev-1"]').trigger('click')

    expect(wrapper.find('[data-notice="notice-1"]').exists()).toBe(false)
    expect(store.visibleNotices()).toEqual([])
  })

  it('dismisses the focused notice when Escape is pressed', async () => {
    const store = storeWith(notice())
    const wrapper = await mountCentre(store)

    await wrapper.get('[data-notice="notice-1"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('[data-notice="notice-1"]').exists()).toBe(false)
  })

  it('leaves the notice in place for other keys', async () => {
    const wrapper = await mountCentre(storeWith(notice()))

    await wrapper.get('[data-notice="notice-1"]').trigger('keydown', { key: 'a' })

    expect(wrapper.find('[data-notice="notice-1"]').exists()).toBe(true)
  })

  it('gives the dismiss control a keyboard-reachable accessible name', async () => {
    const wrapper = await mountCentre(storeWith(notice()))
    const button = wrapper.get('[data-notice-dismiss="rev-1"]')

    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Dismiss this announcement')
    expect(button.attributes('tabindex')).toBeUndefined()
  })

  it('keeps each notice focusable so Escape has a target', async () => {
    const wrapper = await mountCentre(storeWith(notice()))

    expect(wrapper.get('[data-notice="notice-1"]').attributes('tabindex')).toBe('-1')
  })

  it('moves focus to the next notice after a dismissal', async () => {
    const wrapper = await mountCentre(storeWith(
      notice({ id: 'a', revisionId: 'ra', severity: 'critical' }),
      notice({ id: 'b', revisionId: 'rb', severity: 'warning' }),
    ))
    document.body.appendChild(wrapper.element as HTMLElement)

    await wrapper.get('[data-notice-dismiss="ra"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.get('[data-notice="b"]').element)
  })

  it('does not trap focus when the last notice is dismissed', async () => {
    const wrapper = await mountCentre(storeWith(notice()))
    document.body.appendChild(wrapper.element as HTMLElement)

    await wrapper.get('[data-notice-dismiss="rev-1"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-notice-centre]').exists()).toBe(false)
  })

  it('falls back to another locale when the active locale has no text', async () => {
    usePreferences().setLocale('zh-Hant')
    const wrapper = await mountCentre(storeWith(notice({ content: { en: 'English only.' } })))

    expect(wrapper.get('[data-notice="notice-1"]').text()).toContain('English only.')
  })

  it('prefers the active locale text', async () => {
    usePreferences().setLocale('zh-Hans')
    const wrapper = await mountCentre(storeWith(notice({
      content: { en: 'English.', 'zh-Hans': '简体公告。' },
    })))

    const text = wrapper.get('[data-notice="notice-1"]').text()
    expect(text).toContain('简体公告。')
    expect(text).not.toContain('English.')
  })

  it('reacts to the locale changing after mount', async () => {
    const wrapper = await mountCentre(storeWith(notice({
      content: { en: 'English.', 'zh-Hant': '繁體公告。' },
    })))
    expect(wrapper.get('[data-notice="notice-1"]').text()).toContain('English.')

    usePreferences().setLocale('zh-Hant')
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-notice="notice-1"]').text()).toContain('繁體公告。')
  })

  it('never renders administrative fields', async () => {
    const wrapper = await mountCentre(storeWith(notice({
      status: 'published',
      createdBy: 'admin-1',
      targeting: 'authenticated',
    })))

    const html = wrapper.html()
    expect(html).not.toContain('admin-1')
    expect(html).not.toContain('published')
    expect(html).not.toContain('authenticated')
  })

  it('shows a newly published revision after a later refresh', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([notice()]))
      .mockResolvedValueOnce(jsonResponse([notice({ revisionId: 'rev-2', content: { en: 'Updated.' } })]))
    const store = createNoticeCentreStore({
      fetch: fetchImpl as unknown as typeof fetch,
      storage: memoryStorage(),
    })
    const wrapper = await mountCentre(store)
    await wrapper.get('[data-notice-dismiss="rev-1"]').trigger('click')
    expect(wrapper.find('[data-notice="notice-1"]').exists()).toBe(false)

    await store.refresh()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[data-notice="notice-1"]').text()).toContain('Updated.')
  })

  it('removes an archived notice on the next refresh', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([notice()]))
      .mockResolvedValueOnce(jsonResponse([]))
    const store = createNoticeCentreStore({
      fetch: fetchImpl as unknown as typeof fetch,
      storage: memoryStorage(),
    })
    const wrapper = await mountCentre(store)
    expect(wrapper.find('[data-notice="notice-1"]').exists()).toBe(true)

    await store.refresh()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-notice-centre]').exists()).toBe(false)
  })

  it('stays silent when the endpoint fails', async () => {
    const store = createNoticeCentreStore({
      fetch: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch,
      storage: memoryStorage(),
    })

    const wrapper = await mountCentre(store)

    expect(wrapper.find('[data-notice-centre]').exists()).toBe(false)
  })

  it('stops listening to the store after unmount', async () => {
    const store = storeWith(notice())
    const unsubscribe = vi.fn()
    const subscribe = vi.spyOn(store, 'subscribe').mockReturnValue(unsubscribe)
    const wrapper = await mountCentre(store)
    expect(subscribe).toHaveBeenCalledOnce()

    wrapper.unmount()

    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
