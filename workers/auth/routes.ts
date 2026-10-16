import type { Env } from '../env'
import { exchangeGitHubCode } from './github'
import { exchangeGoogleCode } from './google'
import { exchangeLinuxDoCode, LINUXDO_AUTH_URL } from './linuxdo'
import type { AuthProvider, ProviderIdentity } from './types'
import { consumeOAuthFlow, registerOAuthFlow } from './flow'
import { findIdentityOwner, linkIdentity as persistIdentityLink, unlinkIdentity } from './linking'
import { initialRoleForIdentity } from './ownerBootstrap'
import {
  expiredSessionCookie,
  findSession,
  issueSession,
  readCookie,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
} from './session'

export interface AuthEnv extends Env {
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
  OAUTH_STATE_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  LINUXDO_CLIENT_ID?: string
  LINUXDO_CLIENT_SECRET?: string
  OWNER_PROVIDER?: AuthProvider
  OWNER_SUBJECT?: string
}

export interface AuthOptions {
  fetch?: typeof fetch
  crypto?: Crypto
  now?: () => number
}

interface OAuthFlow {
  provider: AuthProvider
  intent: 'link' | 'login'
  state: string
  nonce: string
  verifier: string
  createdAt: number
  linkUserId?: string
}

const OAUTH_COOKIE = '__Host-oauth'
const OAUTH_LIFETIME_MS = 10 * 60 * 1000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

const randomValue = (cryptoApi: Crypto, bytes = 32) => {
  const value = new Uint8Array(bytes)
  cryptoApi.getRandomValues(value)
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const decodeBase64Url = (value: string) => {
  const normalised = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

const oauthKey = async (secret: string, cryptoApi: Crypto) => {
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(secret))
  return cryptoApi.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const sealFlow = async (flow: OAuthFlow, secret: string, cryptoApi: Crypto) => {
  const iv = new Uint8Array(12)
  cryptoApi.getRandomValues(iv)
  const encrypted = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(OAUTH_COOKIE) },
    await oauthKey(secret, cryptoApi),
    encoder.encode(JSON.stringify(flow)),
  )
  const joined = new Uint8Array(iv.length + encrypted.byteLength)
  joined.set(iv)
  joined.set(new Uint8Array(encrypted), iv.length)
  return randomValueFromBytes(joined)
}

const randomValueFromBytes = (value: Uint8Array) => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const openFlow = async (value: string, secret: string, cryptoApi: Crypto): Promise<OAuthFlow> => {
  const joined = decodeBase64Url(value)
  if (joined.length <= 12) throw new Error('invalid_oauth_flow')
  const plain = await cryptoApi.subtle.decrypt(
    { name: 'AES-GCM', iv: joined.slice(0, 12), additionalData: encoder.encode(OAUTH_COOKIE) },
    await oauthKey(secret, cryptoApi),
    joined.slice(12),
  )
  const candidate = JSON.parse(decoder.decode(plain)) as Partial<OAuthFlow>
  if (
    (candidate.provider !== 'google' && candidate.provider !== 'github' && candidate.provider !== 'linuxdo') ||
    (candidate.intent !== 'login' && candidate.intent !== 'link') ||
    typeof candidate.state !== 'string' || typeof candidate.nonce !== 'string' ||
    typeof candidate.verifier !== 'string' || typeof candidate.createdAt !== 'number'
  ) throw new Error('invalid_oauth_flow')
  return candidate as OAuthFlow
}

const oauthCookie = (value: string) =>
  `${OAUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OAUTH_LIFETIME_MS / 1000}`

const expiredOauthCookie = () => `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`

const redirectWithCookies = (location: string, cookies: string[]) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const validatePublicOrigin = (value: string) => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('invalid_public_origin')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (
    parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== '/' ||
    parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) throw new Error('invalid_public_origin')
  return parsed.origin
}

export function createAuthHandler(env: AuthEnv, options: AuthOptions = {}) {
  const cryptoApi = options.crypto ?? crypto
  const providerFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const publicOrigin = validatePublicOrigin(env.PUBLIC_ORIGIN)

  const currentSession = async (request: Request) => {
    const token = readCookie(request, SESSION_COOKIE)
    return { token, session: await findSession(env.DB, token, env.SESSION_HMAC_SECRET, now(), cryptoApi) }
  }

  const issueForUser = (userId: string) => issueSession(env.DB, userId, env.SESSION_HMAC_SECRET, now(), cryptoApi)

  const respondWithRotatedSession = async (userId: string, priorSessionId?: string, status = 200) => {
    if (priorSessionId) await revokeSession(env.DB, priorSessionId, now())
    const issued = await issueForUser(userId)
    return json({ ok: true }, status, { 'set-cookie': sessionCookie(issued.token) })
  }

  const completeIdentity = async (identity: ProviderIdentity, flow: OAuthFlow, request: Request) => {
    const current = await currentSession(request)
    if (flow.intent === 'link') {
      if (!current.session || current.session.userId !== flow.linkUserId) return json({ error: 'authentication_required' }, 401)
      const result = await persistIdentityLink(env.DB, current.session.userId, identity, now(), cryptoApi)
      if (result === 'collision' || result === 'provider_already_linked') return json({ error: result }, 409)
      return respondWithRotatedSession(current.session.userId, current.session.id)
    }

    let userId = (await findIdentityOwner(env.DB, identity))?.userId
    if (!userId) {
      userId = cryptoApi.randomUUID()
      const role = initialRoleForIdentity(identity.provider, identity.subject, env.OWNER_PROVIDER, env.OWNER_SUBJECT)
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `).bind(userId, identity.displayName, role, now(), now()),
        env.DB.prepare(`
          INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(cryptoApi.randomUUID(), userId, identity.provider, identity.subject, now(), now()),
      ])
    } else {
      await env.DB.prepare('UPDATE auth_identities SET last_used_at = ? WHERE provider = ? AND provider_subject = ?')
        .bind(now(), identity.provider, identity.subject).run()
    }
    if (current.session) await revokeSession(env.DB, current.session.id, now())
    const issued = await issueForUser(userId)
    return redirectWithCookies(`${publicOrigin}/`, [sessionCookie(issued.token)])
  }

  const startOAuth = async (provider: AuthProvider, request: Request) => {
    if (!availableProviders()[provider]) return json({ error: 'provider_unavailable' }, 503)
    const url = new URL(request.url)
    const intent = url.searchParams.get('intent') === 'link' ? 'link' as const : 'login' as const
    const current = intent === 'link' ? await currentSession(request) : null
    if (intent === 'link' && !current?.session) return json({ error: 'authentication_required' }, 401)
    const verifier = randomValue(cryptoApi)
    const challenge = randomValueFromBytes(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(verifier))))
    const flow: OAuthFlow = {
      provider,
      intent,
      state: randomValue(cryptoApi),
      nonce: randomValue(cryptoApi),
      verifier,
      createdAt: now(),
      linkUserId: current?.session?.userId,
    }
    await registerOAuthFlow(env.DB, {
      state: flow.state,
      provider,
      intent,
      createdAt: flow.createdAt,
      expiresAt: flow.createdAt + OAUTH_LIFETIME_MS,
    }, env.OAUTH_STATE_SECRET, cryptoApi)
    const callback = `${publicOrigin}/api/auth/${provider}/callback`
    let destination: URL
    if (provider === 'google') {
      destination = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      destination.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
      destination.searchParams.set('scope', 'openid profile')
      destination.searchParams.set('nonce', flow.nonce)
    } else if (provider === 'github') {
      destination = new URL('https://github.com/login/oauth/authorize')
      destination.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
    } else {
      destination = new URL(LINUXDO_AUTH_URL)
      destination.searchParams.set('client_id', env.LINUXDO_CLIENT_ID?.trim() ?? '')
      destination.searchParams.set('scope', 'openid profile')
      destination.searchParams.set('nonce', flow.nonce)
    }
    destination.searchParams.set('redirect_uri', callback)
    destination.searchParams.set('response_type', 'code')
    destination.searchParams.set('state', flow.state)
    destination.searchParams.set('code_challenge', challenge)
    destination.searchParams.set('code_challenge_method', 'S256')
    return redirectWithCookies(destination.toString(), [oauthCookie(await sealFlow(flow, env.OAUTH_STATE_SECRET, cryptoApi))])
  }

  const callback = async (provider: AuthProvider, request: Request) => {
    try {
      const url = new URL(request.url)
      if (url.origin !== publicOrigin) {
        return json({ error: 'invalid_oauth_callback' }, 400, { 'set-cookie': expiredOauthCookie() })
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const flow = await openFlow(readCookie(request, OAUTH_COOKIE), env.OAUTH_STATE_SECRET, cryptoApi)
      if (!code || !state || flow.provider !== provider || flow.state !== state || now() - flow.createdAt > OAUTH_LIFETIME_MS || flow.createdAt > now()) {
        return json({ error: 'invalid_oauth_state' }, 400, { 'set-cookie': expiredOauthCookie() })
      }
      const consumed = await consumeOAuthFlow(
        env.DB,
        { state: flow.state, provider, intent: flow.intent },
        env.OAUTH_STATE_SECRET,
        now(),
        cryptoApi,
      )
      if (!consumed) return json({ error: 'invalid_oauth_state' }, 400, { 'set-cookie': expiredOauthCookie() })
      const redirectUri = `${publicOrigin}/api/auth/${provider}/callback`
      let identity: ProviderIdentity
      if (provider === 'google') {
        identity = await exchangeGoogleCode({
          code, verifier: flow.verifier, nonce: flow.nonce, redirectUri,
          clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, now: now(),
        }, providerFetch, cryptoApi)
      } else if (provider === 'github') {
        identity = await exchangeGitHubCode({
          code, verifier: flow.verifier, redirectUri,
          clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
        }, providerFetch)
      } else {
        identity = await exchangeLinuxDoCode({
          code, verifier: flow.verifier, nonce: flow.nonce, redirectUri,
          clientId: env.LINUXDO_CLIENT_ID?.trim() ?? '', clientSecret: env.LINUXDO_CLIENT_SECRET?.trim() ?? '', now: now(),
        }, providerFetch, cryptoApi)
      }
      const response = await completeIdentity(identity, flow, request)
      response.headers.append('set-cookie', expiredOauthCookie())
      return response
    } catch {
      return json({ error: 'oauth_callback_failed' }, 401, { 'set-cookie': expiredOauthCookie() })
    }
  }

  const availableProviders = () => ({
    github: Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim()),
    google: Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
    linuxdo: Boolean(env.LINUXDO_CLIENT_ID?.trim() && env.LINUXDO_CLIENT_SECRET?.trim()),
  })

  const fetchHandler = async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/auth/providers') {
      return json({ providers: availableProviders() })
    }
    const authRoute = url.pathname.match(/^\/api\/auth\/(google|github|linuxdo)\/(start|callback|unlink)$/)
    const provider = authRoute?.[1] as AuthProvider | undefined
    const action = authRoute?.[2]
    const sessionMutation = request.method === 'POST' && (
      url.pathname === '/api/logout' || url.pathname === '/api/logout-all' || action === 'unlink'
    )
    if (sessionMutation && request.headers.get('origin') !== publicOrigin) {
      return json({ error: 'forbidden_origin' }, 403)
    }
    if (request.method === 'GET' && provider && action === 'start') return startOAuth(provider, request)
    if (request.method === 'GET' && provider && action === 'callback') return callback(provider, request)
    if (request.method === 'GET' && url.pathname === '/api/session') {
      const current = await currentSession(request)
      if (!current.session) return json({ user: null }, 401)
      const identities = await env.DB.prepare('SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY provider')
        .bind(current.session.userId).all<{ provider: AuthProvider }>()
      return json({ user: {
        id: current.session.userId,
        displayName: current.session.displayName,
        avatarUrl: current.session.avatarUrl,
        role: current.session.role,
      }, identities: identities.results.map(({ provider: name }) => name) })
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const current = await currentSession(request)
      if (current.session) await revokeSession(env.DB, current.session.id, now())
      return new Response(null, { status: 204, headers: { 'set-cookie': expiredSessionCookie(), 'cache-control': 'no-store' } })
    }
    if (request.method === 'POST' && url.pathname === '/api/logout-all') {
      const current = await currentSession(request)
      if (!current.session) return json({ error: 'authentication_required' }, 401)
      await revokeAllSessions(env.DB, current.session.userId, now())
      return new Response(null, { status: 204, headers: { 'set-cookie': expiredSessionCookie(), 'cache-control': 'no-store' } })
    }
    if (request.method === 'POST' && provider && action === 'unlink') {
      const current = await currentSession(request)
      if (!current.session) return json({ error: 'authentication_required' }, 401)
      const result = await unlinkIdentity(env.DB, current.session.userId, provider)
      if (result === 'last_identity') return json({ error: result }, 409)
      if (result === 'not_linked') return json({ error: result }, 404)
      return respondWithRotatedSession(current.session.userId, current.session.id)
    }
    return json({ error: 'not_found' }, 404)
  }

  return {
    fetch: fetchHandler,
    issueSession: (userId: string) => issueForUser(userId),
    linkIdentity: async (token: string, identity: ProviderIdentity) => {
      const session = await findSession(env.DB, token, env.SESSION_HMAC_SECRET, now(), cryptoApi)
      if (!session) return json({ error: 'authentication_required' }, 401)
      const result = await persistIdentityLink(env.DB, session.userId, identity, now(), cryptoApi)
      if (result !== 'linked') return json({ error: result }, 409)
      return respondWithRotatedSession(session.userId, session.id)
    },
    rotateAfterPrivilegeChange: async (token: string, role: 'user' | 'moderator' | 'admin' | 'owner') => {
      const session = await findSession(env.DB, token, env.SESSION_HMAC_SECRET, now(), cryptoApi)
      if (!session) return json({ error: 'authentication_required' }, 401)
      await env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').bind(role, now(), session.userId).run()
      return respondWithRotatedSession(session.userId, session.id)
    },
  }
}
