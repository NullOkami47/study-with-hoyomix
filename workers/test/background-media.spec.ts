import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_IMAGE_MAX_BYTES,
  buildBackgroundObjectKey,
  inspectBackgroundMedia,
} from '../backgrounds/mediaValidation'

const setUint32 = (bytes: Uint8Array, offset: number, value: number) =>
  new DataView(bytes.buffer).setUint32(offset, value)

const png = (width = 1920, height = 1080) => {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  setUint32(bytes, 8, 13)
  bytes.set([73, 72, 68, 82], 12)
  setUint32(bytes, 16, width)
  setUint32(bytes, 20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

const jpeg = (width = 1920, height = 1080) => Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08,
  (height >>> 8) & 0xff, height & 0xff,
  (width >>> 8) & 0xff, width & 0xff,
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
])

const webp = (width = 1920, height = 1080) => {
  const bytes = new Uint8Array(30)
  bytes.set([82, 73, 70, 70], 0)
  new DataView(bytes.buffer).setUint32(4, 22, true)
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8)
  new DataView(bytes.buffer).setUint32(16, 10, true)
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  bytes.set([widthMinusOne & 0xff, (widthMinusOne >>> 8) & 0xff, (widthMinusOne >>> 16) & 0xff], 24)
  bytes.set([heightMinusOne & 0xff, (heightMinusOne >>> 8) & 0xff, (heightMinusOne >>> 16) & 0xff], 27)
  return bytes
}

describe('background media validation', () => {
  it.each([
    ['image/png', png(), 'png'],
    ['image/jpeg', jpeg(), 'jpg'],
    ['image/webp', webp(), 'webp'],
  ] as const)('derives trusted %s metadata from bytes', (contentType, bytes, extension) => {
    expect(inspectBackgroundMedia(bytes, contentType)).toEqual({
      ok: true,
      media: {
        kind: 'image',
        contentType,
        extension,
        bytes: bytes.byteLength,
        width: 1920,
        height: 1080,
        durationMs: null,
      },
    })
  })

  it('rejects a declared type that disagrees with the byte signature', () => {
    expect(inspectBackgroundMedia(png(), 'image/jpeg')).toEqual({ ok: false, error: 'media_type_mismatch' })
  })

  it('rejects malformed dimensions and the exact upper dimension boundary', () => {
    expect(inspectBackgroundMedia(png(0, 1080), 'image/png')).toEqual({ ok: false, error: 'invalid_media' })
    expect(inspectBackgroundMedia(png(7680, 4320), 'image/png').ok).toBe(true)
    expect(inspectBackgroundMedia(png(7681, 4320), 'image/png')).toEqual({ ok: false, error: 'invalid_dimensions' })
  })

  it('rejects an image body larger than 12 MiB', () => {
    const oversized = new Uint8Array(BACKGROUND_IMAGE_MAX_BYTES + 1)
    oversized.set(png())
    expect(inspectBackgroundMedia(oversized, 'image/png')).toEqual({ ok: false, error: 'media_too_large' })
  })

  it.each(['video/mp4', 'video/webm'])('fails closed when %s cannot be credibly inspected server-side', (contentType) => {
    expect(inspectBackgroundMedia(new Uint8Array([0, 1, 2, 3]), contentType)).toEqual({
      ok: false,
      error: 'video_validation_unavailable',
    })
  })

  it('rejects unsupported media families', () => {
    expect(inspectBackgroundMedia(new Uint8Array([1]), 'image/gif')).toEqual({ ok: false, error: 'unsupported_media_type' })
  })
})

describe('background object key isolation', () => {
  const backgroundId = '11111111-1111-4111-8111-111111111111'
  const revisionId = '22222222-2222-4222-8222-222222222222'

  it('constructs a dedicated key from server IDs and a reviewed extension', () => {
    expect(buildBackgroundObjectKey(backgroundId, revisionId, 'jpg')).toBe(
      'backgrounds/11111111-1111-4111-8111-111111111111/revisions/22222222-2222-4222-8222-222222222222.jpg',
    )
    expect(buildBackgroundObjectKey(backgroundId, revisionId, 'png', true)).toBe(
      'backgrounds/11111111-1111-4111-8111-111111111111/posters/22222222-2222-4222-8222-222222222222.png',
    )
  })

  it.each([
    ['../tracks/authorized/hash.mp3', revisionId, 'jpg'],
    [backgroundId, '../escape', 'jpg'],
    [backgroundId, revisionId, 'mp3'],
  ])('rejects traversal or a non-background extension', (id, revision, extension) => {
    expect(() => buildBackgroundObjectKey(id, revision, extension)).toThrow('invalid_background_object_key')
  })
})
