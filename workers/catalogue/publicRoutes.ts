import type { D1Database } from '../env'
import { readPublishedCatalogue } from './repository'
export async function cataloguePublicResponse(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'GET')
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } },
    )
  try {
    return Response.json(await readPublishedCatalogue(db), {
      headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=60' },
    })
  } catch {
    return Response.json(
      { error: 'catalogue_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}
