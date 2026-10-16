import { parseCatalog } from './schema'
import type { Track } from './types'
import { readBoundedJsonResponse } from '../../../workers/providers/boundedJson'
export interface RemoteCatalogue {
  revision: string
  tracks: Track[]
}
export async function loadRemoteCatalog(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RemoteCatalogue> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetcher('/api/catalogue', {
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error()
    const body = await readBoundedJsonResponse(response, 10 * 1024 * 1024)
    if (!body.ok || !body.value || typeof body.value !== 'object' || Array.isArray(body.value))
      throw new Error()
    const value = body.value as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'revision,tracks' ||
      typeof value.revision !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(value.revision) ||
      !Array.isArray(value.tracks) ||
      value.tracks.length === 0 ||
      value.tracks.length > 10000
    )
      throw new Error()
    return { revision: value.revision, tracks: parseCatalog(value.tracks) }
  } catch {
    throw new Error('catalogue_unavailable')
  } finally {
    clearTimeout(timer)
  }
}
