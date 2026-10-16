import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createGdStudioProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('gd-studio', 'gd-studio', options)
}
