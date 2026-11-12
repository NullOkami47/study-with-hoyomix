import { describe, it, expect } from 'vitest'
import { buildNeteaseSearchUrl, parseNeteaseSearch } from './neteaseSearch'
describe('NetEase public metadata search', () => {
  it('pins destination and only accepts verified HOYO-MiX performer credits', () => {
    const u = buildNeteaseSearchUrl('New Dawn')
    expect(u.origin).toBe('https://music.163.com')
    expect(u.pathname).toBe('/api/search/get')
    const song = {
      id: 9876543210,
      name: 'New Dawn',
      artists: [{ id: 12487174, name: 'HOYO-MiX' }],
      album: { name: 'New Album' },
      duration: 180000,
    }
    expect(
      parseNeteaseSearch({ code: 200, result: { songs: [song] } }),
    ).toEqual([
      {
        id: '9876543210',
        name: 'New Dawn',
        artists: 'HOYO-MiX',
        album: 'New Album',
        durationMs: 180000,
      },
    ])
    expect(
      parseNeteaseSearch({
        code: 200,
        result: {
          songs: [{ ...song, artists: [{ id: 1, name: 'HOYO-MiX' }] }],
        },
      }),
    ).toEqual([])
  })
  it('distinguishes empty search from failure and never emits media URLs', () => {
    expect(parseNeteaseSearch({ code: 200, result: { songCount: 0 } })).toEqual(
      [],
    )
    expect(parseNeteaseSearch({ code: 429 })).toBeNull()
    expect(
      parseNeteaseSearch({
        code: 200,
        result: {
          songs: [{ id: 'unsafe', name: 'x', url: 'https://secret.example' }],
        },
      }),
    ).toEqual([])
  })
})
