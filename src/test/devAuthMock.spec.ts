// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer, preview, resolveConfig, type ViteDevServer, type PreviewServer } from 'vite'
import { readAuthProviders } from '../features/account/authProviders'

const root = process.cwd()
const configFile = path.join(root, 'vite.config.ts')
const backendProviders = { providers: { google: false, github: true, linuxdo: false } }
const backendSession = { user: { id: 'local-fixture-user', displayName: 'Fixture user' } }
const originalFlag = process.env.HOYOMIX_DEV_AUTH_PREVIEW
const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (originalFlag === undefined) delete process.env.HOYOMIX_DEV_AUTH_PREVIEW
  else process.env.HOYOMIX_DEV_AUTH_PREVIEW = originalFlag
})

function flag(value?: string) {
  if (value === undefined) delete process.env.HOYOMIX_DEV_AUTH_PREVIEW
  else process.env.HOYOMIX_DEV_AUTH_PREVIEW = value
}

async function serve() {
  const vite = await createServer({
    root, configFile, logLevel: 'silent',
    // Disable Vite's own preflight responder so OPTIONS reaches the auth boundary under test.
    server: { middlewareMode: true, cors: false, watch: { ignored: ['**'] }, hmr: false },
    optimizeDeps: { disabled: true },
    plugins: [{
      name: 'downstream-backend-fixture',
      configureServer(server) {
        server.middlewares.use((req, res) => {
          res.setHeader('X-Downstream-Fixture', 'yes')
          res.setHeader('Content-Type', 'application/json')
          const pathname = new URL(req.url!, 'http://fixture.invalid').pathname
          res.end(JSON.stringify(pathname === '/api/auth/providers' ? backendProviders
            : pathname === '/api/session' ? backendSession : { method: req.method, url: req.url }))
        })
      },
    }],
  })
  cleanups.push(() => vite.close())
  const http = createHttpServer(vite.middlewares)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => closeHttp(http))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected HTTP fixture port')
  return { vite, origin: `http://127.0.0.1:${address.port}` }
}

async function closeHttp(server: Server | PreviewServer['httpServer']) {
  if ('closeAllConnections' in server) server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()))
}

function mockPlugin(server: ViteDevServer | PreviewServer) {
  return server.config.plugins.find((plugin) => plugin.name === 'dev-auth-mock')
}

describe('explicit development auth preview through the real Vite chain', () => {
  it.each([undefined, '0', 'true', 'false', '01', ' 1 '])('preserves backend availability and signed-in sessions for flag %s', async (value) => {
    flag(value)
    const { vite, origin } = await serve()
    const providers = await fetch(`${origin}/api/auth/providers?source=test`)
    expect(await providers.json()).toEqual(backendProviders)
    expect(providers.headers.get('X-Downstream-Fixture')).toBe('yes')
    const session = await fetch(`${origin}/api/session`)
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual(backendSession)
    for (const provider of ['google', 'github', 'linuxdo']) {
      const url = `/api/auth/${provider}/start?link=1`
      const response = await fetch(origin + url)
      expect(response.headers.get('X-Downstream-Fixture')).toBe('yes')
      expect(await response.json()).toEqual({ method: 'GET', url })
    }
    expect(mockPlugin(vite)).toBeUndefined()
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => nativeFetch(new URL(url, origin), init))
    expect(await readAuthProviders()).toEqual(['github'])
  })

  it('provides visibly marked mock availability and signed-out session only when opted in', async () => {
    flag('1')
    const { vite, origin } = await serve()
    expect(mockPlugin(vite)?.apply).toBe('serve')
    for (const url of ['/api/auth/providers', '/api/auth/providers?preview=1']) {
      const response = await fetch(origin + url)
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBe('1')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await response.json()).toEqual({ mock: true, providers: { google: true, github: true, linuxdo: true } })
    }
    for (const url of ['/api/session', '/api/session?preview=1']) {
      const response = await fetch(origin + url)
      expect(response.status).toBe(401)
      expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBe('1')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await response.json()).toEqual({ mock: true, error: 'unauthorized' })
    }
  })

  it('stops each mock OAuth start safely, including identity linking', async () => {
    flag('1')
    const { origin } = await serve()
    for (const provider of ['google', 'github', 'linuxdo']) {
      for (const query of ['', '?link=1']) {
        const response = await fetch(`${origin}/api/auth/${provider}/start${query}`, { redirect: 'manual' })
        expect(response.status).toBe(501)
        expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBe('1')
        expect(response.headers.get('content-type')).toContain('text/plain')
        expect(response.headers.get('location')).toBeNull()
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(await response.text()).toMatch(/development.*mock.*OAuth did not occur/i)
      }
    }
  })

  it('passes route lookalikes, callbacks, unrelated routes and non-GET methods downstream', async () => {
    flag('1')
    const { origin } = await serve()
    const exact = ['/api/auth/providers', '/api/session', ...['google', 'github', 'linuxdo'].map((p) => `/api/auth/${p}/start`)]
    for (const url of [...exact.flatMap((p) => [p + '/', p + '-extra', p + '/child']), '/api/auth/github/callback', '/api/auth/other/start', '/api/other']) {
      const response = await fetch(origin + url)
      expect(response.headers.get('X-Downstream-Fixture'), url).toBe('yes')
      expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBeNull()
      expect(await response.json()).toEqual({ method: 'GET', url })
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      for (const url of exact) {
        // Drain each response and avoid reusing HEAD connections across method cases.
        const response = await fetch(origin + url, { method, headers: { connection: 'close' } })
        expect(response.headers.get('X-Downstream-Fixture'), `${method} ${url}`).toBe('yes')
        expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBeNull()
        await response.text()
      }
    }
  }, 20000)

  it.each(['production', 'staging'])('excludes the interceptor from %s build config even with opt-in', async (mode) => {
    flag('1')
    const config = await resolveConfig({ root, configFile, mode, logLevel: 'silent' }, 'build')
    expect(config.plugins.some((plugin) => plugin.name === 'dev-auth-mock')).toBe(false)
  })

  it.each(['production', 'staging', 'development'])('never intercepts actual vite preview in %s mode even with opt-in', async (mode) => {
    flag('1')
    await mkdir(path.join(root, '.tmp'), { recursive: true })
    const outDir = await mkdtemp(path.join(root, '.tmp', 'auth-preview-'))
    cleanups.push(() => rm(outDir, { recursive: true, force: true }))
    await writeFile(path.join(outDir, 'index.html'), '<!doctype html><title>Preview fixture</title>')
    const server = await preview({ root, configFile, mode, logLevel: 'silent', build: { outDir }, preview: { port: 0, host: '127.0.0.1' } })
    cleanups.push(() => closeHttp(server.httpServer))
    if (mode !== 'development') expect(mockPlugin(server)).toBeUndefined()
    const address = server.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Expected preview port')
    for (const url of ['/api/auth/providers', '/api/session', '/api/auth/github/start?link=1']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`)
      expect(response.headers.get('X-Hoyomix-Dev-Auth-Mock')).toBeNull()
      expect(response.status).not.toBe(401)
      expect(response.status).not.toBe(501)
      expect(await response.text()).not.toContain('"providers"')
    }
  })
})
