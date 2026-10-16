import { beforeAll, describe, expect, it } from 'vitest'
import { loadChineseTitleConverter, resolveDisplayTitle } from './displayTitle'
import { normaliseSearchText } from './searchText'
import { deriveLxCandidates } from '../player/lx/candidates'
import type { Track } from './types'

beforeAll(() => loadChineseTitleConverter())

const title = (aliases: Record<string, string[]>, canonical = 'Dawn Winery Theme') => ({ title: canonical, aliases })

describe('contextual Chinese title presentation', () => {
  it('keeps official exact aliases authoritative even when they use unusual script forms', () => {
    const track = title({ 'zh-Hant': ['官方酒庄'], 'zh-Hans': ['官方酒莊'], zh: ['通用标题'] })
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('官方酒庄')
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('官方酒莊')
  })
  it.each([
    ['zh-Hans', 'zh-Hant', '晨曦酒庄', '晨曦酒莊'],
    ['zh-Hant', 'zh-Hans', '晨曦酒莊', '晨曦酒庄'],
    ['zh-Hans', 'zh-Hant', '轻涟', '輕漣'],
    ['zh-Hans', 'zh-Hant', '使一颗心免于哀伤', '使一顆心免於哀傷'],
    ['zh-Hans', 'zh-Hant', '极限委托', '極限委託'],
    ['zh-Hans', 'zh-Hant', '里面的钟声', '裏面的鐘聲'],
  ] as const)('converts %s to %s: %s', (source, target, value, expected) => {
    expect(resolveDisplayTitle(title({ [source]: [value] }), target)).toBe(expected)
  })
  it('uses a safe generic zh alias before the opposite script', () => {
    const track = title({ zh: ['通用酒庄'], 'zh-Hans': ['另一酒庄'] })
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('通用酒莊')
    expect(resolveDisplayTitle(title({ zh: ['晨曦酒莊'] }), 'zh-Hans')).toBe('晨曦酒庄')
  })
  it.each(['神里綾華のテーマ', '神里綾華 カミサト', '봄의 酒庄', '酒庄 Тема', 'Dawn Winery Theme'])('keeps non-Chinese or mixed content untouched: %s', (value) => {
    expect(resolveDisplayTitle(title({ 'zh-Hans': [value] }), 'zh-Hant')).toBe(value)
    expect(resolveDisplayTitle(title({}, value), 'zh-Hans')).toBe(value)
  })
  it('protects Kanji-only Japanese provenance, including incorrectly duplicated Chinese aliases', () => {
    const value = '神里綾華'
    expect(resolveDisplayTitle(title({ ja: [value] }, value), 'zh-Hans')).toBe(value)
    expect(resolveDisplayTitle(title({ ja: [value], 'zh-Hant': [value] }, value), 'zh-Hans')).toBe(value)
    expect(resolveDisplayTitle(title({ 'ja-JP': ['酒庄'], zh: ['酒庄'] }, '酒庄'), 'zh-Hant')).toBe('酒庄')
  })
  it('does not cross-serve non-Chinese tagged aliases', () => {
    expect(resolveDisplayTitle(title({ ko: ['酒庄'], en: ['酒庄'] }), 'zh-Hant')).toBe('Dawn Winery Theme')
  })
  it('converts canonical only with matching Chinese alias provenance', () => {
    expect(resolveDisplayTitle(title({ 'zh-CN': ['晨曦酒庄'] }, '晨曦酒庄'), 'zh-Hant')).toBe('晨曦酒莊')
    expect(resolveDisplayTitle(title({ 'zh-TW': ['晨曦酒莊'] }, '晨曦酒莊'), 'zh-Hans')).toBe('晨曦酒庄')
    expect(resolveDisplayTitle(title({}, '酒庄'), 'zh-Hant')).toBe('酒庄')
    expect(resolveDisplayTitle(title({ 'zh-CN': ['別的標題'] }, '酒庄'), 'zh-Hant')).toBe('酒庄')
  })
  it('skips unsafe generic zh in favour of a safe opposite-script alias', () => {
    expect(resolveDisplayTitle(title({ zh: ['酒庄のテーマ'], 'zh-Hans': ['晨曦酒庄'] }), 'zh-Hant')).toBe('晨曦酒莊')
  })
  it('keeps search keys, provider bindings, canonical titles and aliases unchanged', () => {
    const track: Track = { id: 'genshin-dawn-winery-theme', title: 'Dawn Winery Theme', aliases: { 'zh-Hans': ['晨曦酒庄'] }, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'dawn', needsClassification: false, vocalStatus: 'instrumental', sources: [{ provider: 'chksz', externalId: '1315196858' }] }
    const snapshot = JSON.stringify(track)
    const search = normaliseSearchText(Object.values(track.aliases).flat().join(' '))
    const candidates = deriveLxCandidates(track)
    expect(resolveDisplayTitle(track, 'zh-Hant')).toBe('晨曦酒莊')
    expect(resolveDisplayTitle(track, 'zh-Hans')).toBe('晨曦酒庄')
    expect(normaliseSearchText('輕漣')).toBe(normaliseSearchText('轻涟'))
    expect(normaliseSearchText(Object.values(track.aliases).flat().join(' '))).toBe(search)
    expect(deriveLxCandidates(track)).toEqual(candidates)
    expect(JSON.stringify(track)).toBe(snapshot)
  })
})
