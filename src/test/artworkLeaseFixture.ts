import { vi } from 'vitest'
import { publicArtworkUrl, sharedArtworkCache, type ArtworkResource } from '../features/library/artworkCache'

/** UI seam only. Real bytes, security checks and object-URL lifetime are covered by cache/HTTP tests. */
export const artworkBlob = (source: string) => 'blob:http://localhost/verified-' + encodeURIComponent(source)
export const verifiedArtwork = (source: string): ArtworkResource => ({ url: artworkBlob(source), sourceUrl: source, shared: true })
export function mockValidatedArtwork() {
  const rejected = new Set<string>(), resources = new Map<string, ArtworkResource>()
  const releases = new Map<string, ReturnType<typeof vi.fn>>()
  const metadataReleases = new Map<string, ReturnType<typeof vi.fn>>()
  const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockImplementation(value => {
    const source = publicArtworkUrl(value)
    const release = vi.fn(); releases.set(value, release)
    if (!source || rejected.has(source)) return { ready: Promise.resolve(null), release }
    const resource = resources.get(source) ?? verifiedArtwork(source)
    resources.set(source, resource)
    return { ready: Promise.resolve(resource), release }
  })
  const invalidate = vi.spyOn(sharedArtworkCache, 'invalidate').mockImplementation(value => { rejected.add(value) })
  const retain = vi.spyOn(sharedArtworkCache, 'retain').mockImplementation(url => {
    if (![...resources.values()].some(resource => resource.url === url)) return undefined
    const release = vi.fn(); metadataReleases.set(url, release); return release
  })
  return { acquire, invalidate, retain, rejected, resources, releases, metadataReleases }
}
