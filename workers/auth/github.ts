import type { ProviderIdentity } from './types'

export const exchangeGitHubCode = async (
  input: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string },
  providerFetch: typeof fetch,
): Promise<ProviderIdentity> => {
  let accessToken = ''
  let identity: ProviderIdentity | null = null
  let providerError: unknown
  try {
    const tokenResponse = await providerFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      }),
    })
    if (!tokenResponse.ok) throw new Error('github_exchange_failed')
    const tokenBody = await tokenResponse.json() as { access_token?: unknown }
    if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) throw new Error('github_exchange_failed')
    accessToken = tokenBody.access_token

    const userResponse = await providerFetch('https://api.github.com/user', {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': 'Study-with-HOYO-MiX' },
    })
    if (!userResponse.ok) throw new Error('github_identity_failed')
    const user = await userResponse.json() as { id?: unknown; login?: unknown; name?: unknown }
    if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) throw new Error('github_identity_failed')
    const display = typeof user.name === 'string' && user.name.trim()
      ? user.name.trim()
      : typeof user.login === 'string' && user.login.trim() ? user.login.trim() : 'GitHub user'
    identity = { provider: 'github', subject: String(user.id), displayName: display.slice(0, 80) }
  } catch (error) {
    providerError = error
  }

  if (accessToken) {
    try {
      const basic = btoa(`${input.clientId}:${input.clientSecret}`)
      const revokeResponse = await providerFetch(`https://api.github.com/applications/${encodeURIComponent(input.clientId)}/token`, {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
          'user-agent': 'Study-with-HOYO-MiX',
        },
        body: JSON.stringify({ access_token: accessToken }),
      })
      if (!revokeResponse.ok) throw new Error('github_revoke_failed')
    } catch {
      accessToken = ''
      throw new Error('github_revoke_failed')
    }
    accessToken = ''
  }

  if (providerError) throw providerError
  if (!identity) throw new Error('github_identity_failed')
  return identity
}
