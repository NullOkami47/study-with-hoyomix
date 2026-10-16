const PROXY_HEADER = 'x-hoyomix-proxy-secret'
const authenticatedRequests = new WeakSet<Request>()

export const isAuthenticatedProxyRequest = (request: Request): boolean => authenticatedRequests.has(request)

interface ProxyEnv {
  PUBLIC_ORIGIN: string
  API_PROXY_SECRET?: string
  BACKEND_ORIGIN?: string
  PROXY_FRONTEND_ORIGIN?: string
}

const forbidden = () => new Response(JSON.stringify({ error: 'forbidden_proxy' }), {
  status: 403,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

/** Proxy ingress is opt-in and accepts only exact HTTPS origins. */
const configuredHttpsOrigin = (value?: string): string | null => {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.origin === value &&
      !parsed.username && !parsed.password && parsed.pathname === '/' &&
      !parsed.search && !parsed.hash ? parsed.origin : null
  } catch { return null }
}
/** Only the authenticated, fixed Vercel upstream may supply the public URL context.
 * The original browser Origin remains untouched for every route's CSRF checks.
 */
export const authenticateProxyIngress = async (request: Request, env: ProxyEnv): Promise<Request | Response> => {
  const supplied = request.headers.get(PROXY_HEADER)
  if (supplied === null) return request
  const url = new URL(request.url)
  const configured = env.API_PROXY_SECRET
  const backendOrigin = configuredHttpsOrigin(env.BACKEND_ORIGIN)
  const frontendOrigin = configuredHttpsOrigin(env.PROXY_FRONTEND_ORIGIN)
  if (
    !configured || configured.length < 32 || configured.length > 256 ||
    supplied.length < 32 || supplied.length > 256 ||
    !backendOrigin || !frontendOrigin ||
    url.origin !== backendOrigin || env.PUBLIC_ORIGIN !== frontendOrigin ||
    !url.pathname.startsWith('/api/')
  ) return forbidden()

  const encoder = new TextEncoder()
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(configured)),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
  ])
  const left = new Uint8Array(expected)
  const right = new Uint8Array(actual)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  if (difference !== 0) return forbidden()

  const headers = new Headers(request.headers)
  headers.delete(PROXY_HEADER)
  url.protocol = 'https:'
  url.host = new URL(frontendOrigin).host
  const incoming = new Request(url, new Request(request, { headers }))
  authenticatedRequests.add(incoming)
  return incoming
}
