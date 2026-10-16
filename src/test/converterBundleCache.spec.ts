// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheChineseTitleConverter } from '../../vite.config'
beforeEach(() => vi.stubGlobal('self', { location: { origin: 'https://study.example.invalid' } }))
afterEach(() => vi.unstubAllGlobals())
const match = (path: string, method = 'GET', origin = 'https://study.example.invalid') =>
  cacheChineseTitleConverter({ request: new Request(origin + path, { method }), url: new URL(origin + path) })
describe('built converter dictionary cache', () => {
  it.each(['1234abcd', 'Cch70dw0', 'Ab-_01xy'])('recognises an emitted eight-character Vite hash %s', hash => {
    expect(match(`/assets/chinese-title-converter-${hash}.js`)).toBe(true)
  })
  it('rejects foreign origins, writes and unrelated asset paths', () => {
    expect(match('/assets/chinese-title-converter-Cch70dw0.js', 'GET', 'https://foreign.example.invalid')).toBe(false)
    expect(match('/assets/chinese-title-converter-Cch70dw0.js', 'POST')).toBe(false)
    for (const path of ['/assets/other-Cch70dw0.js', '/assets/chinese-title-converter-short.js', '/other/chinese-title-converter-Cch70dw0.js']) expect(match(path)).toBe(false)
  })
})
