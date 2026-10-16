import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

const METING_EXTERNAL_ID_PATTERN = /^(?:netease|tencent):[0-9]{1,20}$/

export function createMetingProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('meting', 'meting', {
    ...options,
    validateExternalId: (value) => METING_EXTERNAL_ID_PATTERN.test(value),
  })
}
