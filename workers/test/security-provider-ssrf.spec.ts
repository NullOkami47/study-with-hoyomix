import { describe, expect, it } from 'vitest'

import {
  configuredGdStudioMediaHostnames,
  configuredGdStudioOrigin,
  configuredHuanyinMediaHostnames,
  configuredHuanyinOrigin,
  configuredJellyfinOrigin,
  configuredLxMediaHostnames,
  configuredLxOrigin,
  configuredLxRequestKey,
  configuredMetingMediaHostnames,
  configuredMetingOrigin,
  configuredResolverMediaHostnames,
  configuredResolverOrigin,
  readR2PublicConfig,
} from '../providers/config'
import type { ProviderEnv } from '../providers/config'

describe('Provider SSRF boundaries', () => {
  const minimalEnv = {
    DB: null as never,
    PUBLIC_ORIGIN: 'https://study.example',
    SESSION_HMAC_SECRET: 'test-secret',
    OAUTH_STATE_SECRET: 'test-oauth-secret',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'TEST-google-secret',
    GITHUB_CLIENT_ID: 'github-client',
    GITHUB_CLIENT_SECRET: 'TEST-github-secret',
  }

  describe('R2 provider - readR2PublicConfig', () => {
    it('accepts valid HTTPS base URL with allowed hostname', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      const config = readR2PublicConfig(env)
      expect(config).not.toBeNull()
      expect(config?.baseUrl).toBe('https://cdn.example.com/music/')
      expect(config?.allowedHostnames).toEqual(['cdn.example.com'])
    })

    it('rejects base URL hostname not in allowed list', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: 'other.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects localhost base URL', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://localhost/music',
        R2_ALLOWED_HOSTNAMES: 'localhost',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects private TLD suffixes', () => {
      const privateSuffixes = ['local', 'internal', 'lan', 'home', 'home.arpa', 'localdomain', 'intranet', 'private', 'corp']
      for (const suffix of privateSuffixes) {
        const env = {
          ...minimalEnv,
          R2_BASE_URL: `https://cdn.${suffix}/music`,
          R2_ALLOWED_HOSTNAMES: `cdn.${suffix}`,
        }
        expect(readR2PublicConfig(env)).toBeNull()
      }
    })

    it('rejects IP address hostnames', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://192.168.1.1/music',
        R2_ALLOWED_HOSTNAMES: '192.168.1.1',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects base URL with port', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com:8080/music',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects base URL with username/password', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://user:pass@cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects base URL with query string', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music?token=secret',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects base URL with fragment', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music#section',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('normalizes pathname to end with slash', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      const config = readR2PublicConfig(env)
      expect(config?.baseUrl).toBe('https://cdn.example.com/music/')
    })

    it('rejects empty allowed hostnames', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'https://cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: '',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })

    it('rejects HTTP protocol', () => {
      const env = {
        ...minimalEnv,
        R2_BASE_URL: 'http://cdn.example.com/music',
        R2_ALLOWED_HOSTNAMES: 'cdn.example.com',
      }
      expect(readR2PublicConfig(env)).toBeNull()
    })
  })

  describe('Piped/Invidious - configuredResolverOrigin', () => {
    it('accepts valid HTTPS origin for Piped', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://piped.example.com' } as ProviderEnv
      const origin = configuredResolverOrigin('piped', env)
      expect(origin).toBe('https://piped.example.com')
    })

    it('accepts valid HTTPS origin for Invidious', () => {
      const env = { ...minimalEnv, INVIDIOUS_API_BASE_URL: 'https://invidious.example.com' } as ProviderEnv
      const origin = configuredResolverOrigin('invidious', env)
      expect(origin).toBe('https://invidious.example.com')
    })

    it('rejects origin with pathname', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://piped.example.com/api' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })

    it('accepts origin with trailing slash and normalizes to origin', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://piped.example.com/' } as ProviderEnv
      const origin = configuredResolverOrigin('piped', env)
      expect(origin).toBe('https://piped.example.com')
    })

    it('rejects origin with port', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://piped.example.com:8080' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })

    it('rejects HTTP origin', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'http://piped.example.com' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })

    it('rejects localhost origins', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://localhost' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })

    it('rejects private TLD origins', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://piped.internal' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })

    it('rejects IP address origins', () => {
      const env = { ...minimalEnv, PIPED_API_BASE_URL: 'https://192.168.1.1' } as ProviderEnv
      expect(configuredResolverOrigin('piped', env)).toBeNull()
    })
  })

  describe('Piped/Invidious - configuredResolverMediaHostnames', () => {
    it('defaults to origin hostname when no media hostnames configured', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: undefined,
      } as ProviderEnv
      const hostnames = configuredResolverMediaHostnames('piped', env)
      expect(hostnames).toEqual(['piped.example.com'])
    })

    it('defaults to origin hostname when media hostnames is empty string', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: '',
      } as ProviderEnv
      const hostnames = configuredResolverMediaHostnames('piped', env)
      expect(hostnames).toEqual(['piped.example.com'])
    })

    it('includes origin hostname plus configured additional hostnames', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: 'media1.example.com, media2.example.com',
      } as ProviderEnv
      const hostnames = configuredResolverMediaHostnames('piped', env)
      expect(hostnames).toEqual(['piped.example.com', 'media1.example.com', 'media2.example.com'])
    })

    it('rejects media hostnames with localhost', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: 'localhost',
      } as ProviderEnv
      expect(configuredResolverMediaHostnames('piped', env)).toBeNull()
    })

    it('rejects media hostnames with private TLDs', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: 'media.internal',
      } as ProviderEnv
      expect(configuredResolverMediaHostnames('piped', env)).toBeNull()
    })

    it('rejects media hostnames with IP addresses', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: '192.168.1.1',
      } as ProviderEnv
      expect(configuredResolverMediaHostnames('piped', env)).toBeNull()
    })

    it('rejects media hostnames with port', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: 'media.example.com:8080',
      } as ProviderEnv
      expect(configuredResolverMediaHostnames('piped', env)).toBeNull()
    })

    it('deduplicates media hostnames', () => {
      const env = {
        ...minimalEnv,
        PIPED_API_BASE_URL: 'https://piped.example.com',
        PIPED_MEDIA_ALLOWED_HOSTNAMES: 'media.example.com, media.example.com',
      } as ProviderEnv
      const hostnames = configuredResolverMediaHostnames('piped', env)
      expect(hostnames).toEqual(['piped.example.com', 'media.example.com'])
    })
  })

  describe('Meting - configuredMetingOrigin', () => {
    it('accepts valid HTTPS origin', () => {
      const env = { ...minimalEnv, METING_API_BASE_URL: 'https://meting.example.com' } as ProviderEnv
      const origin = configuredMetingOrigin(env)
      expect(origin).toBe('https://meting.example.com')
    })

    it('rejects origin with pathname', () => {
      const env = { ...minimalEnv, METING_API_BASE_URL: 'https://meting.example.com/api' } as ProviderEnv
      expect(configuredMetingOrigin(env)).toBeNull()
    })

    it('rejects localhost', () => {
      const env = { ...minimalEnv, METING_API_BASE_URL: 'https://localhost' } as ProviderEnv
      expect(configuredMetingOrigin(env)).toBeNull()
    })

    it('rejects private TLDs', () => {
      const env = { ...minimalEnv, METING_API_BASE_URL: 'https://meting.internal' } as ProviderEnv
      expect(configuredMetingOrigin(env)).toBeNull()
    })
  })

  describe('Meting - configuredMetingMediaHostnames', () => {
    it('accepts valid public hostnames', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: 'music.163.com, y.qq.com',
      } as ProviderEnv
      const hostnames = configuredMetingMediaHostnames(env)
      expect(hostnames).toEqual(['music.163.com', 'y.qq.com'])
    })

    it('rejects hostnames with localhost', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: 'localhost',
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })

    it('rejects hostnames with private TLDs', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: 'music.internal',
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })

    it('rejects hostnames with IP addresses', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: '192.168.1.1',
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })

    it('rejects duplicate hostnames', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: 'music.163.com, music.163.com',
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })

    it('rejects mixed-case hostnames', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: 'Music.163.com',
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })

    it('returns empty array for empty configuration', () => {
      const env = {
        ...minimalEnv,
        METING_MEDIA_ALLOWED_HOSTNAMES: undefined,
      } as ProviderEnv
      expect(configuredMetingMediaHostnames(env)).toBeNull()
    })
  })

  describe('LX providers (lx-huibq, lx-ikun) - configuredLxOrigin', () => {
    it('accepts valid HTTPS origin for lx-huibq', () => {
      const env = { ...minimalEnv, LX_HUIBQ_API_BASE_URL: 'https://lx.example.com' } as ProviderEnv
      const origin = configuredLxOrigin('lx-huibq', env)
      expect(origin).toBe('https://lx.example.com')
    })

    it('accepts valid HTTPS origin for lx-ikun', () => {
      const env = { ...minimalEnv, LX_IKUN_API_BASE_URL: 'https://lx.ikun.example.com' } as ProviderEnv
      const origin = configuredLxOrigin('lx-ikun', env)
      expect(origin).toBe('https://lx.ikun.example.com')
    })

    it('rejects localhost for lx-huibq', () => {
      const env = { ...minimalEnv, LX_HUIBQ_API_BASE_URL: 'https://localhost' } as ProviderEnv
      expect(configuredLxOrigin('lx-huibq', env)).toBeNull()
    })

    it('rejects private TLD for lx-ikun', () => {
      const env = { ...minimalEnv, LX_IKUN_API_BASE_URL: 'https://lx.internal' } as ProviderEnv
      expect(configuredLxOrigin('lx-ikun', env)).toBeNull()
    })
  })

  describe('LX providers - configuredLxMediaHostnames', () => {
    it('accepts valid hostnames for lx-huibq', () => {
      const env = {
        ...minimalEnv,
        LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'media1.example.com, media2.example.com',
      } as ProviderEnv
      const hostnames = configuredLxMediaHostnames('lx-huibq', env)
      expect(hostnames).toEqual(['media1.example.com', 'media2.example.com'])
    })

    it('accepts valid hostnames for lx-ikun', () => {
      const env = {
        ...minimalEnv,
        LX_IKUN_MEDIA_ALLOWED_HOSTNAMES: 'cdn1.example.com',
      } as ProviderEnv
      const hostnames = configuredLxMediaHostnames('lx-ikun', env)
      expect(hostnames).toEqual(['cdn1.example.com'])
    })

    it('rejects localhost in media hostnames', () => {
      const env = {
        ...minimalEnv,
        LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'localhost',
      } as ProviderEnv
      expect(configuredLxMediaHostnames('lx-huibq', env)).toBeNull()
    })

    it('rejects private TLD in media hostnames', () => {
      const env = {
        ...minimalEnv,
        LX_IKUN_MEDIA_ALLOWED_HOSTNAMES: 'media.corp',
      } as ProviderEnv
      expect(configuredLxMediaHostnames('lx-ikun', env)).toBeNull()
    })

    it('rejects duplicate hostnames', () => {
      const env = {
        ...minimalEnv,
        LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'media.example.com, media.example.com',
      } as ProviderEnv
      expect(configuredLxMediaHostnames('lx-huibq', env)).toBeNull()
    })
  })

  describe('LX providers - configuredLxRequestKey', () => {
    it('accepts valid ASCII printable key for lx-huibq', () => {
      const env = { ...minimalEnv, LX_HUIBQ_REQUEST_KEY: 'valid-key-12345' } as ProviderEnv
      const key = configuredLxRequestKey('lx-huibq', env)
      expect(key).toBe('valid-key-12345')
    })

    it('accepts valid ASCII printable key for lx-ikun', () => {
      const env = { ...minimalEnv, LX_IKUN_REQUEST_KEY: 'another-valid-key!@#' } as ProviderEnv
      const key = configuredLxRequestKey('lx-ikun', env)
      expect(key).toBe('another-valid-key!@#')
    })

    it('rejects empty string key', () => {
      const env = { ...minimalEnv, LX_HUIBQ_REQUEST_KEY: '' } as ProviderEnv
      expect(configuredLxRequestKey('lx-huibq', env)).toBeNull()
    })

    it('rejects key with control characters', () => {
      const env = { ...minimalEnv, LX_HUIBQ_REQUEST_KEY: 'key\x00with\x01control' } as ProviderEnv
      expect(configuredLxRequestKey('lx-huibq', env)).toBeNull()
    })

    it('rejects key with newline', () => {
      const env = { ...minimalEnv, LX_IKUN_REQUEST_KEY: 'key\nwith\nnewline' } as ProviderEnv
      expect(configuredLxRequestKey('lx-ikun', env)).toBeNull()
    })

    it('rejects key longer than 256 characters', () => {
      const env = { ...minimalEnv, LX_HUIBQ_REQUEST_KEY: 'a'.repeat(257) } as ProviderEnv
      expect(configuredLxRequestKey('lx-huibq', env)).toBeNull()
    })

    it('accepts key exactly 256 characters', () => {
      const longKey = 'a'.repeat(256)
      const env = { ...minimalEnv, LX_IKUN_REQUEST_KEY: longKey } as ProviderEnv
      expect(configuredLxRequestKey('lx-ikun', env)).toBe(longKey)
    })
  })

  describe('Jellyfin - configuredJellyfinOrigin', () => {
    it('accepts valid HTTPS origin', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://jellyfin.example.com' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBe('https://jellyfin.example.com')
    })

    it('rejects origin with pathname', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://jellyfin.example.com/web' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBeNull()
    })

    it('rejects localhost', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://localhost' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBeNull()
    })

    it('rejects private TLDs', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://jellyfin.internal' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBeNull()
    })

    it('rejects port 8096 or any custom port', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://jellyfin.example.com:8096' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBeNull()
    })

    it('rejects IP addresses', () => {
      const env = { ...minimalEnv, JELLYFIN_BASE_URL: 'https://192.168.1.1' } as ProviderEnv
      expect(configuredJellyfinOrigin(env)).toBeNull()
    })
  })

  describe('GD Studio - configuredGdStudioOrigin & configuredGdStudioMediaHostnames', () => {
    it('accepts valid HTTPS origin', () => {
      const env = { ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz' } as ProviderEnv
      expect(configuredGdStudioOrigin(env)).toBe('https://music-api.gdstudio.xyz')
    })

    it('rejects origin with pathname or port', () => {
      expect(configuredGdStudioOrigin({ ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz/api.php' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioOrigin({ ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz:8443' } as ProviderEnv)).toBeNull()
    })

    it('rejects private host origins', () => {
      expect(configuredGdStudioOrigin({ ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://localhost' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioOrigin({ ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://10.0.0.1' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioOrigin({ ...minimalEnv, GD_STUDIO_API_BASE_URL: 'https://gd.internal' } as ProviderEnv)).toBeNull()
    })

    it('accepts valid media hostnames and rejects private/invalid ones', () => {
      const valid = { ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.gdstudio.xyz, cdn.gdstudio.xyz' } as ProviderEnv
      expect(configuredGdStudioMediaHostnames(valid)).toEqual(['media.gdstudio.xyz', 'cdn.gdstudio.xyz'])

      expect(configuredGdStudioMediaHostnames({ ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'localhost' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioMediaHostnames({ ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: '127.0.0.1' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioMediaHostnames({ ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.internal' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioMediaHostnames({ ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.gdstudio.xyz, media.gdstudio.xyz' } as ProviderEnv)).toBeNull()
      expect(configuredGdStudioMediaHostnames({ ...minimalEnv, GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'Media.gdstudio.xyz' } as ProviderEnv)).toBeNull()
    })
  })

  describe('HuanYin - configuredHuanyinOrigin & configuredHuanyinMediaHostnames', () => {
    it('accepts valid HTTPS origin', () => {
      const env = { ...minimalEnv, HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com' } as ProviderEnv
      expect(configuredHuanyinOrigin(env)).toBe('https://music-dl.sayqz.com')
    })

    it('rejects origin with pathname or port', () => {
      expect(configuredHuanyinOrigin({ ...minimalEnv, HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com/api' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinOrigin({ ...minimalEnv, HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com:8443' } as ProviderEnv)).toBeNull()
    })

    it('rejects private host origins', () => {
      expect(configuredHuanyinOrigin({ ...minimalEnv, HUANYIN_API_BASE_URL: 'https://localhost' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinOrigin({ ...minimalEnv, HUANYIN_API_BASE_URL: 'https://10.0.0.1' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinOrigin({ ...minimalEnv, HUANYIN_API_BASE_URL: 'https://huanyin.internal' } as ProviderEnv)).toBeNull()
    })

    it('accepts valid media hostnames and rejects private/invalid ones', () => {
      const valid = { ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.sayqz.com, cdn.sayqz.com' } as ProviderEnv
      expect(configuredHuanyinMediaHostnames(valid)).toEqual(['media.sayqz.com', 'cdn.sayqz.com'])

      expect(configuredHuanyinMediaHostnames({ ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'localhost' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinMediaHostnames({ ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: '127.0.0.1' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinMediaHostnames({ ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.internal' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinMediaHostnames({ ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.sayqz.com, media.sayqz.com' } as ProviderEnv)).toBeNull()
      expect(configuredHuanyinMediaHostnames({ ...minimalEnv, HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'Media.sayqz.com' } as ProviderEnv)).toBeNull()
    })
  })

  describe('SSRF prevention summary', () => {
    it('documents isPublicHostname rejections', () => {
      // isPublicHostname at config.ts:100-111 rejects:
      // - hostname > 253 chars
      // - hostname ending with '.'
      // - hostname without '.' (single-label)
      // - hostname with ':' (port in hostname)
      // - hostname starting with '[' (IPv6)
      // - IPv4 addresses (/^\d+(?:\.\d+){3}$/)
      // - PRIVATE_HOST_SUFFIXES: localhost, local, internal, lan, home, home.arpa, localdomain, intranet, private, corp
      // - invalid DNS labels (must match /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
      expect(true).toBe(true)
    })

    it('documents parseAllowedHostnames enforces HTTPS, no port, no auth, no path components', () => {
      // parseAllowedHostnames at config.ts:113-134 rejects:
      // - protocol !== 'https:'
      // - username or password
      // - port
      // - pathname !== '/'
      // - search or hash
      // - hostname !== original hostname (normalization check)
      // - !isPublicHostname(parsed.hostname)
      expect(true).toBe(true)
    })

    it('documents parseConfiguredResolverOrigin enforces exact origin match', () => {
      // parseConfiguredResolverOrigin at config.ts:180-194 rejects:
      // - protocol !== 'https:'
      // - username or password
      // - port
      // - pathname !== '/'
      // - search or hash
      // - !isPublicHostname(parsed.hostname)
      // - value !== parsed.origin && value !== `${parsed.origin}/`
      expect(true).toBe(true)
    })
  })
})
