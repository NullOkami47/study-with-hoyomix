import { afterEach, expect, it, vi } from 'vitest'
import { useAccountSession } from '../account/session'
import { getDefaultNoticeCentreStore } from './noticeCentre'

afterEach(() => { vi.unstubAllGlobals() })

it('invalidates targeted notices on logout and account switches even if refresh fails', async () => {
  const fetcher = vi.fn(async () => Response.json({ notices: [{
    id: 'private', revisionId: 'private-rev', severity: 'info',
    content: { en: 'Authenticated readers only' }, startAt: null, endAt: null,
  }] }))
  vi.stubGlobal('fetch', fetcher)
  const store = getDefaultNoticeCentreStore()
  await store.refresh()
  expect(store.allNotices()).toHaveLength(1)
  fetcher.mockRejectedValue(new Error('offline'))
  useAccountSession().publish(false)
  expect(store.allNotices()).toEqual([])
  await store.refresh()
  expect(store.allNotices()).toEqual([])

  fetcher.mockResolvedValue(Response.json({ notices: [{
    id: 'second', revisionId: 'second-rev', severity: 'info',
    content: { en: 'Second account' }, startAt: null, endAt: null,
  }] }))
  await store.refresh()
  fetcher.mockRejectedValue(new Error('offline'))
  useAccountSession().publish(true)
  expect(store.allNotices()).toEqual([])
})
