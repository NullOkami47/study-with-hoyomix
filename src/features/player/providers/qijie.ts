import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createQijieProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('qijie', 'qijie', options)
}
