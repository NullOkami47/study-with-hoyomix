import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFocusSessionRepository } from '../focus/localRepository'
import { createLocalLibraryRepository } from '../library/localRepository'
import type { RemoteLibraryRepository } from '../library/remoteRepository'
import AccountMenu from './AccountMenu.vue'
import IdentityLinks from './IdentityLinks.vue'
import DataControls from './DataControls.vue'
import { resetAccountSession, useAccountSession } from './session'
import { usePreferences } from '../../stores/preferences'

const cleanups: Array<() => void> = []

// This component publishes to the shared session, which outlives it. Cleared between tests
// so each one starts from "nobody has asked yet" rather than the previous test's answer.
beforeEach(resetAccountSession)

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountAccountMenu(options: Parameters<typeof mount>[1] = {}) {
  const wrapper = mount(AccountMenu, options)
  cleanups.push(() => wrapper.unmount())
  return wrapper
}

describe('AccountMenu', () => {
  it('does not erase the verified workspace identity when opening Account during a network failure', async () => {
    const session = useAccountSession()
    session.publish(true, 'account-a')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const wrapper = mountAccountMenu()
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('unavailable')
    expect(session.userId.value).toBe('account-a')
    expect(session.signedIn.value).toBe(true)
  })
  it('does not republish an old account response after an intervening logout', async () => {
    const session = useAccountSession()
    session.publish(true, 'account-a')
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async path => path === '/api/auth/providers'
      ? Response.json({ providers: {} }) : new Promise<Response>(resolve => { finish = resolve })))
    mountAccountMenu(); await flushPromises()
    session.publish(false)
    finish(Response.json({ user: { id: 'account-a', role: 'user' }, identities: [] }))
    await flushPromises()
    expect(session.userId.value).toBeNull()
    expect(session.signedIn.value).toBe(false)
  })
  it('hides login actions when provider availability cannot be verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const wrapper = mountAccountMenu()
    await flushPromises()

    expect(wrapper.find('a[href="/api/auth/google/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/github/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('unavailable')
    expect(wrapper.emitted('signed-in')).toEqual([[false]])
  })

  it('offers only GitHub when Google and LINUX DO are unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/auth/providers'
      ? Response.json({ providers: { github: true, google: false, linuxdo: false } })
      : new Response(null, { status: 401 })))
    const wrapper = mountAccountMenu()
    expect(wrapper.find('a[href="/api/auth/google/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('a[href="/api/auth/google/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/github/start"]').exists()).toBe(true)
  })

  it('offers LINUX DO sign-in when advertised', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/auth/providers'
      ? Response.json({ providers: { github: false, google: false, linuxdo: true } })
      : new Response(null, { status: 401 })))
    const wrapper = mountAccountMenu()
    await flushPromises()
    expect(wrapper.find('a[href="/api/auth/github/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/google/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(true)
  })

  it('hides unavailable linking but retains existing Google and LINUX DO identity controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/auth/providers'
      ? Response.json({ providers: { github: true, google: false, linuxdo: false } })
      : Response.json({ user: { id: '1', displayName: 'Reader', role: 'user' }, identities: ['github'] })))
    const wrapper = mountAccountMenu({ props: { embedded: true } })
    await flushPromises()
    expect(wrapper.find('a[href="/api/auth/google/start?intent=link"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start?intent=link"]').exists()).toBe(false)
    const links = mount(IdentityLinks, { props: { identities: ['github', 'google', 'linuxdo'], availableProviders: ['github'] } })
    cleanups.push(() => links.unmount())
    expect(links.findAll('button')).toHaveLength(3)
  })

  it('renders link URL with intent=link and calls unlink with POST', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const links = mount(IdentityLinks, {
      props: { identities: ['github', 'linuxdo'], availableProviders: ['github', 'google', 'linuxdo'] },
    })
    cleanups.push(() => links.unmount())

    // google is unlinked -> has link anchor with intent=link
    const googleLink = links.find('a[href="/api/auth/google/start?intent=link"]')
    expect(googleLink.exists()).toBe(true)

    // linuxdo is linked -> has unlink button that sends POST /api/auth/linuxdo/unlink
    const buttons = links.findAll('button')
    expect(buttons).toHaveLength(2)
    await buttons[1]!.trigger('click')
    await flushPromises()
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/linuxdo/unlink', { method: 'POST' })
  })

  it('disables unlink button when only one identity remains', () => {
    const links = mount(IdentityLinks, {
      props: { identities: ['linuxdo'], availableProviders: ['linuxdo'] },
    })
    cleanups.push(() => links.unmount())
    const button = links.find('button')
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('renders authenticated controls inline when embedded in Settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
      identities: ['google'],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const wrapper = mountAccountMenu({
      props: { embedded: true },
      global: {
        stubs: {
          IdentityLinks: { props: ['identities'], template: '<div data-identity-links />' },
          DataControls: { template: '<div data-account-data />' },
        },
      },
    })
    await flushPromises()

    expect(wrapper.find('details').exists()).toBe(false)
    expect(wrapper.get('[data-account-data]').element).toBeTruthy()
    expect(wrapper.text()).toContain('Reader')
    expect(wrapper.emitted('signed-in')).toEqual([[true]])
  })

  it('emits signed out for an authenticated-session 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    const wrapper = mountAccountMenu()

    await flushPromises()

    expect(wrapper.emitted('signed-in')).toEqual([[false]])
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it.each([
    ['/api/logout', 0],
    ['/api/logout-all', 1],
  ] as const)('emits signed out after successful %s', async (path, buttonIndex) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
        identities: ['google'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ providers: { github: true, google: false } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchImpl)
    const wrapper = mountAccountMenu()
    await flushPromises()

    await wrapper.findAll('.account-menu__actions button')[buttonIndex]!.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('signed-in')).toEqual([[true], [false]])
    expect(fetchImpl).toHaveBeenCalledWith(path, { method: 'POST' })
    expect(wrapper.find('.account-menu__signed-out').exists()).toBe(true)
  })

  it('fails Focus sync availability closed when logout cannot reach the backend', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
        identities: ['google'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchImpl)
    const wrapper = mountAccountMenu()
    await flushPromises()

    await wrapper.findAll('.account-menu__actions button')[0]!.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('signed-in')).toEqual([[true], [false]])
    expect(wrapper.get('[role="status"]').text()).toContain('unavailable')
  })

  it('emits signed out immediately when account deletion succeeds, before refresh settles', async () => {
    let settleRefresh: ((response: Response) => void) | undefined
    const refreshAfterDeletion = new Promise<Response>((resolve) => { settleRefresh = resolve })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
        identities: ['google'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ providers: { github: true, google: false } }))
      .mockImplementationOnce(() => refreshAfterDeletion)
    vi.stubGlobal('fetch', fetchImpl)
    const wrapper = mountAccountMenu({
      global: {
        stubs: {
          IdentityLinks: { template: '<div />' },
          DataControls: { template: '<button data-delete-success @click="$emit(\'deleted\')">delete</button>' },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-delete-success]').trigger('click')

    expect(wrapper.emitted('signed-in')).toEqual([[true], [false]])
    expect(wrapper.find('.account-menu__signed-out').exists()).toBe(true)
    settleRefresh?.(new Response(null, { status: 401 }))
    await flushPromises()
  })

  it('clears listening history without touching Focus history', async () => {
    const localRepository = createLocalLibraryRepository({ indexedDB: undefined })
    const focusRepository = createFocusSessionRepository({ indexedDB: undefined })
    const focusClear = vi.spyOn(focusRepository, 'clear')
    const repository = remoteRepository()
    const wrapper = mount(DataControls, {
      props: { localRepository, focusRepository, repository },
    })
    cleanups.push(() => {
      wrapper.unmount()
      localRepository.destroy()
    })

    await wrapper.get('[data-testid="clear-synced-history"]').trigger('click')
    await flushPromises()

    expect(repository.clearHistory).toHaveBeenCalledOnce()
    expect(focusClear).not.toHaveBeenCalled()
  })

  it('keeps remote account deletion authoritative when local Focus cleanup fails', async () => {
    const localRepository = createLocalLibraryRepository({ indexedDB: undefined })
    const repository = remoteRepository()
    const focusRepository = createFocusSessionRepository({ indexedDB: undefined })
    vi.spyOn(focusRepository, 'clear').mockRejectedValue(new Error('local_focus_cleanup_failed'))
    const wrapper = mount(DataControls, {
      props: { localRepository, focusRepository, repository },
    })
    cleanups.push(() => {
      wrapper.unmount()
      localRepository.destroy()
    })

    await wrapper.get('[data-testid="delete-confirmation"]').setValue('DELETE')
    await wrapper.get('[data-testid="delete-account"]').trigger('click')
    await flushPromises()

    expect(repository.deleteAccount).toHaveBeenCalledOnce()
    expect(wrapper.emitted('deleted')).toHaveLength(1)
    expect(wrapper.get('[role="status"]').text()).toMatch(/account was deleted.*local Focus history could not be removed/iu)
  })

  it('adapts social auth buttons to Cinematic (電影模式) visual style', async () => {
    const preferences = usePreferences()
    preferences.setVisualStyle('cinematic')
    vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/auth/providers'
      ? Response.json({ providers: { github: true, google: true, linuxdo: true } })
      : new Response(null, { status: 401 })))

    const wrapper = mountAccountMenu({ props: { embedded: true } })
    await flushPromises()

    const signedOutContainer = wrapper.find('.account-menu__signed-out')
    expect(signedOutContainer.exists()).toBe(true)
    expect(signedOutContainer.classes()).toContain('account-menu__signed-out--embedded')
    expect(signedOutContainer.attributes('data-visual-style')).toBe('cinematic')

    const googleBtn = wrapper.find('a[href="/api/auth/google/start"]')
    expect(googleBtn.exists()).toBe(true)
    expect(googleBtn.classes()).toContain('auth-button')
    expect(googleBtn.classes()).toContain('auth-button--google')
    expect(googleBtn.classes()).toContain('auth-button--cinematic')
    expect(googleBtn.attributes('data-visual-style')).toBe('cinematic')
    expect(googleBtn.find('.auth-button__icon svg').exists()).toBe(true)
    expect(googleBtn.find('.auth-button__text').text()).toContain('Google')
    expect(googleBtn.find('.auth-button__spacer').exists()).toBe(true)

    const githubBtn = wrapper.find('a[href="/api/auth/github/start"]')
    expect(githubBtn.classes()).toContain('auth-button--github')
    expect(githubBtn.classes()).toContain('auth-button--cinematic')

    const linuxdoBtn = wrapper.find('a[href="/api/auth/linuxdo/start"]')
    expect(linuxdoBtn.classes()).toContain('auth-button--linuxdo')
    expect(linuxdoBtn.classes()).toContain('auth-button--cinematic')

    // Dynamically change visual style to studio
    preferences.setVisualStyle('studio')
    await flushPromises()
    expect(signedOutContainer.attributes('data-visual-style')).toBe('studio')
    expect(googleBtn.classes()).toContain('auth-button--studio')
    expect(googleBtn.attributes('data-visual-style')).toBe('studio')
  })

  it('adapts social auth buttons to Liquid Glass (studio) visual style', async () => {
    const preferences = usePreferences()
    preferences.setVisualStyle('studio')
    vi.stubGlobal('fetch', vi.fn(async (path) => path === '/api/auth/providers'
      ? Response.json({ providers: { github: true, google: true, linuxdo: true } })
      : new Response(null, { status: 401 })))

    const wrapper = mountAccountMenu({ props: { embedded: true } })
    await flushPromises()

    const signedOutContainer = wrapper.find('.account-menu__signed-out')
    expect(signedOutContainer.attributes('data-visual-style')).toBe('studio')

    const googleBtn = wrapper.find('a[href="/api/auth/google/start"]')
    expect(googleBtn.exists()).toBe(true)
    expect(googleBtn.classes()).toContain('auth-button')
    expect(googleBtn.classes()).toContain('auth-button--google')
    expect(googleBtn.classes()).toContain('auth-button--studio')
    expect(googleBtn.attributes('data-visual-style')).toBe('studio')

    const githubBtn = wrapper.find('a[href="/api/auth/github/start"]')
    expect(githubBtn.classes()).toContain('auth-button--studio')

    const linuxdoBtn = wrapper.find('a[href="/api/auth/linuxdo/start"]')
    expect(linuxdoBtn.classes()).toContain('auth-button--studio')
  })

  it('renders styled auth buttons in IdentityLinks for unlinked providers in both styles', async () => {
    const preferences = usePreferences()
    preferences.setVisualStyle('studio')
    const links = mount(IdentityLinks, {
      props: { identities: ['github'], availableProviders: ['github', 'google', 'linuxdo'] },
    })
    cleanups.push(() => links.unmount())

    const googleLink = links.find('a[href="/api/auth/google/start?intent=link"]')
    expect(googleLink.exists()).toBe(true)
    expect(googleLink.classes()).toContain('auth-button')
    expect(googleLink.classes()).toContain('auth-button--google')
    expect(googleLink.classes()).toContain('auth-button--studio')
    expect(googleLink.attributes('data-visual-style')).toBe('studio')
    expect(googleLink.find('.auth-button__icon svg').exists()).toBe(true)

    // Linked provider has status indicator with icon
    const linkedStatus = links.find('.identity-links__status')
    expect(linkedStatus.exists()).toBe(true)
    expect(linkedStatus.find('.identity-links__icon svg').exists()).toBe(true)
  })
})

function remoteRepository(): RemoteLibraryRepository & {
  clearHistory: ReturnType<typeof vi.fn>
  deleteAccount: ReturnType<typeof vi.fn>
} {
  return {
    load: vi.fn(),
    previewMerge: vi.fn(),
    confirmMerge: vi.fn(),
    recordHistory: vi.fn(),
    clearHistory: vi.fn(async () => undefined),
    exportAccountData: vi.fn(),
    deleteAccount: vi.fn(async () => undefined),
  }
}
