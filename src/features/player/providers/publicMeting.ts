import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createPublicMetingProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('public-meting', 'public-meting', options)
}
