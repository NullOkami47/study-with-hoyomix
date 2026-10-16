export type AuthProvider = 'github' | 'google' | 'linuxdo'

export interface ProviderIdentity {
  provider: AuthProvider
  subject: string
  displayName: string
}
