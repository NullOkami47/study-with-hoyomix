import { describe, expect, it } from 'vitest'

import { normaliseSearchText } from './searchText'

describe('normaliseSearchText', () => {
  it('is case-insensitive', () => {
    expect(normaliseSearchText('Fontaine Daydream')).toBe(normaliseSearchText('fontaine daydream'))
    expect(normaliseSearchText('INSIDE - EP')).toBe(normaliseSearchText('inside - ep'))
  })

  it('squashes whitespace, so spacing differences cannot cause a miss', () => {
    expect(normaliseSearchText('  la   vaguelette ')).toBe(normaliseSearchText('La Vaguelette'))
    expect(normaliseSearchText('Hope Is the Thing With Feathers')).toBe('hopeisthethingwithfeathers')
  })

  it('tolerates punctuation differences', () => {
    const expected = normaliseSearchText('moon in ones cup')
    expect(normaliseSearchText("Moon in One's Cup")).toBe(expected)
    expect(normaliseSearchText('moon-in-ones-cup')).toBe(expected)
    expect(normaliseSearchText('Moon.in.One.s.Cup')).toBe(expected)
    expect(normaliseSearchText('Honkai: Star Rail')).toBe(normaliseSearchText('Honkai Star Rail'))
  })

  it('strips diacritics, so an unaccented query still matches', () => {
    expect(normaliseSearchText('Café')).toBe(normaliseSearchText('cafe'))
    expect(normaliseSearchText('Sinnoh')).toBe(normaliseSearchText('Sinnöh'))
  })

  it('applies compatibility decomposition, so full-width text matches', () => {
    expect(normaliseSearchText('ＨＳＲ')).toBe(normaliseSearchText('hsr'))
    expect(normaliseSearchText('Ｂｅｌｌｅａｕ')).toBe(normaliseSearchText('Belleau'))
  })

  it('folds Han script variants so Traditional and Simplified agree', () => {
    expect(normaliseSearchText('輕漣')).toBe(normaliseSearchText('轻涟'))
    expect(normaliseSearchText('絕區零')).toBe(normaliseSearchText('绝区零'))
    expect(normaliseSearchText('極限委託')).toBe(normaliseSearchText('极限委托'))
  })

  it('leaves Han text that has no variant untouched', () => {
    expect(normaliseSearchText('原神')).toBe('原神')
  })

  it('returns an empty string when nothing searchable remains', () => {
    expect(normaliseSearchText('')).toBe('')
    expect(normaliseSearchText('   ')).toBe('')
    expect(normaliseSearchText('!!!')).toBe('')
    expect(normaliseSearchText('— ... —')).toBe('')
  })

  it('is idempotent', () => {
    for (const value of ['Fontaine Daydream', '輕漣', "Moon in One's Cup", '極限委託', 'Café']) {
      const once = normaliseSearchText(value)
      expect(normaliseSearchText(once)).toBe(once)
    }
  })
})
