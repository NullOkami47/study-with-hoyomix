// Original implementation for Study with HOYO-MiX (GPL-3.0). Convex-bezel displacement tiles for
// backdrop-filter refraction; not derived from liquid-glass-studio source.
//
// The cinematic hero surfaces (player bar, focus bar) assemble their displacement map inside an SVG
// filter from these static, same-origin 9-slice tiles, so the map works under the production CSP
// (`img-src 'self'`). Tiles depend only on the corner radius R and the bezel width b, never on the
// box size. Every tile is rendered at 2x density.
//
//   node scripts/generate-glass-refraction-tiles.mjs --write   # (re)write public/glass/refraction/*.png
//   node scripts/generate-glass-refraction-tiles.mjs --check   # exit 1 when a committed tile differs
import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DENSITY = 2
export const CORNER_SETS = Object.freeze([
  // Focus pill (52 px tall): a 16 px bezel leaves the 20 px text band in the middle unbent.
  Object.freeze({ radius: 26, bezel: 16 }),
  Object.freeze({ radius: 24, bezel: 16 }),
  // Player, wide (84 px collapsed): 22 px. Player, compact (76 px collapsed): 20 px.
  Object.freeze({ radius: 42, bezel: 22 }),
  Object.freeze({ radius: 40, bezel: 22 }),
  Object.freeze({ radius: 38, bezel: 20 }),
  Object.freeze({ radius: 40, bezel: 20 }),
])
export const EDGE_BEZELS = Object.freeze([16, 20, 22])
export const CORNERS = Object.freeze(['tl', 'tr', 'bl', 'br'])
export const SIDES = Object.freeze(['t', 'b', 'l', 'r'])

/** Every tile file, in a fixed order. */
export const TILE_SETS = Object.freeze([
  ...CORNER_SETS.flatMap(({ radius, bezel }) => CORNERS.map((corner) => Object.freeze({
    name: `c-r${radius}-b${bezel}-${corner}.png`,
    kind: 'corner',
    radius,
    bezel,
    corner,
  }))),
  ...EDGE_BEZELS.flatMap((bezel) => SIDES.map((side) => Object.freeze({
    name: `e-b${bezel}-${side}.png`,
    kind: 'edge',
    bezel,
    side,
  }))),
])

/** Rounds half away from zero, so mirrored tiles are exact mirrors. */
function roundSymmetric(value) {
  return Math.sign(value) * Math.round(Math.abs(value))
}

function encodeVector(distance, bezel, nx, ny) {
  if (!(distance >= 0)) return [128, 128]
  const t = Math.min(Math.max(distance / bezel, 0), 1)
  if (t >= 1) return [128, 128]
  // Smooth convex bezel: smoothstep of the distance from the inner edge of the band. Zero slope where
  // the band meets the flat centre (no visible step) and a flat plateau at the rim, like a lens edge.
  const u = 1 - t
  const m = u * u * (3 - 2 * u)
  return [128 + roundSymmetric(127 * m * nx), 128 + roundSymmetric(127 * m * ny)]
}

/**
 * A corner tile: 2R x 2R pixels covering the R x R corner square. Pixels inside the arc are displaced
 * along the inward normal (towards the arc centre), i.e. "sample inward": content near the rim is
 * pulled in from the interior, so it reads as magnified and curved.
 */
export function buildCornerTile({ radius, bezel, corner, density = DENSITY }) {
  const size = radius * density
  const rgba = new Uint8Array(size * size * 4)
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'bl' || corner === 'br'
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      // Local position in CSS px, measured as if this were the top-left corner.
      const lx = (right ? size - column - 0.5 : column + 0.5) / density
      const ly = (bottom ? size - row - 0.5 : row + 0.5) / density
      const dx = radius - lx
      const dy = radius - ly
      const length = Math.hypot(dx, dy)
      let nx = length > 0 ? dx / length : 0
      let ny = length > 0 ? dy / length : 0
      if (right) nx = -nx
      if (bottom) ny = -ny
      const [r, g] = encodeVector(radius - length, bezel, nx, ny)
      const offset = (row * size + column) * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = 128
      rgba[offset + 3] = 255
    }
  }
  return { width: size, height: size, rgba }
}

/** An edge tile: 1 x 2b pixels (top/bottom) or 2b x 1 pixels (left/right), stretched along the edge. */
export function buildEdgeTile({ bezel, side, density = DENSITY }) {
  const depth = bezel * density
  const vertical = side === 't' || side === 'b'
  const width = vertical ? 1 : depth
  const height = vertical ? depth : 1
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < depth; index += 1) {
    const fromStart = (index + 0.5) / density
    const fromEnd = (depth - index - 0.5) / density
    let distance = fromStart
    let nx = 0
    let ny = 0
    if (side === 't') ny = 1
    else if (side === 'b') { distance = fromEnd; ny = -1 }
    else if (side === 'l') nx = 1
    else { distance = fromEnd; nx = -1 }
    const [r, g] = encodeVector(distance, bezel, nx, ny)
    const offset = index * 4
    rgba[offset] = r
    rgba[offset + 1] = g
    rgba[offset + 2] = 128
    rgba[offset + 3] = 255
  }
  return { width, height, rgba }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Filters one scanline with PNG filter type `type` (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). */
function filterRow(type, current, previous) {
  const out = Buffer.alloc(current.length)
  for (let index = 0; index < current.length; index += 1) {
    const left = index >= 4 ? current[index - 4] : 0
    const up = previous ? previous[index] : 0
    const upLeft = previous && index >= 4 ? previous[index - 4] : 0
    let predictor = 0
    if (type === 1) predictor = left
    else if (type === 2) predictor = up
    else if (type === 3) predictor = (left + up) >> 1
    else if (type === 4) predictor = paeth(left, up, upLeft)
    out[index] = (current[index] - predictor) & 0xff
  }
  return out
}

/**
 * Encodes RGBA pixels as a deterministic PNG: colour type 6, 8 bit, compression and filter method 0.
 * All scanlines of one image share one filter type: the type (0-4) whose deflated stream is smallest,
 * ties going to the lower type. That keeps every tile under 2 KB, and because the choice is a pure
 * function of the pixels and zlib settings, the output is reproducible byte for byte.
 */
export function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const stride = width * 4
  let data = null
  for (let type = 0; type <= 4; type += 1) {
    const raw = Buffer.alloc((stride + 1) * height)
    let previous = null
    for (let row = 0; row < height; row += 1) {
      const current = Buffer.from(rgba.buffer, rgba.byteOffset + row * stride, stride)
      raw[row * (stride + 1)] = type
      filterRow(type, current, previous).copy(raw, row * (stride + 1) + 1)
      previous = current
    }
    const deflated = deflateSync(raw, { level: 9, memLevel: 9 })
    if (data === null || deflated.length < data.length) data = deflated
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function buildTile(entry) {
  return entry.kind === 'corner'
    ? buildCornerTile({ radius: entry.radius, bezel: entry.bezel, corner: entry.corner })
    : buildEdgeTile({ bezel: entry.bezel, side: entry.side })
}

/** Every tile as `{ name, png }`. */
export function generateTiles() {
  return TILE_SETS.map((entry) => {
    const { width, height, rgba } = buildTile(entry)
    return { name: entry.name, png: encodePng(rgba, width, height) }
  })
}

export const TILE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'glass', 'refraction')

function main(argv) {
  const write = argv.includes('--write')
  const check = argv.includes('--check')
  if (write === check) {
    console.error('usage: generate-glass-refraction-tiles.mjs --write | --check')
    return 2
  }
  const tiles = generateTiles()
  if (write) {
    mkdirSync(TILE_DIRECTORY, { recursive: true })
    for (const { name, png } of tiles) writeFileSync(join(TILE_DIRECTORY, name), png)
    console.log(`wrote ${tiles.length} tiles to ${TILE_DIRECTORY}`)
    return 0
  }
  const different = tiles.filter(({ name, png }) => {
    const path = join(TILE_DIRECTORY, name)
    return !existsSync(path) || !readFileSync(path).equals(png)
  })
  if (different.length) {
    console.error(`refraction tiles differ from the generator: ${different.map(({ name }) => name).join(', ')}`)
    return 1
  }
  console.log(`all ${tiles.length} refraction tiles match the generator`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = main(process.argv.slice(2))
}
