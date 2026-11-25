import { crc32, deflateSync } from 'node:zlib'
// Complete, controlled PNGs: the browser suite also decodes these formats natively.
export function png(seed = 1, width = 16, height = 16, padTo = 0): Uint8Array {
  const chunk = (name: string, bytes: Buffer) => { const tag = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc32(bytes, crc32(tag))); return Buffer.concat([size, tag, bytes, sum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const n = y * (width * 4 + 1) + x * 4 + 1; pixels[n] = seed; pixels[n + 3] = 255 }
  const parts = [Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels))]
  const current = parts.reduce((n, b) => n + b.length, 0) + 12
  if (padTo > current + 16) {
    const text = Buffer.alloc(padTo - current - 12, 65)
    text[4] = 0 // PNG tEXt keyword separator, followed by valid Latin-1 text.
    parts.push(chunk('tEXt', text))
  }
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(parts))
}
