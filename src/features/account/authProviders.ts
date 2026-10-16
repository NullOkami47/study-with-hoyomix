export type AuthProvider = 'google' | 'github' | 'linuxdo'

/** Login and new identity links require an affirmative answer from the deployed Worker. */
export async function readAuthProviders(): Promise<AuthProvider[]> {
  try {
    const response = await fetch('/api/auth/providers', { headers: { accept: 'application/json' } })
    if (!response.ok) return []
    const body = await response.json() as { providers?: Record<string, unknown> }
    return (['google', 'github', 'linuxdo'] as const).filter((provider) => body?.providers?.[provider] === true)
  } catch {
    return []
  }
}
