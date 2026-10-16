import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

export const PUBLIC_NOTICES = {
  '/legal/licence.txt': 'LICENSE',
  '/legal/runtime-dependencies.txt': 'docs/licenses/runtime-dependencies.txt',
  '/legal/opencc-js-MIT.txt': 'docs/licenses/opencc-js-MIT.txt',
  '/legal/opencc-js-THIRD-PARTY.txt': 'docs/licenses/opencc-js-THIRD-PARTY.txt',
  '/legal/notice.txt': 'NOTICE',
  '/legal/third-party-notices.txt': 'docs/THIRD_PARTY_NOTICES.md',
  '/legal/liquid-glass-notice.txt': 'src/features/liquid-glass/NOTICE.md',
} as const

// Plain-text static hosts do not consistently declare a charset. The UTF-8
// marker lets browsers decode the complete notice correctly, including offline.
const noticeText = (file: string) => `\uFEFF${readFileSync(file, 'utf8')}`

// Serve the canonical files without duplicating licence text in UI translations.
// Missing notices fail the build; repository visibility cannot hide them from users.
export function createPublicNoticesPlugin(): Plugin {
  return {
    name: 'public-legal-notices',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname
        const file = PUBLIC_NOTICES[pathname as keyof typeof PUBLIC_NOTICES]
        if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) return next()
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(request.method === 'HEAD' ? undefined : noticeText(file))
      })
    },
    generateBundle() {
      for (const [url, file] of Object.entries(PUBLIC_NOTICES)) {
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: noticeText(file) })
      }
    },
  }
}
