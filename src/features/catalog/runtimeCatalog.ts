import sampleCatalog from './catalog.sample.json'
import productionCatalog from './catalog.production.json'
import { parseCatalog } from './schema'
import type { Track } from './types'

export type RuntimeCatalog =
  | { mode: 'demo'; tracks: Track[] }
  | { mode: 'production'; tracks: Track[] }

export function runtimeCatalog(enableDemo: boolean): RuntimeCatalog {
  return enableDemo
    ? { mode: 'demo', tracks: parseCatalog(sampleCatalog) }
    : { mode: 'production', tracks: parseCatalog(productionCatalog) }
}
