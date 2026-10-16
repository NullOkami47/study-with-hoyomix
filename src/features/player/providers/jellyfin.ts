import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

export function createJellyfinProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('jellyfin', 'jellyfin', options)
}
