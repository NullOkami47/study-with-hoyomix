// Wave G preservation (task 26, Property 2; requirement 3.20). Observation-first: the cases come from
// the 8309e3a audit probe (zz-audit-8309e3a-chat-probe.spec.ts) and were observed passing on the
// unfixed tree (8c23f12). Wave G touches chat deletion, export and moderation, and none of that may
// change how hostile message text, display names, reply quotes or sticker IDs reach the DOM, or
// how the server-side protocol treats the U+001F reply marker.
import { flushPromises, mount } from '@vue/test-utils'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeReply, encodeReply, text } from '../../../workers/chat/protocol'
import { resetAccountSession, useAccountSession } from '../account/session'
import { usePreferences } from '../../stores/preferences'
import ChatPanel from './ChatPanel.vue'
import { createChatClient } from './client'

beforeEach(() => { resetAccountSession(); vi.spyOn(useAccountSession(), 'ensure').mockResolvedValue() })
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

const HOSTILE = [
  '<img src=x onerror="window.__waveGXss=1">',
  '<a href="javascript:window.__waveGXss=1">x</a>',
  '<svg onload="window.__waveGXss=1"></svg>',
  '<script>window.__waveGXss=1</script>',
  '<iframe src="javascript:window.__waveGXss=1"></iframe>',
  '<b onmouseover="window.__waveGXss=1">bold</b>',
]
/** The panel's own icons and sticker images are legitimate; only elements the payloads would create count. */
const INJECTED = 'img[src="x"], script, iframe, b, a[href^="javascript"], [onerror], [onload], [onmouseover]'

describe('Wave G: chat renders markup as text only (3.20)', () => {
  it('never turns message text, display names, reply quotes or sticker IDs into elements', async () => {
    usePreferences().setLocale('en')
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...HOSTILE), fc.constantFrom(...HOSTILE), fc.constantFrom(...HOSTILE),
      fc.stringMatching(/^[a-z ]{0,12}$/u),
      async (content, name, sticker, padding) => {
        window.localStorage.clear()
        document.body.innerHTML = ''
        const socket = { onmessage: null as ((event: MessageEvent) => void) | null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn(), readyState: 1 }
        const client = createChatClient({ socket: () => socket as never, request: async () => Response.json({ messages: [], nextCursor: null }) })
        const wrapper = mount(ChatPanel, { props: { client, tracks: [] }, attachTo: document.body })
        const message = (id: string, extra: Record<string, unknown> = {}) => ({
          id, userId: 'mallory', displayName: name, role: 'user', content: `${padding}${content}`,
          type: 'text', stickerId: null, trackId: null, location: null, replyToId: null,
          createdAt: new Date(Date.UTC(2026, 9, 24, 8, Number(id.slice(1)))).toISOString(), updatedAt: null, deletedAt: null, ...extra,
        })
        socket.onmessage?.call(socket as never, new MessageEvent('message', { data: JSON.stringify({
          type: 'snapshot', nextCursor: null, viewer: { userId: 'me', role: 'user' },
          messages: [message('m1'), message('m2', { replyToId: 'm1', content: 'reply' }), message('m3', { type: 'sticker', stickerId: sticker, content: '' })],
        }) }))
        await flushPromises()
        const log = wrapper.get('[data-chat-log]').element
        expect(log.querySelectorAll(INJECTED).length).toBe(0)
        expect(log.textContent).toContain(content)
        expect(log.textContent).toContain(name)
        expect((window as unknown as { __waveGXss?: number }).__waveGXss).toBeUndefined()
        wrapper.unmount()
        client.stop()
      },
    ), { numRuns: 12 })
  })
})

describe('Wave G: the reply marker stays out of user text and decodes losslessly (3.20)', () => {
  it('rejects any user text that carries U+001F', () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), fc.constantFrom('\u001f', '\u001freply:abc\u001f'), (before, after, mark) => {
      expect(() => text(`${before}${mark}${after}`)).toThrow()
    }), { numRuns: 200 })
  })

  it('round-trips a reply identifier and leaves unmarked content alone', () => {
    const replyId = fc.stringMatching(/^[a-zA-Z0-9_-]{1,64}$/u)
    const body = fc.string({ maxLength: 60 }).filter((value) => !value.includes('\u001f'))
    fc.assert(fc.property(replyId, body, (id, value) => {
      expect(decodeReply(encodeReply(id, value))).toEqual({ replyToId: id, text: value })
      expect(decodeReply(encodeReply(null, value))).toEqual({ replyToId: null, text: value })
    }), { numRuns: 200 })
  })
})
