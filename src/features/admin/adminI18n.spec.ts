import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminShell from './AdminShell.vue'
import { createAdminRepository, type AdminOverview, type AdminSessionResult } from './client'
import enMessages from '../../i18n/messages/en'
import zhHantMessages from '../../i18n/messages/zh-Hant'
import zhHansMessages from '../../i18n/messages/zh-Hans'
import { usePreferences } from '../../stores/preferences'

const LOCALES = ['en', 'zh-Hant', 'zh-Hans'] as const

function makeMockOverview(): AdminOverview {
  return {
    activeNoticeCount: 1,
    providers: [
      {
        key: 'youtube',
        status: 'healthy',
        priority: 100,
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
        automaticPolicy: 'direct',
        latencyMs: 120,
        checkedAt: Date.now() - 30000,
        updatedAt: Date.now() - 30000,
        failureClass: null,
      },
    ],
  }
}

function setupAdminShell() {
  const repo = createAdminRepository()
  vi.spyOn(repo, 'checkSession').mockResolvedValue({ status: 'authorised', role: 'owner' })
  vi.spyOn(repo, 'getOverview').mockResolvedValue(makeMockOverview())
  vi.spyOn(repo, 'listNotices').mockResolvedValue([])
  vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([])
  vi.spyOn(repo, 'getCatalogueStatus').mockResolvedValue({
    configured: true,
    role: 'owner',
    sheetUrl: 'https://docs.google.com',
    serviceAccountEmail: 'test@example.com',
    lastBatch: null,
  })
  vi.spyOn(repo, 'listAudit').mockResolvedValue({ entries: [], total: 0, limit: 50, offset: 0 })
  return { repo }
}

describe('Admin i18n & Localization Coverage', () => {
  it('has 100% key parity across en, zh-Hant, and zh-Hans for all admin keys', () => {
    const adminEnKeys = Object.keys(enMessages).filter((k) => k.startsWith('admin.'))
    const adminZhHantKeys = Object.keys(zhHantMessages).filter((k) => k.startsWith('admin.'))
    const adminZhHansKeys = Object.keys(zhHansMessages).filter((k) => k.startsWith('admin.'))

    expect(adminEnKeys.length).toBeGreaterThan(30)
    expect(adminZhHantKeys.sort()).toEqual(adminEnKeys.sort())
    expect(adminZhHansKeys.sort()).toEqual(adminEnKeys.sort())

    for (const key of adminEnKeys) {
      expect((zhHantMessages as Record<string, string>)[key].trim()).not.toBe('')
      expect((zhHansMessages as Record<string, string>)[key].trim()).not.toBe('')
    }
  })

  it('does not translate provider machine keys into translated text', () => {
    const machineKeys = ['youtube', 'meting', 'chksz', 'r2', 'lx-huibq', 'lx-ikun']
    for (const key of machineKeys) {
      // Machine keys should not exist as root translation keys
      expect(key in enMessages).toBe(false)
      expect(key in zhHantMessages).toBe(false)
      expect(key in zhHansMessages).toBe(false)
    }
  })

  for (const locale of LOCALES) {
    it(`renders all Admin console sections in ${locale} without untranslated key leaks`, async () => {
      usePreferences().setLocale(locale)
      const { repo } = setupAdminShell()
      const wrapper = mount(AdminShell, { props: { repository: repo }, attachTo: document.body })
      await flushPromises()

      const sections = ['overview', 'providers', 'notices', 'backgrounds', 'catalogue', 'audit'] as const

      for (const section of sections) {
        const navBtn = wrapper.find(`[data-admin-nav-item="${section}"]`)
        if (navBtn.exists()) {
          await navBtn.trigger('click')
          await flushPromises()
        }

        const text = wrapper.text()

        // Verify no raw untranslated 'admin.*' keys are displayed to users
        const rawAdminKeyMatches = text.match(/\badmin\.[a-zA-Z0-9_.-]+/g)
        expect(rawAdminKeyMatches).toBeNull()

        // Verify no undefined or NaN text rendered in UI
        expect(text).not.toContain('undefined')
        expect(text).not.toContain('NaN')
      }

      // Check locale-specific title strings
      if (locale === 'en') {
        expect(wrapper.text()).toContain('Admin console')
        expect(wrapper.text()).toContain('Overview')
        expect(wrapper.text()).toContain('Providers')
      } else if (locale === 'zh-Hant') {
        expect(wrapper.text()).toContain('管理控制台')
        expect(wrapper.text()).toContain('概覽')
        expect(wrapper.text()).toContain('音源提供商')
      } else if (locale === 'zh-Hans') {
        expect(wrapper.text()).toContain('管理控制台')
        expect(wrapper.text()).toContain('概览')
        expect(wrapper.text()).toContain('音源提供商')
      }

      wrapper.unmount()
    })
  }

  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    it(`renders ProviderControls in ${locale} with zero English leaks`, async () => {
      usePreferences().setLocale(locale)
      const mockProviders = [
        {
          key: 'chksz',
          status: 'healthy' as const,
          priority: 10,
          adminEnabled: true,
          deploymentAvailable: true,
          effectiveEnabled: true,
          automaticPolicy: 'direct' as const,
          latencyMs: 120,
          checkedAt: Date.now() - 30000,
          updatedAt: Date.now() - 30000,
          failureClass: null,
        },
        {
          key: 'lx',
          status: 'healthy' as const,
          priority: 20,
          adminEnabled: true,
          deploymentAvailable: true,
          effectiveEnabled: true,
          automaticPolicy: 'direct' as const,
          latencyMs: null,
          checkedAt: null,
          updatedAt: Date.now() - 60000,
          failureClass: null,
        },
      ]
      const ProviderControls = (await import('./ProviderControls.vue')).default
      const wrapper = mount(ProviderControls, { props: { providers: mockProviders } })
      await flushPromises()

      const html = wrapper.html()
      const englishPhrases = [
        'Enabled by Admin',
        'Disabled by Admin',
        'Available in this deployment',
        'Unavailable in this deployment',
        'Move ChKSz BYOK up',
        'Move ChKSz BYOK down',
        'Owner fallback usable',
        'Reset default order',
        'DISABLE ALL PLAYBACK',
      ]
      for (const phrase of englishPhrases) {
        expect(html).not.toContain(phrase)
      }

      if (locale === 'zh-Hant') {
        expect(html).toContain('管理員已啟用')
        expect(html).toContain('部署中可用')
        expect(html).toContain('已生效')
        expect(html).toContain('上移')
        expect(html).toContain('重設預設順序')
      } else {
        expect(html).toContain('管理员已启用')
        expect(html).toContain('部署中可用')
        expect(html).toContain('已生效')
        expect(html).toContain('上移')
        expect(html).toContain('重置默认顺序')
      }

      wrapper.unmount()
    })

    it(`renders BackgroundManager in ${locale} with zero English leaks`, async () => {
      usePreferences().setLocale(locale)
      const repo = createAdminRepository()
      vi.spyOn(repo, 'listBackgrounds').mockResolvedValue([
        {
          id: 'bg-sample',
          revision: 1,
          kind: 'image',
          status: 'published',
          contentType: 'image/webp',
          byteSize: 1024,
          width: 1920,
          height: 1080,
          durationMs: null,
          mediaUrl: 'https://example.com/bg.webp',
          posterUrl: 'https://example.com/poster.webp',
          rightsStatus: 'Hoyoverse',
          createdAt: 1000,
          updatedAt: 2000,
          publishedAt: 2000,
          archivedAt: null,
        },
      ])
      const BackgroundManager = (await import('./BackgroundManager.vue')).default
      const wrapper = mount(BackgroundManager, { props: { repository: repo } })
      await flushPromises()

      const html = wrapper.html()
      const englishPhrases = [
        'Loading background media...',
        'JPEG, PNG, or WebP; up to 12 MB',
        'Video upload is unavailable',
        'Permanently delete',
        'Status:',
        'Rights/provenance:',
        'Poster:',
        'Background preview',
      ]
      for (const phrase of englishPhrases) {
        expect(html).not.toContain(phrase)
      }

      // Check accessibility attribute on img
      const img = wrapper.find('img')
      expect(img.attributes('alt')).toBe(locale === 'zh-Hant' ? '背景預覽' : '背景预览')

      if (locale === 'zh-Hant') {
        expect(html).toContain('狀態')
        expect(html).toContain('版權與出處')
        expect(html).toContain('封面圖')
        expect(html).toContain('已發布')
      } else {
        expect(html).toContain('状态')
        expect(html).toContain('版权与出处')
        expect(html).toContain('封面图')
        expect(html).toContain('已发布')
      }

      wrapper.unmount()
    })

    it(`renders CatalogueManager in ${locale} with localized preserved summaries and a11y labels`, async () => {
      usePreferences().setLocale(locale)
      const repo = createAdminRepository()
      const proposal = {
        changeId: 'change-complex',
        entityType: 'track',
        entityKey: 'track-complex',
        kind: 'metadata_change',
        before: { title: 'Old Title' },
        after: {
          title: 'New Title',
          custom_str: 'unmodeled_string',
          custom_num: 42,
          custom_bool: true,
        },
        validationState: 'valid',
        messages: [],
        confidence: 0.9,
        decision: 'pending',
      }
      const batch = {
        batchId: 'batch-test',
        status: 'draft',
        baseRevision: 1,
        reviewRevision: 1,
        createdAt: 1000,
        updatedAt: 1000,
        publishedAt: null,
        summary: { metadata_change: 1 },
        changes: [proposal],
      }
      vi.spyOn(repo, 'getCatalogueStatus').mockResolvedValue({
        configured: true,
        role: 'admin',
        sheetUrl: 'https://docs.google.com',
        serviceAccountEmail: 'test@example.com',
        lastBatch: batch as any,
      })

      const CatalogueManager = (await import('./CatalogueManager.vue')).default
      const wrapper = mount(CatalogueManager, { props: { repository: repo }, attachTo: document.body })
      await flushPromises()
      // The Sheet review pipeline now lives behind its own view; the catalogue browser is the default.
      await wrapper.get('[data-catalogue-view="review"]').trigger('click')
      await flushPromises()

      // Inspect accessibility attribute
      const nav = wrapper.find('nav.catalogue-manager__stepper')
      expect(nav.attributes('aria-label')).toBe(locale === 'zh-Hant' ? '目錄審核流程' : '目录审核流程')

      // Open proposal editor
      await wrapper.get('[data-catalogue-edit="change-complex"]').trigger('click')
      await flushPromises()

      // Preserved fields elements
      const strField = wrapper.find('[data-catalogue-preserved-field="custom_str"]')
      const numField = wrapper.find('[data-catalogue-preserved-field="custom_num"]')
      const boolField = wrapper.find('[data-catalogue-preserved-field="custom_bool"]')

      expect(strField.exists()).toBe(true)
      expect(numField.exists()).toBe(true)
      expect(boolField.exists()).toBe(true)

      const preservedSummaryText = [strField.text(), numField.text(), boolField.text()].join(' ')

      // Assert rendered preserved summaries contain no English types
      expect(preservedSummaryText).not.toContain('String')
      expect(preservedSummaryText).not.toContain('Number')
      expect(preservedSummaryText).not.toContain('Boolean')

      // Assert localized types are present
      if (locale === 'zh-Hant') {
        expect(strField.text()).toContain('字串')
        expect(numField.text()).toContain('數字')
        expect(boolField.text()).toContain('布林值')
      } else {
        expect(strField.text()).toContain('字符串')
        expect(numField.text()).toContain('数字')
        expect(boolField.text()).toContain('布尔值')
      }

      wrapper.unmount()
    })
  }
})
