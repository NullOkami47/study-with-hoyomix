import { describe, it, expect } from 'vitest'
import {
  buildNeteaseSearchUrl,
  isOfficialNeteaseArtistId,
  NETEASE_HOYOMIX_ARTIST_ID,
  NETEASE_SANZ_STUDIO_ARTIST_ID,
  parseNeteaseSearch,
} from './neteaseSearch'
describe('NetEase public metadata search', () => {
  it('pins destination and accepts verified HOYO-MiX or 三Z-STUDIO performer credits only', () => {
    expect(isOfficialNeteaseArtistId(NETEASE_HOYOMIX_ARTIST_ID)).toBe(true)
    expect(isOfficialNeteaseArtistId(NETEASE_SANZ_STUDIO_ARTIST_ID)).toBe(true)
    expect(isOfficialNeteaseArtistId(127084424)).toBe(false)
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
    const sanzSolo = {
      id: 2681512929,
      name: 'ZZZ Solo Track',
      artists: [{ id: 94007859, name: '三Z-STUDIO' }],
      album: { name: 'ZZZ Album' },
      duration: 165000,
    }
    expect(
      parseNeteaseSearch({ code: 200, result: { songs: [sanzSolo] } }),
    ).toEqual([
      {
        id: '2681512929',
        name: 'ZZZ Solo Track',
        artists: '三Z-STUDIO',
        album: 'ZZZ Album',
        durationMs: 165000,
      },
    ])
    const sanzJoint = {
      ...sanzSolo,
      id: 2681512930,
      artists: [
        { id: 94007859, name: '三Z-STUDIO' },
        { id: 12487174, name: 'HOYO-MiX' },
      ],
    }
    expect(
      parseNeteaseSearch({ code: 200, result: { songs: [sanzJoint] } }),
    ).toHaveLength(1)
    expect(
      parseNeteaseSearch({
        code: 200,
        result: {
          songs: [
            { ...song, artists: [{ id: 1, name: 'HOYO-MiX' }] },
            { ...song, id: 3454931275, artists: [{ id: 127084424, name: 'Sān-Z' }] },
          ],
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
