import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreferences } from '../../stores/preferences'
import NoticeHistory from './NoticeHistory.vue'
import { createNoticeCentreStore } from './noticeCentre'

const response = (entries: unknown[]) => Response.json({ notices: entries })
const entry = (id: string, revisionId: string, content: string) => ({
  id, revisionId, severity: 'info', content: { en: content },
  startAt: null, endAt: null,
})

describe('NoticeHistory in Settings', () => {
  afterEach(() => { vi.useRealTimers() })

  it('shows no cached announcement while fresh eligibility is pending and preserves dismissals after success', async () => {
    const notice = entry('restricted', 'restricted-r1', 'Previously authorised announcement')
    let resolveRefresh!: (value: Response) => void
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([notice]))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve }))
    const store = createNoticeCentreStore({
      fetch: fetcher,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    await store.refresh()
    store.dismiss(notice.revisionId)
    expect(store.allNotices()).toHaveLength(1)
    const wrapper = mount(NoticeHistory, { props: { store } })
    await flushPromises()
    expect(wrapper.find('[data-settings-notice="restricted"]').exists()).toBe(false)
    expect(store.visibleNotices()).toEqual([])
    resolveRefresh(response([notice]))
    await flushPromises()
    expect(wrapper.get('[data-settings-notice="restricted"]').text()).toContain('Previously authorised announcement')
    expect(store.visibleNotices()).toEqual([])
    wrapper.unmount()
  })

  it.each(['network', 'non-json', 'http-error'] as const)
    ('does not redisplay cached announcements when eligibility revalidation fails: %s', async failure => {
      const notice = entry('restricted', 'restricted-r1', 'Previously authorised announcement')
      const fetcher = vi.fn()
        .mockResolvedValueOnce(response([notice]))
        .mockImplementationOnce(async () => {
          if (failure === 'network') throw new Error('offline')
          return failure === 'non-json'
            ? new Response('<html>upstream error</html>', { headers: { 'content-type': 'text/html' } })
            : new Response('unavailable', { status: 503 })
        })
      const store = createNoticeCentreStore({
        fetch: fetcher,
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      })
      await store.refresh()
      store.dismiss(notice.revisionId)
      const wrapper = mount(NoticeHistory, { props: { store } })
      await flushPromises()
      expect(wrapper.find('[data-settings-notice="restricted"]').exists()).toBe(false)
      expect(store.allNotices()).toEqual([])
      expect(store.visibleNotices()).toEqual([])
      wrapper.unmount()
    })

  it('removes an expired announcement from the mounted settings view', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createNoticeCentreStore({
      fetch: vi.fn(async () => response([{ ...entry('a', 'ra', 'Short notice'), endAt: 2_000 }])),
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    const wrapper = mount(NoticeHistory, { props: { store } })
    await flushPromises()
    expect(wrapper.find('[data-settings-notice="a"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.find('[data-settings-notice="a"]').exists()).toBe(false)
    expect(wrapper.find('[data-settings-notices-empty]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('clears the mounted history when its session eligibility is invalidated', async () => {
    const store = createNoticeCentreStore({
      fetch: vi.fn(async () => response([entry('private', 'private-rev', 'Private notice')])),
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    const wrapper = mount(NoticeHistory, { props: { store } })
    await flushPromises()
    expect(wrapper.find('[data-settings-notice="private"]').exists()).toBe(true)
    store.invalidateSession()
    await flushPromises()
    expect(wrapper.find('[data-settings-notice="private"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('reopens active notices even after their banner was dismissed', async () => {
    usePreferences().setLocale('en')
    const store = createNoticeCentreStore({
      fetch: vi.fn(async () => response([entry('a', 'ra', 'Maintenance tonight')])) as typeof fetch,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    await store.refresh()
    store.dismiss('ra')
    expect(store.visibleNotices()).toEqual([])
    const wrapper = mount(NoticeHistory, { props: { store } })
    await flushPromises()
    expect(wrapper.get('[data-settings-notice="a"]').text()).toContain('Maintenance tonight')
    wrapper.unmount()
  })

  it('shows an empty state when the published notice feed is empty', async () => {
    usePreferences().setLocale('en')
    const store = createNoticeCentreStore({
      fetch: vi.fn(async () => response([])) as typeof fetch,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    const wrapper = mount(NoticeHistory, { props: { store } })
    await flushPromises()
    expect(wrapper.get('[data-settings-notices-empty]').text()).toContain('no current announcements')
    wrapper.unmount()
  })
})
