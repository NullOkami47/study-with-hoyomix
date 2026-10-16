import { describe, expect, it, vi } from 'vitest'

import {
  CHKSZ_CREDENTIAL_STORAGE_KEY,
  createChkszCredentialStore,
} from './chkszCredentialStore'

const USER_KEY = 'chksz_USER_KEY_SENTINEL'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
      removeItem: vi.fn((key: string) => { values.delete(key) }),
    },
  }
}

describe('ChKSz credential store', () => {
  it('keeps a key in memory for this store instance by default', () => {
    const { storage } = memoryStorage()
    const store = createChkszCredentialStore({ storage })

    store.setKey(USER_KEY, false)

    expect(store.key()).toBe(USER_KEY)
    expect(store.remember()).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(createChkszCredentialStore({ storage }).key()).toBeNull()
  })

  it('restores a key only after explicit remember-on-device consent', () => {
    const { storage, values } = memoryStorage()
    const store = createChkszCredentialStore({ storage })

    store.setKey(USER_KEY, true)

    expect(values.get(CHKSZ_CREDENTIAL_STORAGE_KEY)).toBe(JSON.stringify({ key: USER_KEY, remember: true }))
    const restored = createChkszCredentialStore({ storage })
    expect(restored.key()).toBe(USER_KEY)
    expect(restored.remember()).toBe(true)
  })

  it('clears malformed device state and never performs network or account sync', () => {
    const { storage, values } = memoryStorage()
    values.set(CHKSZ_CREDENTIAL_STORAGE_KEY, JSON.stringify({ key: 'x'.repeat(513), remember: true }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const store = createChkszCredentialStore({ storage })
    store.clear()

    expect(store.key()).toBeNull()
    expect(store.remember()).toBe(false)
    expect(values.has(CHKSZ_CREDENTIAL_STORAGE_KEY)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  describe('credential validation & header safety', () => {
    it('accepts valid ordinary ASCII token', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      store.setKey('chksz_token_12345', false)
      expect(store.key()).toBe('chksz_token_12345')
      expect(() => new Headers({ 'x-chksz-api-key': store.key()! })).not.toThrow()
    })

    it('accepts valid ASCII token containing common token punctuation', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      const token = 'chksz_token-with_common.punct=and/slash+plus'
      store.setKey(token, false)
      expect(store.key()).toBe(token)
      expect(() => new Headers({ 'x-chksz-api-key': store.key()! })).not.toThrow()
    })

    it('reproduces critical RED regression: rejects key containing U+200B ZERO WIDTH SPACE at boundary', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('abc\u200Bdef', false)).toThrow()
    })

    it('rejects key containing a CJK character', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('key\u4e2d\u6587', false)).toThrow()
    })

    it('rejects key containing an emoji / surrogate pair', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('key\u2705', false)).toThrow()
      expect(() => store.setKey('key\uD83D\uDE00', false)).toThrow()
    })

    it('rejects existing control-character cases', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('key\u0000', false)).toThrow()
      expect(() => store.setKey('key\u001f', false)).toThrow()
      expect(() => store.setKey('key\u007f', false)).toThrow()
    })

    it('rejects empty and whitespace-only keys', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('', false)).toThrow()
      expect(() => store.setKey('   ', false)).toThrow()
    })

    it('rejects keys exceeding KEY_MAX_LENGTH', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      expect(() => store.setKey('a'.repeat(513), false)).toThrow()
    })

    it('purges persisted invalid Unicode credential on initialization and reports credentialPresent=false', () => {
      const { storage, values } = memoryStorage()
      values.set(CHKSZ_CREDENTIAL_STORAGE_KEY, JSON.stringify({ key: 'persisted\u200Bkey', remember: true }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const store = createChkszCredentialStore({ storage })

      expect(store.key()).toBeNull()
      expect(store.remember()).toBe(false)
      expect(values.has(CHKSZ_CREDENTIAL_STORAGE_KEY)).toBe(false)
      expect(storage.removeItem).toHaveBeenCalledWith(CHKSZ_CREDENTIAL_STORAGE_KEY)
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    })
  })

  // The owner-provided ChKSz contract fixes the key prefix. The suffix alphabet is deliberately
  // NOT narrowed: the supplied documentation does not establish one.
  describe('chksz_ prefix contract', () => {
    it('accepts a key with the prefix and a non-empty suffix', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      store.setKey('chksz_a', false)
      expect(store.key()).toBe('chksz_a')

      store.setKey('chksz_ABCdef0123456789-_.~', false)
      expect(store.key()).toBe('chksz_ABCdef0123456789-_.~')
    })

    it('accepts the prefix at the exact maximum length', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      const key = `chksz_${'a'.repeat(506)}`
      expect(key).toHaveLength(512)

      store.setKey(key, false)
      expect(store.key()).toBe(key)
    })

    it('rejects a key without the prefix', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      for (const value of ['abc123', 'ABC123', 'chksz', 'xchksz_abc', 'CHKSZ_abc']) {
        expect(() => store.setKey(value, false), value).toThrow(RangeError)
      }
      expect(store.key()).toBeNull()
    })

    it('rejects the bare prefix with an empty suffix', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      expect(() => store.setKey('chksz_', false)).toThrow(RangeError)
      expect(store.key()).toBeNull()
    })

    it('rejects surrounding whitespace rather than silently trimming it', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      for (const value of [' chksz_abc', 'chksz_abc ', '  chksz_abc  ', '\tchksz_abc']) {
        expect(() => store.setKey(value, false), JSON.stringify(value)).toThrow(RangeError)
      }
      expect(store.key()).toBeNull()
    })

    it('rejects a non-ByteString credential', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      for (const value of ['chksz_\u200B', 'chksz_\u4e2d', 'chksz_\u2705', 'chksz_\uD83D\uDE00']) {
        expect(() => store.setKey(value, false), JSON.stringify(value)).toThrow(RangeError)
      }
      expect(store.key()).toBeNull()
    })

    it('rejects an oversized prefixed credential', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })

      expect(() => store.setKey(`chksz_${'a'.repeat(507)}`, false)).toThrow(RangeError)
      expect(store.key()).toBeNull()
    })

    it('never normalises or silently alters an accepted key', () => {
      const { storage } = memoryStorage()
      const store = createChkszCredentialStore({ storage })
      const key = 'chksz_Case-Sensitive_And.Exact'

      store.setKey(key, true)
      expect(store.key()).toBe(key)
      expect(createChkszCredentialStore({ storage }).key()).toBe(key)
    })

    it('silently purges a persisted key that lacks the prefix', () => {
      const { storage, values } = memoryStorage()
      values.set(CHKSZ_CREDENTIAL_STORAGE_KEY, JSON.stringify({ key: 'legacy-without-prefix', remember: true }))

      const store = createChkszCredentialStore({ storage })

      expect(store.key()).toBeNull()
      expect(store.remember()).toBe(false)
      expect(values.has(CHKSZ_CREDENTIAL_STORAGE_KEY)).toBe(false)
      expect(storage.removeItem).toHaveBeenCalledWith(CHKSZ_CREDENTIAL_STORAGE_KEY)
    })
  })
})
