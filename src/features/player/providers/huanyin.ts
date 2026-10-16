import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createHuanyinProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('lx-huanyin', 'lx-huanyin', options)
}
