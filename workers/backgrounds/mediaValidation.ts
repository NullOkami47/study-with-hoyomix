export const BACKGROUND_IMAGE_MAX_BYTES = 12 * 1024 * 1024
export const BACKGROUND_VIDEO_MAX_BYTES = 25 * 1024 * 1024
export const BACKGROUND_MAX_WIDTH = 7680
export const BACKGROUND_MAX_HEIGHT = 4320

export type BackgroundMediaValidationError =
  | 'invalid_dimensions'
  | 'invalid_media'
  | 'media_too_large'
  | 'media_type_mismatch'
  | 'unsupported_media_type'
  | 'video_validation_unavailable'

export interface InspectedBackgroundMedia {
  kind: 'image' | 'video'
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/webm'
  extension: 'jpg' | 'png' | 'webp' | 'mp4' | 'webm'
  bytes: number
  width: number
  height: number
  durationMs: number | null
  fps?: number
}

export type BackgroundMediaInspection =
  | { ok: true; media: InspectedBackgroundMedia }
  | { ok: false; error: BackgroundMediaValidationError }

interface ImageDimensions {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  extension: 'jpg' | 'png' | 'webp'
  width: number
  height: number
}

const ascii = (bytes: Uint8Array, offset: number, value: string) => {
  if (offset + value.length > bytes.byteLength) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

const uint16 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)

const uint24le = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)

const uint32 = (bytes: Uint8Array, offset: number, littleEndian = false) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian)

const inspectPng = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.byteLength < 29 || !ascii(bytes, 0, '\u0089PNG\r\n\u001a\n')) return null
  if (uint32(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null
  return {
    contentType: 'image/png',
    extension: 'png',
    width: uint32(bytes, 16),
    height: uint32(bytes, 20),
  }
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

const inspectJpeg = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 1 >= bytes.byteLength) return null
    const segmentLength = uint16(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) return null
      return {
        contentType: 'image/jpeg',
        extension: 'jpg',
        height: uint16(bytes, offset + 3),
        width: uint16(bytes, offset + 5),
      }
    }
    offset += segmentLength
  }
  return null
}

const inspectWebp = (bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.byteLength < 25 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null
  let width = 0
  let height = 0
  if (ascii(bytes, 12, 'VP8X') && bytes.byteLength >= 30) {
    width = uint24le(bytes, 24) + 1
    height = uint24le(bytes, 27) + 1
  } else if (ascii(bytes, 12, 'VP8L') && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    width = 1 + (bytes[21] ?? 0) + (((bytes[22] ?? 0) & 0x3f) << 8)
    height = 1 + ((bytes[22] ?? 0) >>> 6) + ((bytes[23] ?? 0) << 2) + (((bytes[24] ?? 0) & 0x0f) << 10)
  } else if (
    ascii(bytes, 12, 'VP8 ') && bytes.byteLength >= 30 &&
    bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
  ) {
    width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff
    height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff
  } else {
    return null
  }
  return { contentType: 'image/webp', extension: 'webp', width, height }
}

const inspectImage = (bytes: Uint8Array) => inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes)

export function inspectBackgroundMedia(bytes: Uint8Array, declaredContentType: string): BackgroundMediaInspection {
  const contentType = declaredContentType.trim().toLowerCase()
  if (contentType === 'video/mp4' || contentType === 'video/webm') {
    if (bytes.byteLength > BACKGROUND_VIDEO_MAX_BYTES) return { ok: false, error: 'media_too_large' }
    return { ok: false, error: 'video_validation_unavailable' }
  }
  if (contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') {
    return { ok: false, error: 'unsupported_media_type' }
  }
  if (bytes.byteLength > BACKGROUND_IMAGE_MAX_BYTES) return { ok: false, error: 'media_too_large' }
  const image = inspectImage(bytes)
  if (!image) return { ok: false, error: 'invalid_media' }
  if (image.contentType !== contentType) return { ok: false, error: 'media_type_mismatch' }
  if (image.width < 1 || image.height < 1) return { ok: false, error: 'invalid_media' }
  if (image.width > BACKGROUND_MAX_WIDTH || image.height > BACKGROUND_MAX_HEIGHT) {
    return { ok: false, error: 'invalid_dimensions' }
  }
  return {
    ok: true,
    media: {
      kind: 'image',
      contentType,
      extension: image.extension,
      bytes: bytes.byteLength,
      width: image.width,
      height: image.height,
      durationMs: null,
    },
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MEDIA_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'mp4', 'webm'])
const POSTER_EXTENSIONS = new Set(['jpg', 'png', 'webp'])

export function buildBackgroundObjectKey(
  backgroundId: string,
  revisionId: string,
  extension: string,
  poster = false,
): string {
  const extensions = poster ? POSTER_EXTENSIONS : MEDIA_EXTENSIONS
  if (!UUID_V4.test(backgroundId) || !UUID_V4.test(revisionId) || !extensions.has(extension)) {
    throw new Error('invalid_background_object_key')
  }
  const directory = poster ? 'posters' : 'revisions'
  return `backgrounds/${backgroundId}/${directory}/${revisionId}.${extension}`
}

export function isControlledBackgroundObjectKey(backgroundId: string, key: string): boolean {
  if (!UUID_V4.test(backgroundId)) return false
  return key.startsWith(`backgrounds/${backgroundId}/`) && !key.includes('..') && !key.includes('tracks/authorized/')
}
