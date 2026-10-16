export interface SafeStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export function isStorageDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; name?: unknown }
  return (
    candidate.name === 'SecurityError' ||
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 18 ||
    candidate.code === 22 ||
    candidate.code === 1014
  )
}

function storage(kind: 'localStorage' | 'sessionStorage'): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window[kind]
  } catch (error) {
    if (isStorageDenied(error)) return undefined
    throw error
  }
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): SafeStorage {
  return {
    getItem(key) {
      try {
        return storage(kind)?.getItem(key) ?? null
      } catch (error) {
        if (isStorageDenied(error)) return null
        throw error
      }
    },
    removeItem(key) {
      try {
        storage(kind)?.removeItem(key)
      } catch (error) {
        if (!isStorageDenied(error)) throw error
      }
    },
    setItem(key, value) {
      try {
        storage(kind)?.setItem(key, value)
      } catch (error) {
        if (!isStorageDenied(error)) throw error
      }
    },
  }
}

export const safeLocalStorage = safeStorage('localStorage')
export const safeSessionStorage = safeStorage('sessionStorage')
