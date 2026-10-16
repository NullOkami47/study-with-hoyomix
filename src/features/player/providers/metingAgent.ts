import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createMetingAgentProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('meting-agent', 'meting-agent', options)
}
