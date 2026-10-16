import type { AuthProvider } from './types'

export const initialRoleForIdentity = (
  provider: AuthProvider,
  subject: string,
  configuredProvider?: AuthProvider,
  configuredSubject?: string,
) => provider !== 'google' && configuredProvider === provider && configuredSubject === subject ? 'owner' as const : 'user' as const
