import type { ProviderIdentity } from './types'
import { decodeBytes, decodeJson } from './jwt'

/**
 * Authoritative OpenID Connect discovery endpoints verified from:
 * https://connect.linux.do/.well-known/openid-configuration
 *
 * Discovery contract (verified 2026-10-07):
 * - issuer: "https://connect.linux.do/"
 * - authorization_endpoint: "https://connect.linux.do/oauth2/authorize"
 * - token_endpoint: "https://connect.linux.do/oauth2/token"
 * - jwks_uri: "https://connect.linux.do/.well-known/jwks.json"
 * - response_types_supported: ["code"]
 * - id_token_signing_alg_values_supported: ["RS256"]
 * - code_challenge_methods_supported: ["S256"]
 * - scopes_supported: ["openid", "profile", "email"]
 * - claims_supported: ["sub", "iss", "aud", "exp", "iat", "nbf", "azp", "username", "login", "name", "email", "avatar_url", "active", "trust_level", "silenced"]
 */
export const LINUXDO_ISSUER = 'https://connect.linux.do/'
export const LINUXDO_AUTH_URL = 'https://connect.linux.do/oauth2/authorize'
export const LINUXDO_TOKEN_URL = 'https://connect.linux.do/oauth2/token'
export const LINUXDO_JWKS_URL = 'https://connect.linux.do/.well-known/jwks.json'

interface LinuxDoClaims {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  nonce?: unknown
  sub?: unknown
  name?: unknown
  preferred_username?: unknown
  username?: unknown
  login?: unknown
  azp?: unknown
  trust_level?: unknown
  nbf?: unknown
  iat?: unknown
}

export const verifyLinuxDoIdToken = async (
  idToken: string,
  expected: { audience: string; nonce: string; now: number },
  providerFetch: typeof fetch,
  cryptoApi: Crypto,
): Promise<ProviderIdentity> => {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('invalid_linuxdo_token')
  const header = decodeJson(parts[0])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('invalid_linuxdo_token')
  }

  const jwksResponse = await providerFetch(LINUXDO_JWKS_URL)
  if (!jwksResponse.ok) throw new Error('linuxdo_jwks_failed')
  const jwks = await jwksResponse.json() as { keys?: JsonWebKey[] }
  const jwk = jwks.keys?.find((candidate) => {
    const metadata = candidate as JsonWebKey & { alg?: string; kid?: string; use?: string; kty?: string }
    return (
      metadata.kid === header.kid &&
      (metadata.alg === 'RS256' || !metadata.alg) &&
      (metadata.use === 'sig' || !metadata.use) &&
      (metadata.kty === 'RSA' || !metadata.kty)
    )
  })
  if (!jwk) throw new Error('invalid_linuxdo_token')

  const key = await cryptoApi.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const validSignature = await cryptoApi.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!validSignature) throw new Error('invalid_linuxdo_token')

  const claims = decodeJson(parts[1]) as LinuxDoClaims
  if (claims.iss !== LINUXDO_ISSUER) throw new Error('invalid_linuxdo_token')

  if (typeof claims.aud !== 'string' && (!Array.isArray(claims.aud) || !claims.aud.every((a) => typeof a === 'string'))) {
    throw new Error('invalid_linuxdo_token')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expected.audience)) throw new Error('invalid_linuxdo_token')

  // OIDC Core 1.0 section 3.1.3.7 rules 3 & 4:
  // - If multiple audiences are present, azp MUST be present
  // - If azp is present, it MUST match the client ID
  if (audiences.length > 1 && !claims.azp) throw new Error('invalid_linuxdo_token')
  if (claims.azp !== undefined && claims.azp !== expected.audience) throw new Error('invalid_linuxdo_token')

  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(expected.now / 1000)) throw new Error('invalid_linuxdo_token')
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > Math.floor(expected.now / 1000))) {
    throw new Error('invalid_linuxdo_token')
  }
  if (claims.nonce !== expected.nonce) throw new Error('invalid_linuxdo_token')
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255) throw new Error('invalid_linuxdo_token')

  const rawDisplay =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.trim()) ||
    (typeof claims.username === 'string' && claims.username.trim()) ||
    (typeof claims.login === 'string' && claims.login.trim()) ||
    'LINUX DO user'

  return {
    provider: 'linuxdo',
    subject: claims.sub,
    displayName: rawDisplay.slice(0, 80),
  }
}

export const exchangeLinuxDoCode = async (
  input: {
    code: string
    verifier: string
    nonce: string
    redirectUri: string
    clientId: string
    clientSecret: string
    now: number
  },
  providerFetch: typeof fetch,
  cryptoApi: Crypto,
): Promise<ProviderIdentity> => {
  if (!input.clientId || !input.clientSecret) throw new Error('linuxdo_exchange_failed')
  const response = await providerFetch(LINUXDO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.verifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
  })
  if (!response.ok) throw new Error('linuxdo_exchange_failed')
  const body = await response.json() as { id_token?: unknown }
  if (typeof body.id_token !== 'string') throw new Error('linuxdo_exchange_failed')
  return verifyLinuxDoIdToken(
    body.id_token,
    { audience: input.clientId, nonce: input.nonce, now: input.now },
    providerFetch,
    cryptoApi,
  )
}
