// M-09 (design Property 11, SPA half): the query → toast → cleanup path for OAuth navigations.
import { mount } from '@vue/test-utils'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import AuthNoticeToast from './AuthNoticeToast.vue'
import { authNoticeFromSearch, consumeAuthNotice, withoutAuthNoticeParameters } from './authNotice'

const KNOWN = {
  collision: 'account.notice.collision',
  provider_already_linked: 'account.notice.providerAlreadyLinked',
  unauthorized: 'account.notice.unauthorized',
  oauth_callback_failed: 'account.notice.callbackFailed',
} as const

const fakeHistory = () => ({ state: { keep: true } as unknown, replaceState: vi.fn() })

afterEach(() => {
  window.history.replaceState(null, '', '/')
  vi.useRealTimers()
})

describe('authNoticeFromSearch', () => {
  it('maps account=linked to the success message', () => {
    expect(authNoticeFromSearch('?account=linked')).toEqual({ kind: 'success', key: 'account.notice.linked' })
  })

  it.each(Object.entries(KNOWN))('maps auth_error=%s to its own message', (code, key) => {
    expect(authNoticeFromSearch(`?auth_error=${code}`)).toEqual({ kind: 'error', key })
  })

  it.each(['', 'bogus', '<script>alert(1)</script>', '__proto__', 'constructor', 'COLLISION'])(
    'maps the unknown code %j to the generic message',
    (code) => {
      expect(authNoticeFromSearch(`?auth_error=${encodeURIComponent(code)}`)).toEqual({ kind: 'error', key: 'account.notice.generic' })
    },
  )

  it('ignores URLs without a status parameter and unknown account values', () => {
    expect(authNoticeFromSearch('')).toBeNull()
    expect(authNoticeFromSearch('?tab=library')).toBeNull()
    expect(authNoticeFromSearch('?account=deleted')).toBeNull()
  })

  it('never yields a message key outside the account.notice namespace, whatever the query', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (account, error) => {
      for (const search of [`?account=${encodeURIComponent(account)}`, `?auth_error=${encodeURIComponent(error)}`]) {
        const notice = authNoticeFromSearch(search)
        if (notice) expect(notice.key.startsWith('account.notice.')).toBe(true)
      }
    }))
  })
})

describe('withoutAuthNoticeParameters', () => {
  it('removes only the status parameters and keeps the path, other parameters and the hash', () => {
    expect(withoutAuthNoticeParameters('https://study.example/?a=1&auth_error=collision&b=2#panel'))
      .toBe('/?a=1&b=2#panel')
    expect(withoutAuthNoticeParameters('https://study.example/library?account=linked#x')).toBe('/library#x')
  })

  it('returns null when there is nothing to remove', () => {
    expect(withoutAuthNoticeParameters('https://study.example/?a=1#h')).toBeNull()
  })

  it('preserves every non-status parameter in order (property)', () => {
    const name = fc.stringMatching(/^[a-z]{1,6}$/).filter((value) => value !== 'account' && value !== 'auth_error')
    fc.assert(fc.property(fc.array(fc.tuple(name, fc.string()), { maxLength: 5 }), fc.string(), (pairs, code) => {
      const kept = new URLSearchParams(pairs)
      const url = new URL('https://study.example/')
      url.search = kept.toString()
      url.searchParams.append('auth_error', code)
      const cleaned = new URL(withoutAuthNoticeParameters(url.toString())!, 'https://study.example')
      expect([...cleaned.searchParams.entries()]).toEqual([...kept.entries()])
    }))
  })
})

describe('consumeAuthNotice', () => {
  it('returns the notice and replaces the history entry, keeping its state', () => {
    const history = fakeHistory()
    const notice = consumeAuthNotice({ href: 'https://study.example/?account=linked&x=1#h', search: '?account=linked&x=1' }, history)
    expect(notice).toEqual({ kind: 'success', key: 'account.notice.linked' })
    expect(history.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/?x=1#h')
  })

  it('does not touch history when the URL has no status parameter', () => {
    const history = fakeHistory()
    expect(consumeAuthNotice({ href: 'https://study.example/?x=1', search: '?x=1' }, history)).toBeNull()
    expect(history.replaceState).not.toHaveBeenCalled()
  })

  it('still strips an unknown account value without showing anything', () => {
    const history = fakeHistory()
    expect(consumeAuthNotice({ href: 'https://study.example/?account=other', search: '?account=other' }, history)).toBeNull()
    expect(history.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/')
  })
})

describe('AuthNoticeToast', () => {
  it('shows the localised message from the URL, cleans the URL, and dismisses', async () => {
    window.history.replaceState(null, '', '/?auth_error=collision&tab=focus#chat')
    const wrapper = mount(AuthNoticeToast)
    await wrapper.vm.$nextTick()
    const toast = wrapper.get('[data-auth-notice]')
    expect(toast.attributes('role')).toBe('alert')
    expect(toast.text()).toContain(translate(usePreferences().locale.value, 'account.notice.collision'))
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/?tab=focus#chat')
    await wrapper.get('button').trigger('click')
    expect(wrapper.find('[data-auth-notice]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('never renders the raw code of an unknown error', async () => {
    window.history.replaceState(null, '', '/?auth_error=%3Cb%3Eprovider-detail%3C%2Fb%3E')
    const wrapper = mount(AuthNoticeToast)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-auth-notice]').text()).toContain(translate(usePreferences().locale.value, 'account.notice.generic'))
    expect(wrapper.html()).not.toContain('provider-detail')
    expect(window.location.search).toBe('')
    wrapper.unmount()
  })

  it('announces a successful link politely and hides itself after a while', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', '/?account=linked')
    const wrapper = mount(AuthNoticeToast)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-auth-notice]').attributes('role')).toBe('status')
    vi.advanceTimersByTime(8_000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-auth-notice]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders nothing without a status parameter', () => {
    const wrapper = mount(AuthNoticeToast)
    expect(wrapper.find('[data-auth-notice]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('message catalogue', () => {
  it.each(['en', 'zh-Hans', 'zh-Hant'] as const)('has distinct %s text for every notice', (locale) => {
    const keys = ['account.notice.linked', ...Object.values(KNOWN), 'account.notice.generic', 'account.notice.dismiss'] as const
    for (const key of keys) expect(translate(locale, key)).not.toBe(key)
  })
})
