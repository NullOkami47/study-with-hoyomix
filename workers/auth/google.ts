import type { ProviderIdentity } from './types'
import { decodeBytes, decodeJson } from './jwt'

export type { ProviderIdentity }

interface GoogleClaims {
  iss?: unknown
  aud?: unknown
  azp?: unknown
  exp?: unknown
  nonce?: unknown
  sub?: unknown
  name?: unknown
}

export const verifyGoogleIdToken = async (
  idToken: string,
  expected: { audience: string; nonce: string; now: number },
  providerFetch: typeof fetch,
  cryptoApi: Crypto,
): Promise<ProviderIdentity> => {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('invalid_google_token')
  const header = decodeJson(parts[0])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid_google_token')

  const jwksResponse = await providerFetch('https://www.googleapis.com/oauth2/v3/certs')
  if (!jwksResponse.ok) throw new Error('google_jwks_failed')
  const jwks = await jwksResponse.json() as { keys?: JsonWebKey[] }
  const jwk = jwks.keys?.find((candidate) => {
    const metadata = candidate as JsonWebKey & { alg?: string; kid?: string }
    return metadata.kid === header.kid && metadata.alg === 'RS256'
  })
  if (!jwk) throw new Error('invalid_google_token')
  const key = await cryptoApi.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const validSignature = await cryptoApi.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!validSignature) throw new Error('invalid_google_token')

  const claims = decodeJson(parts[1]) as GoogleClaims
  const issuerValid = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com'
  if (typeof claims.aud !== 'string' && (!Array.isArray(claims.aud) || !claims.aud.every((value) => typeof value === 'string'))) {
    throw new Error('invalid_google_token')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!issuerValid || !audiences.includes(expected.audience)) throw new Error('invalid_google_token')
  if (audiences.length > 1 && !claims.azp) throw new Error('invalid_google_token')
  if (claims.azp !== undefined && claims.azp !== expected.audience) throw new Error('invalid_google_token')
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(expected.now / 1000)) throw new Error('invalid_google_token')
  if (claims.nonce !== expected.nonce) throw new Error('invalid_google_token')
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255) throw new Error('invalid_google_token')
  return {
    provider: 'google',
    subject: claims.sub,
    displayName: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 80) : 'Google user',
  }
}

export const exchangeGoogleCode = async (
  input: { code: string; verifier: string; nonce: string; redirectUri: string; clientId: string; clientSecret: string; now: number },
  providerFetch: typeof fetch,
  cryptoApi: Crypto,
) => {
  const response = await providerFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.verifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
  })
  if (!response.ok) throw new Error('google_exchange_failed')
  const body = await response.json() as { id_token?: unknown }
  if (typeof body.id_token !== 'string') throw new Error('google_exchange_failed')
  return verifyGoogleIdToken(body.id_token, { audience: input.clientId, nonce: input.nonce, now: input.now }, providerFetch, cryptoApi)
}
