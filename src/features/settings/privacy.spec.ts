import { describe, expect, it } from 'vitest'

import en from '../../i18n/messages/en'
import zhHans from '../../i18n/messages/zh-Hans'
import zhHant from '../../i18n/messages/zh-Hant'

const catalogues = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans } as const

const privacyCopy = (catalogue: Record<string, string>): string =>
  Object.entries(catalogue)
    .filter(([key]) => key.startsWith('settings.privacy.'))
    .map(([, value]) => value)
    .join(' ')

/**
 * Privacy copy is a factual description of implemented behaviour, not a policy aspiration. Each
 * assertion below is tied to a specific source fact, so a future edit that promises something the
 * code does not do fails here instead of shipping.
 */
describe('Privacy copy', () => {
  it('distinguishes scopes, received public profile data and persisted identity data', () => {
    // Google/LINUX DO use openid profile; GitHub /user can return public email.
    // Identity adapters persist only provider subject and display name, not email or avatar.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.account'], locale).toMatch(/Google/u)
      expect(catalogue['settings.privacy.account'], locale).toMatch(/GitHub/u)
      expect(catalogue['settings.privacy.account'], locale).toMatch(/LINUX DO/u)
    }
    expect(en['settings.privacy.account']).toMatch(/display name/iu)
    expect(en['settings.privacy.account']).toMatch(/public email/iu)
    expect(en['settings.privacy.account']).toMatch(/not store email/iu)
    expect(zhHant['settings.privacy.account']).toMatch(/顯示名稱/u)
    expect(zhHans['settings.privacy.account']).toMatch(/显示名称/u)
  })

  it('describes the session cookie with the lifetime the Worker actually sets', () => {
    // workers/auth/session.ts: SESSION_LIFETIME_MS = 90 days, HttpOnly; Secure; SameSite=Lax.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.session'], locale).toMatch(/90/u)
      expect(catalogue['settings.privacy.session'], locale).toMatch(/HttpOnly/u)
      expect(catalogue['settings.privacy.session'], locale).toMatch(/SameSite/u)
    }
  })

  it('describes device storage as local and names no server for it', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.device'], locale).toMatch(/localStorage|IndexedDB/u)
    }
    expect(en['settings.privacy.device']).toMatch(/this device/iu)
    expect(zhHant['settings.privacy.device']).toMatch(/本裝置|這部裝置/u)
    expect(zhHans['settings.privacy.device']).toMatch(/本设备|这台设备/u)
  })

  it('describes automatic account sync while excluding the music library', () => {
    expect(en['settings.privacy.sync']).toContain('automatically restore and save')
    expect(en['settings.privacy.sync']).toContain('Favourites, playlists and listening history are excluded')
    expect(zhHant['settings.privacy.sync']).toContain('自動')
    expect(zhHans['settings.privacy.sync']).toContain('自动')
    expect(en['settings.privacy.providerSync']).toMatch(/automatically/iu)
  })

  it('states that listening history is off until enabled and is capped', () => {
    // localRepository.ts:604 refuses to record unless preferences.historyEnabled is true, and both
    // the local and D1 paths keep at most 100 entries.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.history'], locale).toMatch(/100/u)
    }
    expect(en['settings.privacy.history']).toMatch(/off (?:by default|until)/iu)
  })

  it('states that the ChKSz key stays on the device and is never account-synced', () => {
    // chkszCredentialStore.ts uses page memory or remembered localStorage. Direct playback
    // calls ChKSz; discovery sends the key to this site's Worker in a request header.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.providerKey'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.providerKey']).toMatch(/not (?:synced|stored) (?:to|with) your account|never (?:synced|stored) (?:to|with) your account/iu)
    expect(en['settings.privacy.providerKey']).toMatch(/site.s server/iu)
    expect(en['settings.privacy.providerKey']).toMatch(/ChKSz/iu)
    expect(zhHant['settings.privacy.providerKey']).toMatch(/不會.*帳/u)
    expect(zhHans['settings.privacy.providerKey']).toMatch(/不会.*账/u)
  })

  it('separates operator request keys from user credentials', () => {
    // The Owner fallback key lives in Worker env and is gated on the D1 setting
    // provider.chksz.ownerKeyFallback, which defaults to disabled.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.operatorKeys'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.operatorKeys']).toMatch(/not your credential|not a user credential/iu)
    expect(en['settings.privacy.operatorKeys']).toMatch(/never sent to your browser/iu)
    // selectChkszCredential returns credential_required unless the D1 setting is exactly
    // { enabled: true }, so the fallback must be described as off by default.
    expect(en['settings.privacy.operatorKeys']).toMatch(/is off unless the operator/iu)
    expect(zhHant['settings.privacy.operatorKeys']).toMatch(/預設關閉/u)
    expect(zhHans['settings.privacy.operatorKeys']).toMatch(/默认关闭/u)
  })

  it('states that temporary provider media addresses are not kept as account data', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.mediaUrls'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.mediaUrls']).toMatch(/temporary/iu)
    expect(en['settings.privacy.mediaUrls']).toMatch(/not (?:saved|stored)/iu)
  })

  it('describes export and deletion in terms of what they actually do', () => {
    // exportAccountData returns favourites, playlists, preferences, focus sessions, provider
    // preferences and catalogue reports. deleteAccount deletes the user row and D1 cascades.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.export'], locale).toBeTruthy()
      expect(catalogue['settings.privacy.deletion'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.export']).toMatch(/JSON/u)
    expect(en['settings.privacy.deletion']).toMatch(/DELETE/u)
  })

  it('has separate enabled/disabled analytics disclosures and acknowledges service logs', () => {
    // vite.config.ts conditionally injects a marked tag. SettingsSheet reads that tag,
    // while service failure diagnostics exist independently of the analytics setting.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.analytics'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.analyticsDisabled']).toMatch(/no analytics script/iu)
    expect(en['settings.privacy.analyticsEnabled']).toMatch(/enabled/iu)
    expect(en['settings.privacy.analytics']).toMatch(/logs/iu)
    expect(en['settings.privacy.analytics']).not.toMatch(/no third-party tracking/iu)
  })

  it('discloses public chat, the enforced retention limits and optional coarse location', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.privacy.chat'], locale).toMatch(/30/u)
      expect(catalogue['settings.privacy.chat'], locale).toMatch(/10,000/u)
      expect(catalogue['settings.privacy.chatLocation'], locale).toMatch(/IP/u)
      expect(catalogue['settings.privacy.chatModeration'], locale).toBeTruthy()
    }
    expect(en['settings.privacy.chat']).toMatch(/public/iu)
    expect(en['settings.privacy.chatLocation']).toMatch(/optional/iu)
    expect(en['settings.privacy.chatModeration']).toMatch(/versions/iu)
  })

  it('invents no retention period, encryption guarantee, legal basis or sharing promise', () => {
    const forbidden = [
      /\b\d+\s*(?:days?|months?|years?)\b/iu,
      /encrypt/iu,
      /end-to-end/iu,
      /GDPR|CCPA|legal basis|legitimate interest/iu,
      /never shared with (?:any )?third part/iu,
      /we do not sell/iu,
      /anonymi[sz]ed/iu,
      /加密|法律依據|法律依据|絕不分享|绝不分享/u,
    ]
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const copy = privacyCopy(catalogue)
      for (const pattern of forbidden) {
        // The session lifetime is the one duration source establishes, so it is allowed there and
        // nowhere else.
        const withoutSession = copy.replace(catalogue['settings.privacy.session'], ' ')
          .replace(catalogue['settings.privacy.chat'], ' ')
          .replace(catalogue['settings.privacy.chatModeration'], ' ')
        expect(pattern.test(withoutSession), `${locale} invents ${pattern}`).toBe(false)
      }
    }
  })

  it('exposes no secret name, credential value or internal identifier', () => {
    const forbidden = [
      /CHKSZ_API_KEY/i, /MUSIC_U/, /R2_BASE_URL/, /client[_ ]?secret/i,
      /OAUTH_STATE_SECRET/i, /CF_ACCOUNT/i, /request[_ ]?key\s*[:=]/i,
    ]
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const copy = privacyCopy(catalogue)
      for (const pattern of forbidden) {
        expect(pattern.test(copy), `${locale} leaks ${pattern}`).toBe(false)
      }
    }
  })
})
