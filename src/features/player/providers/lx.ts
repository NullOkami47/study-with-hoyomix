import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import type { AudioProvider } from './types'

const HUIBQ_EXTERNAL_ID_PATTERN =
  /^(?:kw|kg|tx|wy|mg):[A-Za-z0-9_-]{1,96}:(?:128k|320k)$/
const IKUN_EXTERNAL_ID_PATTERN =
  /^(?:kw|wy|git):[A-Za-z0-9_-]{1,96}:(?:128k|320k|flac|flac24bit|hires|atmos|master)$/

const IKUN_SOURCE_QUALITIES: Readonly<Record<string, ReadonlySet<string>>> = {
  kw: new Set(['128k', '320k', 'flac', 'flac24bit', 'hires']),
  wy: new Set(['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master']),
  git: new Set(['128k', '320k', 'flac']),
}

const isCanonicalIkunBinding = (value: string): boolean => {
  if (!IKUN_EXTERNAL_ID_PATTERN.test(value)) return false
  const [source, , quality] = value.split(':')
  return Boolean(source && quality && IKUN_SOURCE_QUALITIES[source]?.has(quality))
}

export function createHuibqProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('lx-huibq', 'lx-huibq', {
    ...options,
    validateExternalId: (value) => HUIBQ_EXTERNAL_ID_PATTERN.test(value),
  })
}

export function createIkunProvider(options: ServerProxyProviderOptions): AudioProvider {
  return createServerProxyProvider('lx-ikun', 'lx-ikun', {
    ...options,
    validateExternalId: isCanonicalIkunBinding,
  })
}
