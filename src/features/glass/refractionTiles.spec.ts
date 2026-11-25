import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCornerTile,
  buildEdgeTile,
  crc32,
  generateTiles,
  TILE_DIRECTORY,
  TILE_SETS,
} from '../../../scripts/generate-glass-refraction-tiles.mjs'
import { matchTileSet, REFRACTION_TILE_SETS, tileUrls } from './refractionTiles'

type Tile = { width: number; height: number; rgba: Uint8Array }

function pixel(tile: Tile, x: number, y: number): [number, number, number, number] {
  const offset = (y * tile.width + x) * 4
  return [tile.rgba[offset], tile.rgba[offset + 1], tile.rgba[offset + 2], tile.rgba[offset + 3]]
}

describe('refraction tile generator', () => {
  it('writes 36 tiles: six corner sets and three edge sets', () => {
    expect(TILE_SETS).toHaveLength(36)
    expect(TILE_SETS.filter((entry: { kind: string }) => entry.kind === 'corner')).toHaveLength(24)
    expect(TILE_SETS.filter((entry: { kind: string }) => entry.kind === 'edge')).toHaveLength(12)
  })

  it('keeps the interior side of every tile neutral', () => {
    const corner: Tile = buildCornerTile({ radius: 26, bezel: 16, corner: 'tl' })
    expect(pixel(corner, corner.width - 1, corner.height - 1)).toEqual([128, 128, 128, 255])
    const edge: Tile = buildEdgeTile({ bezel: 16, side: 'l' })
    expect(pixel(edge, edge.width - 1, 0)).toEqual([128, 128, 128, 255])
  })

  it('pushes the left edge inward along x only at the rim', () => {
    const edge: Tile = buildEdgeTile({ bezel: 22, side: 'l' })
    const [r, g] = pixel(edge, 0, 0)
    expect(r).toBeGreaterThan(128)
    expect(g).toBe(128)
    const right: Tile = buildEdgeTile({ bezel: 22, side: 'r' })
    expect(pixel(right, right.width - 1, 0)[0]).toBe(256 - r)
    const top: Tile = buildEdgeTile({ bezel: 22, side: 't' })
    expect(pixel(top, 0, 0).slice(0, 2)).toEqual([128, r])
  })

  it('is diagonally symmetric in the top-left corner and mirrored in the top-right corner', () => {
    const tl: Tile = buildCornerTile({ radius: 40, bezel: 22, corner: 'tl' })
    const tr: Tile = buildCornerTile({ radius: 40, bezel: 22, corner: 'tr' })
    for (let index = 0; index < tl.width; index += 7) {
      const [r, g] = pixel(tl, index, index)
      expect(r).toBe(g)
    }
    for (let y = 0; y < tl.height; y += 5) {
      for (let x = 0; x < tl.width; x += 5) {
        const left = pixel(tl, x, y)
        const right = pixel(tr, tl.width - 1 - x, y)
        expect(right[0]).toBe(256 - left[0])
        expect(right[1]).toBe(left[1])
      }
    }
  })

  it('leaves pixels outside the shape and past the bezel neutral', () => {
    const tl: Tile = buildCornerTile({ radius: 42, bezel: 22, corner: 'tl' })
    expect(pixel(tl, 0, 0)).toEqual([128, 128, 128, 255])
    // A rim pixel just inside the arc on the diagonal is displaced towards the centre.
    const inside = Math.round(42 * 2 * (1 - Math.SQRT1_2)) + 2
    const [r, g] = pixel(tl, inside, inside)
    expect(r).toBeGreaterThan(128)
    expect(g).toBeGreaterThan(128)
    const edge: Tile = buildEdgeTile({ bezel: 22, side: 't' })
    expect(pixel(edge, 0, edge.height - 1)[1]).toBeLessThan(pixel(edge, 0, 0)[1])
  })

  it('writes valid PNGs that equal the committed tiles byte for byte', () => {
    const generated = generateTiles() as { name: string; png: Uint8Array }[]
    const committed = readdirSync(TILE_DIRECTORY).filter((name) => name.endsWith('.png')).sort()
    expect(committed).toEqual(generated.map(({ name }) => name).sort())
    for (const { name, png } of generated) {
      const bytes = readFileSync(join(TILE_DIRECTORY, name))
      expect(Buffer.from(png).equals(bytes), name).toBe(true)
      // The 22 px player corners are ~2.5 KB; every tile stays well under 3 KB.
      expect(bytes.length, name).toBeLessThan(3072)
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      let offset = 8
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset)
        const typed = bytes.subarray(offset + 4, offset + 8 + length)
        expect(crc32(typed), `${name} chunk CRC`).toBe(bytes.readUInt32BE(offset + 8 + length))
        offset += 12 + length
      }
      expect(offset).toBe(bytes.length)
    }
  })
})

describe('refraction tile set matching', () => {
  it('resolves the BEFORE manifest sizes', () => {
    expect(matchTileSet('focus', 'wide', 544, 52, 999)?.radius).toBe(26)
    expect(matchTileSet('focus', 'compact', 285, 52, 999)?.radius).toBe(26)
    expect(matchTileSet('player', 'wide', 480, 84, 999)?.radius).toBe(42)
    expect(matchTileSet('player', 'wide', 480, 315, 40)?.radius).toBe(40)
    expect(matchTileSet('player', 'compact', 358, 76, 999)).toMatchObject({ radius: 38, bezel: 20, scale: 56 })
    expect(matchTileSet('player', 'compact', 328, 76, 999)).toMatchObject({ radius: 38, bezel: 20 })
    expect(matchTileSet('player', 'compact', 358, 315, 40)).toMatchObject({ radius: 40, bezel: 20 })
    expect(matchTileSet('player', 'compact', 328, 315, 40)).toMatchObject({ radius: 40, bezel: 20 })
    expect(matchTileSet('focus', 'wide', 240, 80, 24)?.radius).toBe(24)
  })

  it('clamps a pill radius to half the height', () => {
    expect(matchTileSet('player', 'wide', 480, 84, 999)).toMatchObject({ radius: 42, scale: 56 })
  })

  it('rejects a 2 px radius mismatch, the wrong hero or profile, and out-of-range sizes', () => {
    expect(matchTileSet('player', 'wide', 480, 315, 37)).toBeNull()
    expect(matchTileSet('focus', 'wide', 480, 84, 999)).toBeNull()
    expect(matchTileSet('player', 'compact', 480, 84, 999)).toBeNull()
    expect(matchTileSet('player', 'wide', 20, 84, 40)).toBeNull()
    expect(matchTileSet('player', 'wide', 5000, 84, 40)).toBeNull()
    expect(matchTileSet('player', 'wide', Number.NaN, 84, 40)).toBeNull()
  })

  it('matches the CSS radius tokens: 2.5rem shell and the pill heights', () => {
    const rem = 16
    expect(REFRACTION_TILE_SETS.filter((entry) => entry.hero === 'player' && entry.radius === 2.5 * rem)).toHaveLength(2)
    expect(REFRACTION_TILE_SETS.some((entry) => entry.hero === 'focus' && entry.radius === 1.5 * rem)).toBe(true)
    expect(REFRACTION_TILE_SETS.some((entry) => entry.hero === 'focus' && entry.radius === 52 / 2)).toBe(true)
  })

  it('names every tile of a set with a committed file', () => {
    const names = new Set(TILE_SETS.map((entry: { name: string }) => entry.name))
    for (const entry of REFRACTION_TILE_SETS) {
      for (const url of Object.values(tileUrls(entry))) {
        expect(url.startsWith('/glass/refraction/')).toBe(true)
        expect(names.has(url.slice('/glass/refraction/'.length)), url).toBe(true)
      }
    }
  })
})
