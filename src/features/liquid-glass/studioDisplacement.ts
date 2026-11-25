// Original Study with HOYO-MiX geometry (GPL-3.0). Uses the existing first-party
// 2x PNG tiles, never data/blob URLs, scene capture, or an upstream renderer.
import { REFRACTION_TILE_SETS, tileUrls } from '../glass/refractionTiles'
export interface StudioTile { key: string; href: string; x: number; y: number; width: number; height: number }
export function studioMapGeometry(width: number, height: number, parsedRadius: number) {
  if (![width, height, parsedRadius].every(Number.isFinite) || width < 24 || height < 24 || width > 4096 || height > 4096) return null
  const radius = Math.max(0, Math.min(parsedRadius, width / 2, height / 2))
  // All six tile sets describe the same circular corner. Scale a nearby one
  // uniformly so new dialog radii work without a finite hero-only allowlist.
  const set = [...REFRACTION_TILE_SETS].sort((a, b) => Math.abs(a.radius - radius) - Math.abs(b.radius - radius))[0]!
  const bezel = radius > 0 ? set.bezel * radius / set.radius : Math.min(12, width / 3, height / 3)
  return { width, height, radius, bezel, set }
}
export function buildStudioTiles(width: number, height: number, parsedRadius: number) {
  const geometry = studioMapGeometry(width, height, parsedRadius)
  if (!geometry) return null
  const { radius: r, bezel: b, set } = geometry
  const urls = tileUrls(set)
  const tiles: StudioTile[] = []
  if (r > 0) tiles.push(
    { key: 'tl', href: urls.tl, x: 0, y: 0, width: r, height: r },
    { key: 'tr', href: urls.tr, x: width - r, y: 0, width: r, height: r },
    { key: 'bl', href: urls.bl, x: 0, y: height - r, width: r, height: r },
    { key: 'br', href: urls.br, x: width - r, y: height - r, width: r, height: r },
  )
  if (width > 2 * r) tiles.push(
    { key: 't', href: urls.t, x: r, y: 0, width: width - 2 * r, height: b },
    { key: 'b', href: urls.b, x: r, y: height - b, width: width - 2 * r, height: b },
  )
  if (height > 2 * r) tiles.push(
    { key: 'l', href: urls.l, x: 0, y: r, width: b, height: height - 2 * r },
    { key: 'r', href: urls.r, x: width - b, y: r, width: b, height: height - 2 * r },
  )
  return { ...geometry, tiles }
}
