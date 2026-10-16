import { describe, expect, it } from 'vitest'
import { foldHan, HAN_FOLD_PAIR_COUNT } from './hanFold'

describe('catalogue-independent Han search folding', () => {
  it('finds ordinary Traditional/Simplified words without a bundled catalogue', () => {
    expect(foldHan('體驗學習圖書館')).toBe('体验学习图书馆')
    expect(foldHan('委託與記憶')).toBe('委托与记忆')
    expect(HAN_FOLD_PAIR_COUNT).toBeGreaterThan(1000)
  })

  it('keeps search keys idempotent across all BMP code points', () => {
    const text = Array.from({ length: 0x10000 }, (_, index) => String.fromCharCode(index)).join('')
    const folded = foldHan(text)
    expect(foldHan(folded)).toBe(folded)
  })

  it('preserves non-Han text, astral characters and empty input', () => {
    expect(foldHan('Focus 123 🎵𠀀')).toBe('Focus 123 🎵𠀀')
    expect(foldHan('')).toBe('')
  })
})