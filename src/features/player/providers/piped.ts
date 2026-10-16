import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function createPipedProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('piped', 'piped', {
    ...options,
    validateExternalId: (value) => YOUTUBE_ID_PATTERN.test(value),
  })
}
