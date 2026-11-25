/** Inspect dimensions before allocating a browser decoder. Decoding still validates the file. */
export function artworkDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size))
  const u16 = (offset: number, little = false) => view.getUint16(offset, little)
  const u32 = (offset: number, little = false) => view.getUint32(offset, little)
  const result = (width: number, height: number) => width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 1024 * 1024
    ? { width, height } : null
  try {
    if (mime === 'image/png') {
      if (bytes.length < 45 || ![137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v) || u32(8) !== 13 || text(12, 4) !== 'IHDR') return null
      const dimensions = result(u32(16), u32(20))
      if (!dimensions) return null
      let offset = 8, data = false
      while (offset + 12 <= bytes.length) {
        const length = u32(offset), kind = text(offset + 4, 4)
        if (length > bytes.length - offset - 12 || kind === 'acTL' || kind === 'IHDR' && offset !== 8) return null
        if (kind === 'IDAT') data = true
        offset += length + 12
        if (kind === 'IEND') return data && length === 0 && offset === bytes.length ? dimensions : null
      }
      return null
    }
    if (mime === 'image/jpeg') {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null
      let offset = 2, scanned = false
      let dimensions: { width: number; height: number } | null = null
      while (offset + 2 <= bytes.length) {
        if (bytes[offset++] !== 0xff) return null
        while (bytes[offset] === 0xff) offset++
        const marker = bytes[offset++]!
        if (marker === 0xdc) return null // DNL may redefine dimensions after the frame header.
        if (marker === 0xd9) return scanned && offset === bytes.length ? dimensions : null
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
        const length = u16(offset)
        if (length < 2 || offset + length > bytes.length) return null
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          if (dimensions || length < 8) return null
          dimensions = result(u16(offset + 5), u16(offset + 3))
          if (!dimensions) return null
        }
        offset += length
        if (marker === 0xda) {
          if (!dimensions) return null
          scanned = true
          // Skip entropy data, preserving real markers between progressive scans.
          while (offset < bytes.length) {
            if (bytes[offset] !== 0xff) { offset++; continue }
            const start = offset++
            while (bytes[offset] === 0xff) offset++
            const next = bytes[offset]
            if (next === 0 || next !== undefined && next >= 0xd0 && next <= 0xd7) { offset++; continue }
            offset = start
            break
          }
        }
      }
      return null
    }
    if (mime === 'image/gif') {
      if (bytes.length < 14 || !['GIF87a','GIF89a'].includes(text(0, 6))) return null
      const dimensions = result(u16(6, true), u16(8, true))
      if (!dimensions) return null
      let offset = 13 + (bytes[10]! & 0x80 ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0), frames = 0
      const blocks = () => { for (;;) { if (offset >= bytes.length) return false; const count = bytes[offset++]!; if (!count) return true; offset += count; if (offset > bytes.length) return false } }
      while (offset < bytes.length) {
        const kind = bytes[offset++]!
        if (kind === 0x3b) return frames === 1 && offset === bytes.length ? dimensions : null
        if (kind === 0x21) { offset++; if (!blocks()) return null; continue }
        if (kind !== 0x2c || ++frames > 1 || offset + 9 > bytes.length) return null
        const left = u16(offset, true), top = u16(offset + 2, true), width = u16(offset + 4, true), height = u16(offset + 6, true)
        if (!width || !height || left + width > dimensions.width || top + height > dimensions.height) return null
        const packed = bytes[offset + 8]!
        offset += 9 + (packed & 0x80 ? 3 * (2 ** ((packed & 7) + 1)) : 0)
        offset++ // LZW minimum code size; the native decoder validates the stream.
        if (!blocks()) return null
      }
      return null
    }
    if (mime === 'image/webp') {
      if (bytes.length < 30 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP' || u32(4, true) + 8 !== bytes.length) return null
      let offset = 12, dimensions: { width: number; height: number } | null = null, image = false
      while (offset + 8 <= bytes.length) {
        const kind = text(offset, 4), length = u32(offset + 4, true), start = offset + 8
        if (length > bytes.length - start || kind === 'ANIM' || kind === 'ANMF') return null
        if (kind === 'VP8X') {
          if (offset !== 12 || length !== 10 || bytes[start]! & 2) return null
          dimensions = result(1 + bytes[start + 4]! + (bytes[start + 5]! << 8) + (bytes[start + 6]! << 16), 1 + bytes[start + 7]! + (bytes[start + 8]! << 8) + (bytes[start + 9]! << 16))
          if (!dimensions) return null
        } else if (kind === 'VP8 ' || kind === 'VP8L') {
          if (image) return null
          image = true
          let encoded: { width: number; height: number } | null
          if (kind === 'VP8 ') {
            if (length < 10 || bytes[start]! & 1 || text(start + 3, 3) !== '\x9d\x01\x2a') return null
            encoded = result(u16(start + 6, true) & 0x3fff, u16(start + 8, true) & 0x3fff)
          } else {
            if (length < 5 || bytes[start] !== 0x2f) return null
            const bits = u32(start + 1, true)
            encoded = result((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
          }
          if (!encoded || dimensions && (encoded.width !== dimensions.width || encoded.height !== dimensions.height)) return null
          dimensions = encoded
        }
        offset = start + length + (length & 1)
      }
      return offset === bytes.length && image ? dimensions : null
    }
  } catch { /* Truncated structures fail closed before reaching a decoder. */ }
  return null
}
