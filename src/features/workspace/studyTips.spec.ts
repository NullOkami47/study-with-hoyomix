import { describe, expect, it, vi } from 'vitest'
import { getStudyTip } from './studyTips'

describe('local study tips', () => {
  it('selects stable localised curated messages without network work', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(getStudyTip('en', 0)).toEqual({ id: 'pace', title: 'Start gently', body: 'Choose one small next step, then begin.' })
    expect(getStudyTip('zh-Hant', 0).id).toBe('pace')
    expect(getStudyTip('zh-Hans', 4).id).toBe('reset')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
