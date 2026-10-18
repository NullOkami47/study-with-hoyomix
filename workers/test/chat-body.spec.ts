import { describe, it, expect, vi, afterEach } from 'vitest';
import { BODY_DEADLINE_MS, readChatBody } from '../chat/requestBody';
afterEach(() => { vi.useRealTimers(); });
function input(bytes?: Uint8Array, end = false, cancel = () => { }) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; if (bytes)
            c.enqueue(bytes); if (end)
            c.close(); }, cancel });
    const request = new Request('https://chat.internal/api/chat/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    return { request, controller };
}
describe('Chat body absolute deadline and stream ownership', () => {
    it('never-EOF times out, cancels and releases even when cancellation never settles', async () => {
        vi.useFakeTimers();
        let cancelled = false;
        const { request } = input(new TextEncoder().encode('{'), false, () => { cancelled = true; return new Promise<void>(() => { }); });
        const result = readChatBody(request).catch(e => e.code);
        await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS);
        expect(await result).toBe('invalid_request');
        expect(cancelled).toBe(true);
        expect(request.body!.locked).toBe(false);
    });
    it('slow chunks cannot extend the absolute deadline', async () => {
        vi.useFakeTimers();
        const { request, controller } = input(new TextEncoder().encode('{'));
        const result = readChatBody(request).catch(e => e.code);
        await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS - 1);
        controller.enqueue(new TextEncoder().encode(' '));
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toBe('invalid_request');
    });
    it.each(['{', '[]', 'null', '{"a":'])('rejects malformed/non-object JSON %s', async (value) => {
        const { request } = input(new TextEncoder().encode(value), true);
        await expect(readChatBody(request)).rejects.toMatchObject({ code: 'invalid_request' });
        expect(request.body!.locked).toBe(false);
    });
    it('preserves exactly 8192 bytes and rejects/cancels oversized input', async () => {
        const encoded = new TextEncoder().encode(JSON.stringify({ x: 'x'.repeat(8184) }));
        expect(encoded.length).toBe(8192);
        expect(await readChatBody(input(encoded, true).request)).toHaveProperty('x');
        let cancelled = false;
        await expect(readChatBody(input(new Uint8Array(8193), false, () => { cancelled = true; }).request)).rejects.toMatchObject({ code: 'invalid_request' });
        expect(cancelled).toBe(true);
    });
    it('handles interrupted streams', async () => {
        const { request, controller } = input();
        const result = readChatBody(request);
        controller.error(new Error('interrupted'));
        await expect(result).rejects.toMatchObject({ code: 'invalid_request' });
        expect(request.body!.locked).toBe(false);
    });
    it('handles request abortion', async () => {
        const signal = new AbortController();
        const stream = input();
        const request = new Request(stream.request, { signal: signal.signal, duplex: 'half' } as RequestInit);
        const result = readChatBody(request);
        signal.abort();
        await expect(result).rejects.toMatchObject({ code: 'invalid_request' });
        expect(request.body!.locked).toBe(false);
    });
});
it('rejects bad MIME, length declarations, and oversized multi-byte text', async () => {
    for (const headers of ([{ 'content-type': 'text/plain' }, { 'content-type': 'application/json', 'content-length': '8193' }, { 'content-type': 'application/json', 'content-length': 'no' }] as Record<string,string>[])) {
        const request = new Request('https://chat.internal', { method: 'POST', headers, body: '{}' });
        await expect(readChatBody(request)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(readChatBody(input(new TextEncoder().encode(JSON.stringify({ text: '中'.repeat(3000) })), true).request)).rejects.toMatchObject({ code: 'invalid_request' });
});
it('forwards caller cancellation through the real origin/identity router', async () => {
    const { chatRoute } = await import('../chat/routes');
    const abort = new AbortController();
    let cancelled = false;
    const request = new Request('https://study.example/api/chat/messages', {
        method: 'POST', headers: { origin: 'https://study.example', 'content-type': 'application/json' }, signal: abort.signal,
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }), duplex: 'half',
    } as RequestInit);
    const result = chatRoute(request, { PUBLIC_ORIGIN: 'https://study.example', CHAT: { idFromName: () => '', get: () => ({ fetch: async (internal: Request) => {
                    try {
                        await readChatBody(internal);
                        return new Response(null, { status: 200 });
                    }
                    catch {
                        return new Response(null, { status: 400 });
                    }
                } }) } } as never);
    await Promise.resolve();
    abort.abort();
    expect((await result).status).toBe(400);
    expect(cancelled).toBe(true);
});
it('rejects cross-origin retention status and recovery before reaching the coordinator', async () => {
    const { chatRoute } = await import('../chat/routes');
    let forwarded = 0;
    const env = { PUBLIC_ORIGIN: 'https://study.example', CHAT: { idFromName: () => '', get: () => ({ fetch: async () => {
        forwarded++;
        return new Response(null, { status: 200 });
    } }) } } as never;
    for (const method of ['GET', 'POST']) {
        const response = await chatRoute(new Request('https://study.example/api/chat/moderation/retention', {
            method, headers: { origin: 'https://other.example', 'x-chat-identity': '{"role":"owner"}' },
        }), env);
        expect(response.status).toBe(403);
    }
    expect(forwarded).toBe(0);
});
