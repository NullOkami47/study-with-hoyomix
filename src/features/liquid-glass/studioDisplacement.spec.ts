import { describe, expect, it } from 'vitest'
import { buildStudioTiles, studioMapGeometry } from './studioDisplacement'

describe('Studio same-origin dynamic nine-slice map', () => {
  it('clamps capsule radii without a centre-line artefact and rejects invalid bounds', () => {
    expect(studioMapGeometry(600, 52, 999)).toMatchObject({ radius: 26, width: 600 })
    for (const args of [[10000,52,20],[NaN,52,20],[0,52,20]]) expect(studioMapGeometry(...args as [number,number,number])).toBeNull()
  })
  it('covers arbitrary dialog radii without fetching or generating a new asset', () => {
    for (const r of [0,8,18,26,32,48,64]) {
      const map = buildStudioTiles(640, 420, r)!
      expect(map.tiles.length).toBeLessThanOrEqual(8)
      for (const tile of map.tiles) {
        expect(tile.href).toMatch(/^\/glass\/refraction\/[ce]-[a-z0-9-]+\.png$/)
        expect(tile.x).toBeGreaterThanOrEqual(0)
        expect(tile.y).toBeGreaterThanOrEqual(0)
        expect(tile.x+tile.width).toBeLessThanOrEqual(640)
        expect(tile.y+tile.height).toBeLessThanOrEqual(420)
      }
      expect(map.tiles.some(t => t.x <= 320 && t.x+t.width >=320 && t.y<=210 && t.y+t.height>=210)).toBe(false)
    }
  })
  it('uses only six tiles for a pill and eight for a dialog, leaving centre neutral', () => {
    const pill = buildStudioTiles(400,52,999)!
    expect(pill.tiles).toHaveLength(6)
    expect(pill.tiles.map(t=>t.key)).not.toContain('l')
    expect(buildStudioTiles(600,400,32)!.tiles).toHaveLength(8)
  })
})
