import { describe, expect, it } from 'vitest'
import type { Track } from '../../catalog/types'
import { deriveLxCandidates } from './candidates'

function createTrack(sources: Track['sources'], extra: Partial<Track> = {}): Track {
  return {
    id: 'test-track-1',
    title: 'Test Song',
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: ['chill'],
    workGroupId: 'wg-1',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources,
    ...extra,
  }
}

describe('deriveLxCandidates', () => {
  it('returns empty array when track has no sources', () => {
    const track = createTrack([])
    expect(deriveLxCandidates(track)).toEqual([])
  })

  it('maps valid numeric chksz externalId to wy candidate', () => {
    const track = createTrack([
      { provider: 'chksz', externalId: '123456789' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'wy', id: '123456789' },
    ])
  })

  it('ignores non-numeric or invalid chksz bindings', () => {
    const track = createTrack([
      { provider: 'chksz', externalId: 'not-a-number' },
      { provider: 'chksz', externalId: '' },
      { provider: 'chksz', externalId: '123abc456' },
    ])
    expect(deriveLxCandidates(track)).toEqual([])
  })

  it('maps legacy lx-ikun binding and strips quality suffix', () => {
    const track = createTrack([
      { provider: 'lx-ikun', externalId: 'wy:102030:flac' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'wy', id: '102030' },
    ])
  })

  it('maps legacy lx-huibq binding and strips quality suffix', () => {
    const track = createTrack([
      { provider: 'lx-huibq', externalId: 'tx:506070:320k' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'tx', id: '506070' },
    ])
  })

  it('maps legacy lx bindings without quality suffix', () => {
    const track = createTrack([
      { provider: 'lx-ikun', externalId: 'kw:888999' },
      { provider: 'lx-huibq', externalId: 'mg:777666' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'kw', id: '888999' },
      { source: 'mg', id: '777666' },
    ])
  })

  it('prioritizes chksz before legacy lx bindings', () => {
    const track = createTrack([
      { provider: 'lx-ikun', externalId: 'tx:222:320k' },
      { provider: 'chksz', externalId: '111' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'wy', id: '111' },
      { source: 'tx', id: '222' },
    ])
  })

  it('deduplicates identical (source, id) pairs while preserving precedence', () => {
    const track = createTrack([
      { provider: 'chksz', externalId: '123456' },
      { provider: 'lx-ikun', externalId: 'wy:123456:flac' },
      { provider: 'lx-huibq', externalId: 'wy:123456:128k' },
      { provider: 'lx-ikun', externalId: 'tx:999:flac' },
      { provider: 'lx-huibq', externalId: 'tx:999:320k' },
    ])
    expect(deriveLxCandidates(track)).toEqual([
      { source: 'wy', id: '123456' },
      { source: 'tx', id: '999' },
    ])
  })

  it('ignores unrelated providers like jellyfin, youtube, meting, r2', () => {
    const track = createTrack([
      { provider: 'jellyfin', externalId: 'jf-123' },
      { provider: 'youtube', externalId: 'yt-123' },
      { provider: 'meting', externalId: 'meting-123' },
      { provider: 'r2', externalId: 'r2-123' },
    ])
    expect(deriveLxCandidates(track)).toEqual([])
  })

  it('handles malformed externalId gracefully without throwing', () => {
    const track = createTrack([
      { provider: 'lx-ikun', externalId: 'invalid' },
      { provider: 'lx-ikun', externalId: ':only-id' },
      { provider: 'lx-ikun', externalId: 'only-source:' },
    ])
    expect(deriveLxCandidates(track)).toEqual([])
  })
})
