// Anonymous, read-only publication of the global LX source registry.
//
// This is the only way a user's browser obtains a published script. Two rules shape it:
//
//   * the list is small and changes rarely, and it carries the registry revision, so a client can
//     tell whether anything changed without re-downloading a script body;
//   * a script body is served by digest and never changes for a given digest, so it can be cached
//     immutably forever.
//
// A source that is disabled, or that is still waiting for its network origins to be approved, is
// not published at all: it does not appear in the list and its script is not downloadable.

import type { D1Database } from '../env'
import {
  MANAGED_LX_SOURCE_ID, readManagedLxSources, readManagedSnapshotScript, readRegistryRevision,
  defaultManagedLxSource,
} from './globalSources'

export interface LxPublicEnv {
  DB: D1Database
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

/** How long a client may reuse the published list before revalidating it. */
const LIST_MAX_AGE_SECONDS = 60

export function createLxPublicHandler(env: LxPublicEnv) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const path = url.pathname

      if (path === '/api/lx/sources' && request.method === 'GET') {
        const revision = await readRegistryRevision(env.DB)
        const rows = await readManagedLxSources(env.DB)
        const published = rows
          .filter((row) => row.id !== MANAGED_LX_SOURCE_ID && row.enabled && row.status === 'active')
          .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
          .map((row) => ({
            id: row.id,
            name: row.name,
            version: row.version,
            sha256: row.activeSha256,
            priority: row.priority,
            requiredOrigins: row.requiredOrigins,
          }))
        // This policy remains visible when disabled so clients cannot resurrect their old local copy.
        // Keep revocation visible to older clients while the deleted source stays absent from Admin.
        const present = rows.find((source) => source.id === MANAGED_LX_SOURCE_ID)
        const configured = defaultManagedLxSource()
        const managed = present ?? {
          ...(configured ?? {
            id: MANAGED_LX_SOURCE_ID, name: 'No bundled source', version: null,
            activeSha256: '0'.repeat(64), priority: 10, requiredOrigins: [],
          }),
          enabled: false, status: 'disabled',
        }
        const managedSource = {
          id: managed.id, name: managed.name, version: managed.version, sha256: managed.activeSha256,
          priority: managed.priority, requiredOrigins: managed.requiredOrigins,
          enabled: managed.enabled, status: managed.status,
          ...(!present ? { deleted: true } : {}),
        }
        return json(
          { revision, sources: published, managedSource },
          200,
          { 'cache-control': `public, max-age=${LIST_MAX_AGE_SECONDS}` },
        )
      }

      const scriptMatch = path.match(/^\/api\/lx\/sources\/([A-Za-z0-9._-]+)\/script$/u)
      if (scriptMatch && request.method === 'GET') {
        const id = scriptMatch[1]!
        const sha256 = url.searchParams.get('sha256') ?? ''
        if (!/^[0-9a-f]{64}$/u.test(sha256)) {
          return json({ error: 'invalid_digest', message: 'sha256 query parameter is required' }, 400)
        }

        const rows = await readManagedLxSources(env.DB)
        const row = rows.find((candidate) => candidate.id === id)
        // A source that is not published must not be downloadable, even with the right digest.
        if (!row || !row.enabled || row.status !== 'active') {
          return json({ error: 'not_found' }, 404)
        }
        // The digest is the address: a mismatch means the client is asking for a body that is not
        // the one this source currently publishes.
        if (row.activeSha256 !== sha256) {
          return json({ error: 'digest_mismatch' }, 409)
        }

        const snapshot = await readManagedSnapshotScript(env.DB, id, sha256)
        if (!snapshot) return json({ error: 'not_found' }, 404)

        return new Response(snapshot.script, {
          status: 200,
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            // The body is addressed by digest and never changes for a given digest.
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          },
        })
      }

      return json({ error: 'not_found' }, 404)
    },
  }
}
