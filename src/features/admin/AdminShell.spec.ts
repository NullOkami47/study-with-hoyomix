import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AdminShell from './AdminShell.vue'
import { createAdminRepository, type AdminRepository, type AdminOverview, type AdminNotice, type AdminNoticeInput, type AdminProvider, type AdminRole, type AdminSessionResult } from './client'
import { usePreferences } from '../../stores/preferences'

const cleanups: Array<() => void> = []

/** The shell reads the section from the hash on mount, so a hash left behind by one
 * test would silently decide which section the next test opens on. */
const setHash = (hash: string): void => {
  window.history.replaceState(null, '', hash === '' ? window.location.pathname : hash)
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  setHash('')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mountAdmin = (repo: AdminRepository) => {
  const wrapper = mount(AdminShell, { props: { repository: repo } })
  cleanups.push(() => wrapper.unmount())
  return wrapper
}

/**
 * The console shows one section at a time, so a test that exercises Providers,
 * Notices or Audit has to go there first. Every such test therefore also proves the
 * section is reachable from the navigation, which is stronger than the previous
 * arrangement where all five were mounted at once and reachability was untested.
 */
const show = async (wrapper: ReturnType<typeof mountAdmin>, section: string): Promise<void> => {
  await wrapper.get(`[data-admin-nav-${section}]`).trigger('click')
  await flushPromises()
}

const noticeFixture: AdminNotice = {
  id: 'notice-1',
  revisionId: 'revision-1',
  status: 'draft',
  severity: 'warning',
  targeting: 'everyone',
  content: { 'zh-Hant': '系統維護中', en: 'Maintenance in progress' },
  startAt: null,
  endAt: null,
  createdAt: 1000,
  updatedAt: 2000,
  publishedAt: null,
  archivedAt: null,
}

const makeProvider = (overrides: Partial<AdminProvider>): AdminProvider => ({
  key: 'youtube',
  adminEnabled: true,
  deploymentAvailable: true,
  effectiveEnabled: true,
  automaticPolicy: 'direct',
  priority: 2,
  status: 'healthy',
  failureClass: null,
  latencyMs: 40,
  checkedAt: 1000,
  updatedAt: 2000,
  ...overrides,
})

const overview: AdminOverview = {
  providers: [
    makeProvider({ key: 'chksz', priority: 10, status: 'healthy', failureClass: null, latencyMs: 40, checkedAt: 1000, updatedAt: 2000 }),
    makeProvider({
      key: 'jellyfin', adminEnabled: false, deploymentAvailable: false, effectiveEnabled: false,
      priority: 30, status: 'unknown', failureClass: null, latencyMs: null, checkedAt: null, updatedAt: 3000,
    }),
  ],
  activeNoticeCount: 3,
}

describe('AdminShell', () => {
  it.each([
    [{ providers: { github: true, google: false } }, 200, true],
    [{ providers: { github: 'true', google: 'true' } }, 200, false],
    [{}, 503, false],
  ])('shows only verified login providers in the admin gate (%j)', async (body, status, githubVisible) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unauthorised' })
    const wrapper = mountAdmin(repo)
    await flushPromises()
    expect(wrapper.find('[data-admin-unauthorized]').exists()).toBe(true)
    expect(wrapper.find('a[href="/api/auth/google/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/api/auth/github/start"]').exists()).toBe(githubVisible)
  })

  it('shows LINUX DO in admin gate when advertised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ providers: { github: false, google: false, linuxdo: true } }, { status: 200 })))
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unauthorised' })
    const wrapper = mountAdmin(repo)
    await flushPromises()
    expect(wrapper.find('[data-admin-unauthorized]').exists()).toBe(true)
    expect(wrapper.find('a[href="/api/auth/linuxdo/start"]').exists()).toBe(true)
  })

  it('adapts unauthorized gate auth buttons to visualStyle (cinematic & studio)', async () => {
    const preferences = usePreferences()
    preferences.setLocale('en')
    preferences.setVisualStyle('studio')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ providers: { github: true, google: true, linuxdo: true } }, { status: 200 })))
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unauthorised' })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    const gate = wrapper.find('[data-admin-unauthorized]')
    expect(gate.exists()).toBe(true)
    expect(gate.attributes('data-visual-style')).toBe('studio')

    const googleBtn = wrapper.find('a[href="/api/auth/google/start"]')
    expect(googleBtn.exists()).toBe(true)
    expect(googleBtn.classes()).toContain('auth-button')
    expect(googleBtn.classes()).toContain('auth-button--google')
    expect(googleBtn.classes()).toContain('auth-button--studio')
    expect(googleBtn.attributes('data-visual-style')).toBe('studio')
    expect(googleBtn.find('.auth-button__icon svg').exists()).toBe(true)
    expect(googleBtn.find('.auth-button__text').text()).toBe('Sign in with Google')
    expect(googleBtn.find('.auth-button__spacer').exists()).toBe(true)

    preferences.setVisualStyle('cinematic')
    await flushPromises()
    expect(googleBtn.classes()).toContain('auth-button--cinematic')
    expect(googleBtn.attributes('data-visual-style')).toBe('cinematic')
  })

  it('lazy mounts the catalogue section only on first visit',async()=>{
    const repo=createAdminRepository()
    vi.spyOn(repo,'checkSession').mockResolvedValue({status:'authorised',role:'admin'})
    vi.spyOn(repo,'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo,'getCatalogueStatus').mockResolvedValue({configured:false,role:'admin',sheetUrl:null,serviceAccountEmail:null,lastBatch:null})
    const wrapper=mountAdmin(repo);await flushPromises();expect(repo.getCatalogueStatus).not.toHaveBeenCalled()
    await show(wrapper,'catalogue');expect(repo.getCatalogueStatus).toHaveBeenCalledOnce();expect(wrapper.get('[data-catalogue-manager]').isVisible()).toBe(true)
    await show(wrapper,'overview');await show(wrapper,'catalogue');expect(repo.getCatalogueStatus).toHaveBeenCalledOnce()
  })

  it('shows loading then a gate when the session is not admin', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unauthorised' })
    const wrapper = mountAdmin(repo)
    expect(wrapper.find('[role="status"]').text()).toContain('Loading')
    await flushPromises()
    expect(wrapper.find('[data-admin-unauthorized]').exists()).toBe(true)
    expect(wrapper.find('[data-admin-sidebar]').exists()).toBe(false)
    expect(wrapper.find('[data-provider-health-card]').exists()).toBe(false)
  })

  it('shows unavailable state when the admin API fails and offers retry', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockRejectedValue(new Error('admin_503'))
    const wrapper = mountAdmin(repo)
    await flushPromises()
    expect(wrapper.find('[data-admin-unavailable]').exists()).toBe(true)
    expect(wrapper.find('[data-admin-unavailable] button').text()).toContain('Retry')
  })

  it('shows unavailable rather than login when session lookup fails', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unavailable' })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-unavailable]').exists()).toBe(true)
    expect(wrapper.find('[data-admin-unauthorized]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Sign in with Google')
    expect(wrapper.find('[data-admin-unavailable] button').text()).toContain('Retry')
  })

  it('renders overview cards and provider table when the session is admin', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-sidebar]').exists()).toBe(true)
    expect(wrapper.find('[data-admin-card="notices"]').text()).toContain('3')
    expect(wrapper.find('[data-admin-card="role"]').text()).toContain('admin')

    await show(wrapper, 'providers')
    const healthItems = wrapper.findAll('[data-provider-health-card] [data-provider-key]')
    expect(healthItems).toHaveLength(2)
    const chksz = wrapper.find('[data-provider-health-card] [data-provider-key="chksz"]')
    expect(chksz.text()).toContain('ChKSz BYOK')
    expect(chksz.attributes('data-provider-status')).toBe('healthy')
    const toggle = wrapper.find('[data-provider-controls] [data-provider-toggle="chksz"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.find('[data-provider-controls] [data-provider-key="jellyfin"]').text())
      .toContain('Unavailable in this deployment')
  })

  it('renders overview cards when the session is owner', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'owner' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-card="role"]').text()).toContain('owner')
  })

  it('lets admin view the audit log without an export control', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo, 'listNotices').mockResolvedValue([])
    vi.spyOn(repo, 'listAudit').mockResolvedValue({
      entries: [], total: 0, limit: 25, offset: 0,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-nav-audit]').exists()).toBe(true)

    await show(wrapper, 'audit')
    expect(wrapper.find('#admin-audit [data-audit-log]').exists()).toBe(true)
    expect(wrapper.find('[data-audit-export]').exists()).toBe(false)
  })

  it('lets owner view the audit log and export JSON', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'owner' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo, 'listNotices').mockResolvedValue([])
    vi.spyOn(repo, 'listAudit').mockResolvedValue({
      entries: [], total: 0, limit: 25, offset: 0,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-nav-audit]').exists()).toBe(true)

    await show(wrapper, 'audit')
    expect(wrapper.find('#admin-audit [data-audit-log]').exists()).toBe(true)
    expect(wrapper.find('[data-audit-export]').exists()).toBe(true)
  })

  it('never renders operational data while loading', async () => {
    const repo = createAdminRepository()
    const checkSpy = vi.fn((): Promise<AdminSessionResult> => new Promise(() => {}))
    vi.spyOn(repo, 'checkSession').mockImplementation(checkSpy)
    const wrapper = mountAdmin(repo)
    await flushPromises()
    expect(wrapper.find('[data-admin-sidebar]').exists()).toBe(false)
    expect(wrapper.find('[data-provider-health-card]').exists()).toBe(false)
    expect(wrapper.find('[data-provider-controls]').exists()).toBe(false)
    expect(wrapper.find('[data-admin-card="notices"]').exists()).toBe(false)
  })

  it('colour-codes the health card so healthy reads green and degraded reads amber', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue({
      providers: [
        makeProvider({ key: 'chksz', status: 'healthy', latencyMs: 40 }),
        makeProvider({ key: 'lx', status: 'degraded', failureClass: 'timeout', latencyMs: 900 }),
        makeProvider({ key: 'jellyfin', status: 'unavailable', failureClass: 'dns', latencyMs: null }),
      ],
      activeNoticeCount: 0,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    const healthy = wrapper.find('[data-provider-health-card] [data-provider-key="chksz"] [data-provider-status-text]')
    expect(healthy.attributes('data-provider-status-text')).toBe('healthy')
    expect(healthy.classes()).toContain('provider-health__status')
    const healthyDot = wrapper.find('[data-provider-health-card] [data-provider-key="chksz"] .provider-health__dot')
    expect(healthyDot.classes()).toContain('provider-health__dot--healthy')

    const degraded = wrapper.find('[data-provider-health-card] [data-provider-key="lx"] [data-provider-status-text]')
    expect(degraded.attributes('data-provider-status-text')).toBe('degraded')
    const degradedDot = wrapper.find('[data-provider-health-card] [data-provider-key="lx"] .provider-health__dot')
    expect(degradedDot.classes()).toContain('provider-health__dot--degraded')
    expect(wrapper.find('[data-provider-health-card] [data-provider-key="lx"] [data-provider-failure]').attributes('data-provider-failure')).toBe('timeout')

    const unavailableDot = wrapper.find('[data-provider-health-card] [data-provider-key="jellyfin"] .provider-health__dot')
    expect(unavailableDot.classes()).toContain('provider-health__dot--unavailable')
  })

  it('refreshes persisted provider status without claiming a probe', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    const getOverview = vi.spyOn(repo, 'getOverview')
    getOverview.mockResolvedValueOnce(overview)
    const refreshed: AdminOverview = {
      providers: [makeProvider({ key: 'chksz', status: 'degraded', latencyMs: 900, failureClass: 'timeout', updatedAt: 9000 })],
      activeNoticeCount: 1,
    }
    getOverview.mockResolvedValueOnce(refreshed)
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    expect(wrapper.find('[data-provider-health-card] [data-provider-key="jellyfin"]').exists()).toBe(true)
    const action = wrapper.find('[data-provider-check-health]')
    expect(action.text()).not.toMatch(/health check/i)
    expect(action.text()).toContain('Refresh status')
    await action.trigger('click')
    await flushPromises()

    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('Health check failed.')
    expect(wrapper.find('[data-provider-health-card] [data-provider-key="jellyfin"]').exists()).toBe(false)
    expect(wrapper.find('[data-provider-health-card] [data-provider-key="chksz"]').attributes('data-provider-status')).toBe('degraded')
  })

  it('toggles a provider and writes the mutation through the repository', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue({
      ...overview,
      providers: overview.providers.map((provider) => provider.key === 'jellyfin'
        ? { ...provider, deploymentAvailable: true }
        : provider),
    })
    const updateProvider = vi.spyOn(repo, 'updateProvider').mockResolvedValue(
      makeProvider({ key: 'jellyfin', priority: 30, status: 'unknown' }),
    )
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    const toggle = wrapper.find('[data-provider-controls] [data-provider-toggle="jellyfin"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    await toggle.setValue(true)
    await flushPromises()

    expect(updateProvider).toHaveBeenCalledWith('jellyfin', { enabled: true })
    expect((wrapper.find('[data-provider-controls] [data-provider-toggle="jellyfin"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('restores authoritative provider state and shows a localised error after a failed save', async () => {
    const preferences = usePreferences()
    const previousLocale = preferences.locale.value
    preferences.setLocale('zh-Hant')
    cleanups.push(() => preferences.setLocale(previousLocale))

    const initialOverview: AdminOverview = {
      providers: [
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
      ],
      activeNoticeCount: 0,
    }
    const authoritativeOverview: AdminOverview = {
      providers: [
        makeProvider({ key: 'chksz', priority: 10, adminEnabled: false, effectiveEnabled: false }),
        makeProvider({ key: 'lx', priority: 25 }),
      ],
      activeNoticeCount: 0,
    }
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    const getOverview = vi.spyOn(repo, 'getOverview')
      .mockResolvedValueOnce(initialOverview)
      .mockResolvedValueOnce(authoritativeOverview)
    const updateProvider = vi.spyOn(repo, 'updateProvider')
      .mockRejectedValue(new Error('D1_ERROR 10042: private SQL detail'))
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    await wrapper.get('[data-provider-toggle="lx"]').setValue(false)
    await flushPromises()

    expect(updateProvider).toHaveBeenCalledWith('lx', { enabled: false })
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect((wrapper.get('[data-provider-toggle="lx"]').element as HTMLInputElement).checked).toBe(true)
    expect((wrapper.get('[data-provider-toggle="chksz"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('[data-admin-error-banner]').text()).toContain('音源設定儲存失敗')
    expect(wrapper.get('[data-admin-error-banner]').text()).not.toContain('D1_ERROR')
    expect(wrapper.get('[data-admin-error-banner]').text()).not.toContain('private SQL detail')
  })

  it('warns that provider state may be stale when the save and refresh both fail', async () => {
    const preferences = usePreferences()
    const previousLocale = preferences.locale.value
    preferences.setLocale('zh-Hant')
    cleanups.push(() => preferences.setLocale(previousLocale))

    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview')
      .mockResolvedValueOnce({
        providers: [
          makeProvider({ key: 'chksz', priority: 10 }),
          makeProvider({ key: 'lx', priority: 20 }),
        ],
        activeNoticeCount: 0,
      })
      .mockRejectedValueOnce(new Error('private refresh failure'))
    vi.spyOn(repo, 'updateProvider').mockRejectedValue(new Error('private persistence failure'))
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    await wrapper.get('[data-provider-toggle="lx"]').setValue(false)
    await flushPromises()

    expect((wrapper.get('[data-provider-toggle="lx"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('[data-admin-error-banner]').text()).toContain('畫面可能已過期')
    expect(wrapper.get('[data-admin-error-banner]').text()).not.toContain('private')
  })

  it('clears a provider failure banner after a later save succeeds', async () => {
    const preferences = usePreferences()
    const previousLocale = preferences.locale.value
    preferences.setLocale('zh-Hant')
    cleanups.push(() => preferences.setLocale(previousLocale))

    const currentOverview: AdminOverview = {
      providers: [
        makeProvider({ key: 'chksz', priority: 10 }),
        makeProvider({ key: 'lx', priority: 20 }),
      ],
      activeNoticeCount: 0,
    }
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview')
      .mockResolvedValueOnce(currentOverview)
      .mockResolvedValueOnce(currentOverview)
    const updateProvider = vi.spyOn(repo, 'updateProvider')
      .mockRejectedValueOnce(new Error('private persistence failure'))
      .mockResolvedValueOnce(makeProvider({ key: 'lx', adminEnabled: false, effectiveEnabled: false, priority: 20 }))
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    await wrapper.get('[data-provider-toggle="lx"]').setValue(false)
    await flushPromises()
    expect(wrapper.find('[data-admin-error-banner]').exists()).toBe(true)
    expect((wrapper.get('[data-provider-toggle="lx"]').element as HTMLInputElement).checked).toBe(true)

    await wrapper.get('[data-provider-toggle="lx"]').setValue(false)
    await flushPromises()

    expect(updateProvider).toHaveBeenCalledTimes(2)
    expect((wrapper.get('[data-provider-toggle="lx"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('[data-admin-error-banner]').exists()).toBe(false)
  })

  it('updates ChKSz Owner fallback without changing the global provider toggle', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'owner' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue({
      ...overview,
      providers: [makeProvider({
        key: 'chksz',
        automaticPolicy: 'direct',
        ownerKeyConfigured: true,
        ownerFallbackEnabled: false,
        ownerFallbackUsable: false,
      })],
    })
    const updateFallback = vi.spyOn(repo, 'updateChkszOwnerFallback').mockResolvedValue({
      ownerKeyConfigured: true,
      ownerFallbackEnabled: true,
      ownerFallbackUsable: true,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'providers')
    const globalToggle = wrapper.get('[data-provider-toggle="chksz"]')
    const fallbackToggle = wrapper.get('[data-chksz-owner-fallback] input')
    const globalStateBefore = (globalToggle.element as HTMLInputElement).checked
    await fallbackToggle.setValue(true)
    await flushPromises()

    expect(updateFallback).toHaveBeenCalledWith(true)
    expect((wrapper.get('[data-provider-toggle="chksz"]').element as HTMLInputElement).checked).toBe(globalStateBefore)
    expect((wrapper.get('[data-chksz-owner-fallback] input').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('[data-chksz-owner-fallback]').text()).toContain('Owner fallback usable')
  })

  describe('provider ordering mutations', () => {
    it('updates provider order through repository and replaces local provider list', async () => {
      const repo = createAdminRepository()
      vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
      vi.spyOn(repo, 'getOverview').mockResolvedValue({
        providers: [
          makeProvider({ key: 'chksz', priority: 10 }),
          makeProvider({ key: 'lx', priority: 20 }),
          makeProvider({ key: 'jellyfin', priority: 30 }),
        ],
        activeNoticeCount: 0,
      })
      const reordered: AdminProvider[] = [
        makeProvider({ key: 'jellyfin', priority: 10 }),
        makeProvider({ key: 'chksz', priority: 20 }),
        makeProvider({ key: 'lx', priority: 30 }),
      ]
      const updateOrderSpy = vi.spyOn(repo, 'updateProviderOrder').mockResolvedValue(reordered)

      const wrapper = mountAdmin(repo)
      await flushPromises()
      await show(wrapper, 'providers')

      const providerControls = wrapper.findComponent({ name: 'ProviderControls' })
      providerControls.vm.$emit('order', ['jellyfin', 'chksz', 'lx'])
      await flushPromises()

      expect(updateOrderSpy).toHaveBeenCalledWith(['jellyfin', 'chksz', 'lx'])
      const renderedKeys = wrapper.findAll('[data-provider-key]').map((el) => el.attributes('data-provider-key'))
      expect(renderedKeys).toEqual(['jellyfin', 'chksz', 'lx'])
    })

    it('prevents overlapping reorder mutations while one is in-flight', async () => {
      const repo = createAdminRepository()
      vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
      vi.spyOn(repo, 'getOverview').mockResolvedValue({
        providers: [
          makeProvider({ key: 'chksz', priority: 10 }),
          makeProvider({ key: 'lx', priority: 20 }),
          makeProvider({ key: 'jellyfin', priority: 30 }),
        ],
        activeNoticeCount: 0,
      })
      let resolveOrder!: (providers: AdminProvider[]) => void
      const orderPromise = new Promise<AdminProvider[]>((resolve) => {
        resolveOrder = resolve
      })
      const updateOrderSpy = vi.spyOn(repo, 'updateProviderOrder').mockImplementation(() => orderPromise)

      const wrapper = mountAdmin(repo)
      await flushPromises()
      await show(wrapper, 'providers')

      const providerControls = wrapper.findComponent({ name: 'ProviderControls' })
      // First reorder request
      providerControls.vm.$emit('order', ['lx', 'chksz', 'jellyfin'])
      // Second overlapping reorder request
      providerControls.vm.$emit('order', ['jellyfin', 'lx', 'chksz'])

      expect(updateOrderSpy).toHaveBeenCalledTimes(1)
      expect(updateOrderSpy).toHaveBeenCalledWith(['lx', 'chksz', 'jellyfin'])

      resolveOrder([
        makeProvider({ key: 'lx', priority: 10 }),
        makeProvider({ key: 'chksz', priority: 20 }),
        makeProvider({ key: 'jellyfin', priority: 30 }),
      ])
      await flushPromises()
    })

    it('handles provider reorder error gracefully and resets mutating state', async () => {
      const repo = createAdminRepository()
      vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
      vi.spyOn(repo, 'getOverview').mockResolvedValue({
        providers: [
          makeProvider({ key: 'chksz', priority: 10 }),
          makeProvider({ key: 'lx', priority: 20 }),
        ],
        activeNoticeCount: 0,
      })
      const updateOrderSpy = vi.spyOn(repo, 'updateProviderOrder').mockRejectedValue(new Error('admin_500'))

      const wrapper = mountAdmin(repo)
      await flushPromises()
      await show(wrapper, 'providers')

      const providerControls = wrapper.findComponent({ name: 'ProviderControls' })
      providerControls.vm.$emit('order', ['lx', 'chksz'])
      await flushPromises()

      expect(updateOrderSpy).toHaveBeenCalledTimes(1)
      const errorBanner = wrapper.find('[data-admin-error-banner]')
      expect(errorBanner.exists()).toBe(true)
      expect(errorBanner.text()).toContain('Failed to update provider order.')

      await wrapper.get('[data-admin-error-dismiss]').trigger('click')
      expect(wrapper.find('[data-admin-error-banner]').exists()).toBe(false)

      // Verify mutating state is reset so another reorder can be attempted
      updateOrderSpy.mockResolvedValueOnce([
        makeProvider({ key: 'lx', priority: 10 }),
        makeProvider({ key: 'chksz', priority: 20 }),
      ])
      providerControls.vm.$emit('order', ['lx', 'chksz'])
      await flushPromises()
      expect(updateOrderSpy).toHaveBeenCalledTimes(2)
    })
  })

  it('renders the notice list from the repository', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo, 'listNotices').mockResolvedValue([noticeFixture])
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    const items = wrapper.findAll('[data-notice-list] [data-notice-id]')
    expect(items).toHaveLength(1)
    const item = wrapper.find('[data-notice-id="notice-1"]')
    expect(item.attributes('data-notice-status')).toBe('draft')
    expect(item.attributes('data-notice-severity')).toBe('warning')
    expect(item.find('[data-notice-snippet="notice-1"]').text()).toContain('系統維護中')
  })

  it('creates a notice through the editor and reloads the list', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const listNotices = vi.spyOn(repo, 'listNotices')
    listNotices.mockResolvedValueOnce([])
    listNotices.mockResolvedValueOnce([noticeFixture])
    const createNotice = vi.spyOn(repo, 'createNotice').mockResolvedValue(noticeFixture)
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    expect(wrapper.find('[data-notice-editor]').exists()).toBe(false)
    await wrapper.find('[data-notice-new]').trigger('click')
    expect(wrapper.find('[data-notice-editor]').exists()).toBe(true)

    await wrapper.find('[data-notice-field-severity]').setValue('warning')
    await wrapper.find('[data-notice-field-targeting]').setValue('everyone')
    await wrapper.find('[data-notice-field-content="en"]').setValue('Maintenance in progress')
    await wrapper.find('[data-notice-editor]').trigger('submit')
    await flushPromises()

    const expected: AdminNoticeInput = {
      severity: 'warning',
      targeting: 'everyone',
      content: { en: 'Maintenance in progress' },
      startAt: null,
      endAt: null,
    }
    expect(createNotice).toHaveBeenCalledWith(expected)
    expect(wrapper.find('[data-notice-id="notice-1"]').exists()).toBe(true)
  })

  it('publishes a notice through the repository', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const listNotices = vi.spyOn(repo, 'listNotices')
    listNotices.mockResolvedValueOnce([noticeFixture])
    listNotices.mockResolvedValueOnce([{ ...noticeFixture, status: 'published', publishedAt: 3000 }])
    const publishNotice = vi.spyOn(repo, 'publishNotice').mockResolvedValue({
      ...noticeFixture, status: 'published', publishedAt: 3000,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    expect(wrapper.find('[data-notice-publish]').exists()).toBe(true)
    expect(wrapper.find('[data-notice-archive]').exists()).toBe(true)
    await wrapper.find('[data-notice-publish]').trigger('click')
    await flushPromises()

    expect(publishNotice).toHaveBeenCalledWith('notice-1')
  })

  it('hides Publish but keeps Archive for published notices', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo, 'listNotices').mockResolvedValue([{
      ...noticeFixture,
      status: 'published',
      publishedAt: 3000,
    }])
    const publishNotice = vi.spyOn(repo, 'publishNotice')
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    const item = wrapper.find('[data-notice-id="notice-1"]')
    expect(item.attributes('data-notice-status')).toBe('published')
    expect(item.text()).toContain('系統維護中')
    expect(wrapper.find('[data-notice-publish]').exists()).toBe(false)
    expect(wrapper.find('[data-notice-archive]').exists()).toBe(true)
    expect(publishNotice).not.toHaveBeenCalled()
  })

  it('archives a notice through the repository', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const listNotices = vi.spyOn(repo, 'listNotices')
    listNotices.mockResolvedValueOnce([{ ...noticeFixture, status: 'published', publishedAt: 3000 }])
    listNotices.mockResolvedValueOnce([{ ...noticeFixture, status: 'archived', archivedAt: 4000 }])
    const archiveNotice = vi.spyOn(repo, 'archiveNotice').mockResolvedValue({
      ...noticeFixture, status: 'archived', archivedAt: 4000,
    })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    expect(wrapper.find('[data-notice-archive]').exists()).toBe(true)
    await wrapper.find('[data-notice-archive]').trigger('click')
    await flushPromises()

    expect(archiveNotice).toHaveBeenCalledWith('notice-1')
  })

  it('hides invalid lifecycle actions for archived notices while retaining metadata', async () => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    const archiveNotice = vi.spyOn(repo, 'archiveNotice')
    vi.spyOn(repo, 'listNotices').mockResolvedValue([{
      ...noticeFixture,
      status: 'archived',
      archivedAt: 4000,
    }])
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    const item = wrapper.find('[data-notice-id="notice-1"]')
    expect(item.attributes('data-notice-status')).toBe('archived')
    expect(item.text()).toContain('系統維護中')
    expect(item.text()).toContain('archived')
    expect(wrapper.find('[data-notice-publish]').exists()).toBe(false)
    expect(wrapper.find('[data-notice-archive]').exists()).toBe(false)
    expect(archiveNotice).not.toHaveBeenCalled()
  })
})

/**
 * The console used to stack all five managers in one scroll, which is why the Owner
 * called it uncomfortable: reaching the audit log meant scrolling past three other
 * tools, and every one of them fetched on load. These tests pin the replacement --
 * one active section, chosen from a persistent nav, mounted on first visit and kept
 * mounted afterwards so a half-finished notice or an audit filter survives a detour.
 */
describe('AdminShell sections', () => {
  const authorisedRepo = (role: AdminRole = 'admin'): AdminRepository => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role })
    vi.spyOn(repo, 'getOverview').mockResolvedValue(overview)
    vi.spyOn(repo, 'listNotices').mockResolvedValue([noticeFixture])
    vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
    vi.spyOn(repo, 'listAudit').mockResolvedValue({ entries: [], total: 0, limit: 25, offset: 0 })
    return repo
  }

  /**
   * Reads the inline display that v-show writes, not isVisible(): jsdom hands back a
   * cached getComputedStyle declaration per element, so isVisible() reports whatever
   * was true the first time it was called on that element and never updates.
   */
  const visibleSections = (wrapper: ReturnType<typeof mountAdmin>): string[] =>
    wrapper.findAll('[data-admin-section]')
      .filter((section) => (section.element as HTMLElement).style.display !== 'none')
      .map((section) => section.attributes('data-admin-section') ?? '')

  it('opens on Overview and shows only that section', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    expect(visibleSections(wrapper)).toEqual(['overview'])
    expect(wrapper.get('[data-admin-nav-overview]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-admin-nav-providers]').attributes('aria-current')).toBeUndefined()
  })

  it('shows exactly one section for each navigation target', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    for (const section of ['providers', 'notices', 'backgrounds', 'audit', 'overview']) {
      await show(wrapper, section)
      expect(visibleSections(wrapper)).toEqual([section])
      expect(wrapper.get(`[data-admin-nav-${section}]`).attributes('aria-current')).toBe('page')
    }
  })

  it('reveals each manager exactly once when its section is selected', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    // Scoped to the owning section, so these also pin each manager's root hook to the
    // section that is meant to contain it.
    await show(wrapper, 'providers')
    expect(wrapper.findAll('#admin-providers [data-provider-controls]')).toHaveLength(1)
    expect(wrapper.findAll('#admin-providers [data-provider-health-card]')).toHaveLength(1)

    await show(wrapper, 'notices')
    expect(wrapper.findAll('#admin-notices [data-notice-manager]')).toHaveLength(1)

    await show(wrapper, 'backgrounds')
    expect(wrapper.findAll('#admin-backgrounds [data-background-manager]')).toHaveLength(1)

    await show(wrapper, 'audit')
    expect(wrapper.findAll('#admin-audit [data-audit-log]')).toHaveLength(1)
  })

  it('does not fetch a tool until its section is first opened', async () => {
    const repo = authorisedRepo()
    const listNotices = vi.spyOn(repo, 'listNotices')
    const listAudit = vi.spyOn(repo, 'listAudit')
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-notice-manager]').exists()).toBe(false)
    expect(wrapper.find('[data-audit-log]').exists()).toBe(false)
    expect(listNotices).not.toHaveBeenCalled()
    expect(listAudit).not.toHaveBeenCalled()

    await show(wrapper, 'notices')
    expect(listNotices).toHaveBeenCalledTimes(1)
    expect(listAudit).not.toHaveBeenCalled()
  })

  it('keeps a visited tool mounted so its in-progress work survives a detour', async () => {
    const repo = authorisedRepo()
    const listNotices = vi.spyOn(repo, 'listNotices')
    const wrapper = mountAdmin(repo)
    await flushPromises()

    await show(wrapper, 'notices')
    await wrapper.get('[data-notice-new]').trigger('click')
    await wrapper.get('[data-notice-field-content="en"]').setValue('Half written')
    expect(wrapper.find('[data-notice-editor]').exists()).toBe(true)

    await show(wrapper, 'providers')
    expect(visibleSections(wrapper)).toEqual(['providers'])
    expect(wrapper.find('[data-notice-manager]').exists()).toBe(true)

    await show(wrapper, 'notices')
    expect(wrapper.find('[data-notice-editor]').exists()).toBe(true)
    expect((wrapper.get('[data-notice-field-content="en"]').element as HTMLTextAreaElement).value)
      .toBe('Half written')
    expect(listNotices).toHaveBeenCalledTimes(1)
  })

  it('starts on the section named by the hash', async () => {
    setHash('#admin-audit')
    const wrapper = mountAdmin(authorisedRepo('owner'))
    await flushPromises()

    expect(visibleSections(wrapper)).toEqual(['audit'])
    expect(wrapper.get('[data-admin-nav-audit]').attributes('aria-current')).toBe('page')
  })

  it('falls back to Overview for a hash that names no section', async () => {
    setHash('#admin-nonsense')
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    expect(visibleSections(wrapper)).toEqual(['overview'])
  })

  it('ignores an audit hash for a session with no role', async () => {
    setHash('#admin-audit')
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'unauthorised' })
    const wrapper = mountAdmin(repo)
    await flushPromises()

    expect(wrapper.find('[data-admin-unauthorized]').exists()).toBe(true)
    expect(wrapper.find('[data-admin-section]').exists()).toBe(false)
    expect(wrapper.find('[data-audit-log]').exists()).toBe(false)
  })

  it('records the section in the hash so a view can be linked and revisited', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    await show(wrapper, 'backgrounds')
    expect(window.location.hash).toBe('#admin-backgrounds')
  })

  it('follows the hash when the browser navigates back', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()
    await show(wrapper, 'providers')
    expect(visibleSections(wrapper)).toEqual(['providers'])

    setHash('#admin-overview')
    window.dispatchEvent(new Event('hashchange'))
    await flushPromises()

    expect(visibleSections(wrapper)).toEqual(['overview'])
  })

  it('gives the ready console one page heading above its active section heading', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    const pageHeadings = wrapper.findAll('h1')
    expect(pageHeadings).toHaveLength(1)
    expect(pageHeadings[0].text()).toBe('Admin console')
    expect(wrapper.get('[data-admin-section="overview"] h2').text()).toBe('Overview')
  })

  it('gives the navigation a labelled landmark and no dead links', async () => {
    const wrapper = mountAdmin(authorisedRepo())
    await flushPromises()

    const nav = wrapper.get('[data-admin-sidebar] nav')
    expect(nav.attributes('aria-label')).toBeTruthy()
    const links = wrapper.findAll('[data-admin-sidebar] a')
    expect(links).toHaveLength(6)
    for (const link of links) {
      expect(link.attributes('href')).toMatch(/^#admin-[a-z]+$/u)
      expect(link.attributes('aria-controls')).toMatch(/^admin-[a-z]+$/u)
    }
  })

  it('reflows the navigation into a horizontal strip on a narrow viewport', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/admin/AdminShell.vue'), 'utf8')
    const narrow = source.slice(source.indexOf('@media (max-width: 768px)'))
    expect(narrow.startsWith('@media (max-width: 768px)')).toBe(true)
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(narrow).toMatch(/\.admin-shell__sidebar[^}]*overflow-x: auto;/u)
  })

  /**
   * Both halves of this were measured in Chrome, one of them after I broke it. A width
   * breakpoint split the providers column in two at 1280, where the console's rail left
   * only 472px a column and a provider row needs 576px, so both halves overflowed by
   * 70px. Replacing it with a bare minmax(36rem, 1fr) then overflowed a 375px viewport
   * by 225px, because auto-fit honours that floor even when the container is smaller.
   * min(100%, 36rem) is the form that survives both, and the one already used by
   * BackgroundManager's list.
   */
  it('splits the providers column only where a provider row fits, and never past the viewport', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/admin/AdminShell.vue'), 'utf8')
    const rule = /\.admin-shell__providers \{[^}]*\}/u.exec(source)?.[0] ?? ''
    expect(rule).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 36rem), 1fr));')
    expect(source).not.toContain('@media (min-width: 64rem)')
  })
})

/**
 * Overview is the landing section, so it should answer "is anything wrong and does it
 * need me" before the admin picks a tool. Every figure here is read straight off the
 * getOverview payload -- activeNoticeCount, the session role, and the providers array
 * -- because the admin API returns nothing else and a console that showed invented
 * numbers would be worse than one that showed none.
 */
describe('AdminShell overview', () => {
  const mountWith = (providers: AdminProvider[], activeNoticeCount = 3) => {
    const repo = createAdminRepository()
    vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'admin' })
    vi.spyOn(repo, 'getOverview').mockResolvedValue({ providers, activeNoticeCount })
    return mountAdmin(repo)
  }

  const DASH = '—'

  it('counts how many providers are live out of those configured', async () => {
    const wrapper = mountWith([
      makeProvider({ key: 'youtube', effectiveEnabled: true }),
      makeProvider({ key: 'r2', adminEnabled: false, effectiveEnabled: false }),
      makeProvider({ key: 'meting', effectiveEnabled: true }),
    ])
    await flushPromises()

    expect(wrapper.get('[data-admin-card="providers"]').text()).toContain('2 / 3')
  })

  it('names the live providers that last reported trouble', async () => {
    const wrapper = mountWith([
      makeProvider({ key: 'youtube', status: 'healthy' }),
      makeProvider({ key: 'meting', status: 'degraded', failureClass: 'timeout' }),
      makeProvider({ key: 'chksz', status: 'unavailable', failureClass: 'dns' }),
    ])
    await flushPromises()

    expect(wrapper.get('[data-admin-card="attention"]').text()).toContain('2')
    const items = wrapper.findAll('[data-admin-attention-item]')
    expect(items.map((item) => item.attributes('data-admin-attention-item'))).toEqual(['chksz', 'meting'])
    expect(items[0].text()).toContain('unavailable')
    expect(items[0].text()).toContain('dns')
    expect(wrapper.find('[data-admin-attention-item="youtube"]').exists()).toBe(false)
    expect(wrapper.find('[data-admin-attention-clear]').exists()).toBe(false)
  })

  it('leaves a disabled provider off the attention list because it carries no traffic', async () => {
    const wrapper = mountWith([
      makeProvider({ key: 'youtube', status: 'healthy' }),
      makeProvider({
        key: 'r2', adminEnabled: false, deploymentAvailable: false, effectiveEnabled: false,
        status: 'unavailable', failureClass: 'dns',
      }),
    ])
    await flushPromises()

    expect(wrapper.find('[data-admin-attention-item="r2"]').exists()).toBe(false)
    expect(wrapper.get('[data-admin-attention-clear]').text()).toContain('healthy')
    expect(wrapper.get('[data-admin-card="attention"]').text()).toContain('0')
  })

  it('treats an unprobed provider as unknown rather than as a fault', async () => {
    const wrapper = mountWith([makeProvider({ key: 'youtube', status: 'unknown', checkedAt: null })])
    await flushPromises()

    expect(wrapper.find('[data-admin-attention-item="youtube"]').exists()).toBe(false)
    expect(wrapper.get('[data-admin-card="attention"]').text()).toContain('0')
  })

  it('sends the attention list through to the Providers section', async () => {
    const wrapper = mountWith([makeProvider({ key: 'meting', status: 'degraded' })])
    await flushPromises()

    await wrapper.get('[data-admin-attention-link]').trigger('click')
    await flushPromises()

    const visible = wrapper.findAll('[data-admin-section]')
      .filter((section) => (section.element as HTMLElement).style.display !== 'none')
      .map((section) => section.attributes('data-admin-section'))
    expect(visible).toEqual(['providers'])
    expect(wrapper.findAll('#admin-providers [data-provider-controls]')).toHaveLength(1)
  })

  it('shows a dash rather than a fabricated zero when no providers are configured', async () => {
    const wrapper = mountWith([], 0)
    await flushPromises()

    expect(wrapper.get('[data-admin-card="providers"]').text()).toContain(DASH)
    expect(wrapper.get('[data-admin-card="attention"]').text()).toContain(DASH)
    expect(wrapper.find('[data-admin-attention-clear]').exists()).toBe(false)
    expect(wrapper.get('[data-admin-card="notices"]').text()).toContain('0')
  })
})

/**
 * The health card's narrow layout is a named grid, and it had a cell nobody claimed:
 * the latency figure was assigned by .provider-health__metric:first-of-type, which
 * matches no element at all, because every child of the row is a span and the first
 * span is the status dot. The unplaced figure auto-flowed into the 12px dot column.
 * Positional pseudo-classes over a run of identical spans are the trap, so these tests
 * pin the areas to plain class selectors and require every cell to have an owner.
 */
describe('ProviderHealthCard row layout', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/admin/ProviderHealthCard.vue'), 'utf8')
  const narrow = source.slice(source.indexOf('@media (max-width: 36rem)'))

  it('gives every named cell an owner', () => {
    const areas = new Set([...narrow.matchAll(/"([a-z. ]+)"/gu)]
      .flatMap((match) => (match[1] ?? '').split(/\s+/u))
      .filter((name) => name !== '.' && name !== ''))
    expect(areas.size).toBeGreaterThan(0)
    for (const area of areas) {
      expect(narrow).toMatch(new RegExp(`\\.provider-health__[a-z-]+ \\{ grid-area: ${area}; \\}`, 'u'))
    }
  })

  it('places each cell by class rather than by position among identical spans', () => {
    const assignments = [...narrow.matchAll(/^\s*(\S+) \{ grid-area:/gmu)].map((match) => match[1] ?? '')
    expect(assignments.length).toBeGreaterThan(0)
    for (const selector of assignments) {
      expect(selector).not.toContain(':')
      const className = selector.slice(1)
      expect(source.slice(0, source.indexOf('<style'))).toContain(className)
    }
  })
})
