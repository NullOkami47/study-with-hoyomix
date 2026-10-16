import {
  CHKSZ_KEY_MAX_LENGTH,
  CHKSZ_KEY_PREFIX,
  isChkszApiKey,
} from '../../shared/chksz'

export const CHKSZ_CREDENTIAL_STORAGE_KEY = 'study-with-hoyomix:chksz-credential:v1'

const KEY_MAX_LENGTH = CHKSZ_KEY_MAX_LENGTH

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ChkszCredentialStore {
  key(): string | null
  remember(): boolean
  revision(): number
  setKey(value: string, remember: boolean): void
  clear(): void
}

interface ChkszCredentialStoreOptions {
  storage?: StorageLike
}

const isHeaderSafe = (value: string): boolean =>
  !/[\u0000-\u001f\u007f]|[^\x00-\xff]/.test(value)

// Delegates to the shared ChKSz policy so a key accepted here is accepted by the provider, and a
// persisted key that no longer satisfies the contract is purged rather than carried forward.
const validKey = (value: unknown): value is string => isChkszApiKey(value)

const defaultStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function createChkszCredentialStore(
  options: ChkszCredentialStoreOptions = {},
): ChkszCredentialStore {
  const storage = options.storage ?? defaultStorage()
  let currentKey: string | null = null
  let remembered = false
  let credentialRevision = 0

  if (storage) {
    try {
      const raw = storage.getItem(CHKSZ_CREDENTIAL_STORAGE_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown
        if (
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
          Object.keys(parsed).length === 2 &&
          validKey((parsed as { key?: unknown }).key) &&
          (parsed as { remember?: unknown }).remember === true
        ) {
          currentKey = (parsed as { key: string }).key
          remembered = true
        } else {
          storage.removeItem(CHKSZ_CREDENTIAL_STORAGE_KEY)
        }
      }
    } catch {
      try { storage.removeItem(CHKSZ_CREDENTIAL_STORAGE_KEY) } catch { /* storage unavailable */ }
    }
  }

  return {
    key: () => currentKey,
    remember: () => remembered,
    revision: () => credentialRevision,
    setKey(value, remember) {
      if (typeof value !== 'string') {
        throw new RangeError('invalid_chksz_api_key')
      }
      // Rejected rather than trimmed: a key must never be silently altered.
      if (value.length === 0 || value.length > KEY_MAX_LENGTH || value !== value.trim()) {
        throw new RangeError('invalid_chksz_api_key')
      }
      if (!isHeaderSafe(value)) {
        throw new RangeError('unsupported_chksz_characters')
      }
      // The owner-provided contract fixes the prefix. The suffix alphabet is deliberately not
      // narrowed, because the supplied documentation does not establish one.
      if (!value.startsWith(CHKSZ_KEY_PREFIX) || value.length === CHKSZ_KEY_PREFIX.length) {
        throw new RangeError('invalid_chksz_api_key_prefix')
      }
      const key = value
      currentKey = key
      remembered = remember
      credentialRevision++
      if (!storage) return
      try {
        if (remember) {
          storage.setItem(CHKSZ_CREDENTIAL_STORAGE_KEY, JSON.stringify({ key, remember: true }))
        } else {
          storage.removeItem(CHKSZ_CREDENTIAL_STORAGE_KEY)
        }
      } catch {
        remembered = false
        try { storage.removeItem(CHKSZ_CREDENTIAL_STORAGE_KEY) } catch { /* storage unavailable */ }
      }
    },
    clear() {
      currentKey = null
      remembered = false
      credentialRevision++
      try { storage?.removeItem(CHKSZ_CREDENTIAL_STORAGE_KEY) } catch { /* storage unavailable */ }
    },
  }
}

let defaultStore: ChkszCredentialStore | undefined

export const getDefaultChkszCredentialStore = (): ChkszCredentialStore => {
  defaultStore ??= createChkszCredentialStore()
  return defaultStore
}
