import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function createInvidiousProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('invidious', 'invidious', {
    ...options,
    validateExternalId: (value) => YOUTUBE_ID_PATTERN.test(value),
  })
}
