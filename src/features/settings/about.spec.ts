import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { listStaticBackgrounds } from '../backgrounds/catalogue'
import { aboutLinks, privacyLinks } from './disclosureLinks'
import { PUBLIC_NOTICES } from '../../../scripts/public-notices'

import en from '../../i18n/messages/en'
import zhHans from '../../i18n/messages/zh-Hans'
import zhHant from '../../i18n/messages/zh-Hant'

const catalogues = { en, 'zh-Hant': zhHant, 'zh-Hans': zhHans } as const

/**
 * The About copy makes factual claims about licensing and provenance. These assertions pin the
 * claims to what the repository actually records, so a future edit cannot quietly drift into a
 * legal statement nobody verified.
 */
describe('About copy', () => {
  it('names the combined licence as GPL-3.0 in every locale', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.about.licence'], locale).toContain('GPL-3.0')
    }
  })

  it('credits StudyWithMiku as the upstream and Liquid Glass Studio under MIT', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.about.lineage'], locale).toContain('StudyWithMiku')
      expect(catalogue['settings.about.liquidGlass'], locale).toContain('MIT')
      expect(catalogue['settings.about.liquidGlass'], locale).toContain('Charles Yin')
    }
  })

  it('states the unofficial position without claiming endorsement', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.about.unofficial'], locale).toContain('HoYoverse')
      expect(catalogue['settings.about.unofficial'], locale).not.toMatch(/endorsed by HoYoverse(?!.)/u)
    }
  })

  it('describes provenance as a requirement and does not claim media has been cleared', () => {
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const provenance = `${catalogue['settings.about.provenance']} ${catalogue['settings.about.provenanceOpen']}`
      expect(provenance, locale).not.toMatch(/all (?:bundled )?media (?:is|has been) cleared/iu)
      expect(provenance, locale).not.toMatch(/fully licensed|rights cleared|all rights secured/iu)
    }
  })

  it('reflects the retired scene and existing background inventory', () => {
    expect(existsSync('public/scenes/quiet-study-room.png')).toBe(false)
    expect(existsSync('public/backgrounds/zzz')).toBe(false)
    expect(readFileSync('NOTICE', 'utf8')).toContain('No soundtrack library, game artwork or animated game wallpaper is included')
    expect(listStaticBackgrounds().every(item => item.rightsStatus === 'not-reviewed')).toBe(true)
    expect(en['settings.about.provenanceOpen']).toMatch(/not reviewed/iu)
    expect(zhHant['settings.about.provenanceOpen']).toMatch(/尚未|未經/u)
    expect(zhHans['settings.about.provenanceOpen']).toMatch(/尚未|未经/u)
    expect(en['settings.about.provenanceOpen']).toMatch(/background/iu)
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      expect(catalogue['settings.about.provenanceOpen'], locale).not.toMatch(/bundled scene image|場景圖|场景图/u)
    }
    expect(en['settings.about.identity']).toContain('Study with HOYO-MiX')
  })

  it('keeps the internal provenance ledger off the public About page and legal assets', () => {
    expect(aboutLinks.map(link => link.href)).not.toContain('/legal/asset-provenance.txt')
    expect(Object.keys(PUBLIC_NOTICES)).not.toContain('/legal/asset-provenance.txt')
    expect(existsSync('NOTICE')).toBe(true)
    expect(existsSync('docs/THIRD_PARTY_NOTICES.md')).toBe(true)
  })

  it('links to real repository notices and primary attribution sources', () => {
    expect(readFileSync('LICENSE', 'utf8')).toContain('Version 3, 29 June 2007')
    expect(aboutLinks.map(link => link.href)).toContain('https://github.com/shshouse/StudyWithMiku')
    expect(aboutLinks.map(link => link.href)).not.toContain('https://github.com/shshouse')
    for (const link of [...aboutLinks, ...privacyLinks]) {
      expect(new URL(link.href, 'https://localhost').protocol).toBe('https:')
      if (link.href.startsWith('/legal/')) expect(existsSync(PUBLIC_NOTICES[link.href as keyof typeof PUBLIC_NOTICES])).toBe(true)
      for (const catalogue of Object.values(catalogues)) expect(catalogue[link.label]).toBeTruthy()
    }
  })

  it('exposes no secret, provider credential, account identifier or internal asset record', () => {
    const forbidden = [
      /CHKSZ/i, /MUSIC_U/, /R2_BASE_URL/, /account[_ ]?id/i, /client[_ ]?secret/i,
      /SHA-?256/i, /codex-clipboard/i, /api[_ ]?key/i,
    ]
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const copy = Object.entries(catalogue)
        .filter(([key]) => key.startsWith('settings.about.'))
        .map(([, value]) => value)
        .join(' ')
      for (const pattern of forbidden) {
        expect(pattern.test(copy), `${locale} leaks ${pattern}`).toBe(false)
      }
    }
  })

  it('invents no support link and no version string', () => {
    // Neither is configured anywhere in the repository, so About must not imply one exists.
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const copy = Object.entries(catalogue)
        .filter(([key]) => key.startsWith('settings.about.'))
        .map(([, value]) => value)
        .join(' ')
      expect(copy, locale).not.toMatch(/donate|patreon|ko-fi|buy me a coffee|贊助|赞助/iu)
      expect(copy, locale).not.toMatch(/\bv?\d+\.\d+\.\d+\b/u)
    }
  })
})
