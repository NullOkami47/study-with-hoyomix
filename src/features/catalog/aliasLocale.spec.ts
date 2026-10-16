import { describe, expect, it } from 'vitest'

import {
  REACHABLE_ALIAS_LOCALES,
  isChineseLocaleTag,
  renderAliasLocaleReport,
  validateAliasLocales,
} from './aliasLocale'
import type { AliasedTrack } from './aliasLocale'

describe('REACHABLE_ALIAS_LOCALES', () => {
  it('matches the app Locale union exactly', () => {
    // If the Locale type gains or loses a member, this list must change with it. The assertion
    // is written out literally so a silent drift is caught here.
    expect([...REACHABLE_ALIAS_LOCALES]).toEqual(['en', 'zh-Hant', 'zh-Hans'])
  })
})

describe('validateAliasLocales', () => {
  it('recognises generic zh as a presentation fallback without rewriting its tag', () => {
    const track = { id: 'a', aliases: { zh: ['晨曦酒庄'] } }
    expect(validateAliasLocales([track]).issues).toEqual([])
    expect(validateAliasLocales([track]).reachableAliasCount).toBe(1)
    expect(track.aliases).toEqual({ zh: ['晨曦酒庄'] })
  })

  it('accepts every reachable locale without reporting an issue', () => {
    const report = validateAliasLocales([
      { id: 'a', aliases: { en: ['Title'], 'zh-Hant': ['標題'], 'zh-Hans': ['标题'] } },
    ])
    expect(report.issues).toEqual([])
    expect(report.unreachableLocales).toEqual([])
    expect(report.reachableAliasCount).toBe(3)
  })

  it('flags zh-CN, the exact defect found in the staging CSV', () => {
    const report = validateAliasLocales([{ id: 'zzz-tiny-giant', aliases: { 'zh-CN': ['微小的巨人'] } }])
    expect(report.unreachableLocales).toEqual(['zh-CN'])
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toEqual({
      trackId: 'zzz-tiny-giant',
      storedLocale: 'zh-CN',
      // Region tags do not encode the script, so the target is genuinely ambiguous.
      likelyLocale: null,
      valueCount: 1,
    })
  })

  it('flags fr-FR as unreachable, because the app has no French interface', () => {
    const report = validateAliasLocales([{ id: 'a', aliases: { 'fr-FR': ['La vaguelette'] } }])
    expect(report.unreachableLocales).toEqual(['fr-FR'])
    expect(report.issues[0]!.likelyLocale).toBeNull()
    expect(isChineseLocaleTag('fr-FR')).toBe(false)
  })

  it('resolves a script-explicit but extended Chinese tag to its base locale', () => {
    // Unlike zh-CN, the script IS encoded here, so the intended target is determinable.
    const report = validateAliasLocales([{ id: 'a', aliases: { 'zh-Hant-TW': ['標題'] } }])
    expect(report.issues[0]!.likelyLocale).toBe('zh-Hant')
  })

  it('resolves zh-TW and zh-HK to zh-Hant, matching mapBrowserLocale conventions', () => {
    expect(validateAliasLocales([{ id: 'a', aliases: { 'zh-TW': ['x'] } }]).issues[0]!.likelyLocale).toBe('zh-Hant')
    expect(validateAliasLocales([{ id: 'a', aliases: { 'zh-HK': ['x'] } }]).issues[0]!.likelyLocale).toBe('zh-Hant')
  })

  it('does not flag a reachable locale even when it is empty', () => {
    const report = validateAliasLocales([{ id: 'a', aliases: { 'zh-Hant': [] } }])
    expect(report.issues).toEqual([])
    expect(report.reachableAliasCount).toBe(0)
  })

  it('does not flag an unreachable locale that holds no values, because nothing is lost', () => {
    // A rendering bug requires data. An empty unreachable key is harmless noise.
    const report = validateAliasLocales([{ id: 'a', aliases: { 'zh-CN': [] } }])
    expect(report.issues).toEqual([])
    expect(report.unreachableLocales).toEqual([])
  })

  it('counts values across multiple tracks under one unreachable tag', () => {
    const report = validateAliasLocales([
      { id: 'a', aliases: { 'zh-CN': ['one', 'two'] } },
      { id: 'b', aliases: { 'zh-CN': ['three'] } },
    ])
    expect(report.unreachableLocales).toEqual(['zh-CN'])
    expect(report.issues.map((i) => i.valueCount)).toEqual([2, 1])
  })

  it('is deterministic and preserves first-seen locale order', () => {
    // Annotated so the two heterogeneous literals widen to AliasedTrack[] rather
    // than inferring a union with `undefined` members, which would not satisfy
    // the Record<string, string[]> alias-map type.
    const tracks: AliasedTrack[] = [
      { id: 'a', aliases: { 'fr-FR': ['x'], 'zh-CN': ['y'] } },
      { id: 'b', aliases: { 'zh-CN': ['z'], ja: ['w'] } },
    ]
    const first = validateAliasLocales(tracks)
    const second = validateAliasLocales(tracks)
    expect(first).toEqual(second)
    expect(first.unreachableLocales).toEqual(['fr-FR', 'zh-CN', 'ja'])
  })

  it('tolerates a missing alias map and a malformed value', () => {
    expect(validateAliasLocales([{ id: 'a' }]).issues).toEqual([])
    const report = validateAliasLocales([{ id: 'a', aliases: { 'zh-CN': 'not-an-array' } as never }])
    expect(report.issues).toEqual([])
  })

  it('still counts reachable values when an unreachable one is also present', () => {
    const report = validateAliasLocales([
      { id: 'a', aliases: { 'zh-Hant': ['標題'], 'zh-CN': ['标题'] } },
    ])
    expect(report.reachableAliasCount).toBe(1)
    expect(report.issues).toHaveLength(1)
  })
})

describe('isChineseLocaleTag', () => {
  it('recognises Chinese tags case-insensitively', () => {
    expect(isChineseLocaleTag('zh')).toBe(true)
    expect(isChineseLocaleTag('zh-CN')).toBe(true)
    expect(isChineseLocaleTag('ZH-HANT')).toBe(true)
  })

  it('does not match a tag that merely starts with the letters zh', () => {
    expect(isChineseLocaleTag('zho')).toBe(false)
    expect(isChineseLocaleTag('en')).toBe(false)
    expect(isChineseLocaleTag('fr-FR')).toBe(false)
  })
})

describe('renderAliasLocaleReport', () => {
  it('states plainly when there is nothing to fix', () => {
    const text = renderAliasLocaleReport(validateAliasLocales([{ id: 'a', aliases: { en: ['x'] } }]))
    expect(text).toContain('Every stored alias is reachable')
  })

  it('names each affected track and locale without silently rewriting it', () => {
    const text = renderAliasLocaleReport(
      validateAliasLocales([{ id: 'zzz-tiny-giant', aliases: { 'zh-CN': ['微小的巨人'] } }]),
    )
    expect(text).toContain('zzz-tiny-giant')
    expect(text).toContain('zh-CN')
    expect(text).toContain('does not rewrite')
  })

  it('distinguishes an ambiguous target from a non-existent interface', () => {
    const ambiguous = renderAliasLocaleReport(
      validateAliasLocales([{ id: 'a', aliases: { 'zh-CN': ['x'] } }]),
    )
    expect(ambiguous).toContain('ambiguous')

    const noInterface = renderAliasLocaleReport(
      validateAliasLocales([{ id: 'a', aliases: { 'fr-FR': ['x'] } }]),
    )
    expect(noInterface).toContain('no interface')
  })
})
