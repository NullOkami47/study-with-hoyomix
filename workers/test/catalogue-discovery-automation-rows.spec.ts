import { describe, expect, it } from 'vitest'
import { parseSuggestionRows, SUGGESTION_SHEET_HEADERS } from '../catalogue/discovery/automationRows'

const row = () => [
  'abcdefghijk', 'genshin', 'New Album', 'work-new-dawn', 'vocal',
  'TRUE', 'FALSE', 'FALSE', '', '{}', 'Official album listing',
  'https://example.org/official-release', '1', '', 'gemini-spark',
]

describe('untrusted automation classification rows', () => {
  it('rejects every duplicate video row instead of applying whichever agent answered first', async () => {
    const conflicting = row()
    conflicting[5] = 'FALSE'
    conflicting[7] = 'TRUE'
    const result = await parseSuggestionRows([[...SUGGESTION_SHEET_HEADERS], row(), conflicting])
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([
      { videoId: 'abcdefghijk', reason: 'duplicate_row' },
      { videoId: 'abcdefghijk', reason: 'duplicate_row' },
    ])
  })

  it('rejects undeclared trailing values even when the header still matches', async () => {
    const result = await parseSuggestionRows([[...SUGGESTION_SHEET_HEADERS], [...row(), 'netease:untrusted']])
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([{ videoId: 'abcdefghijk', reason: 'unexpected_columns' }])
  })

  it('preserves explicit classification evidence and independent vocal Focus', async () => {
    const result = await parseSuggestionRows([[...SUGGESTION_SHEET_HEADERS], row()])
    expect(result.rejected).toEqual([])
    expect(result.accepted[0].fields.evidence).toEqual(['https://example.org/official-release'])
    expect(result.accepted[0].fields.tabs).toEqual(['focus'])
    expect(result.accepted[0].fields.vocal_status).toBe('vocal')
  })
})
