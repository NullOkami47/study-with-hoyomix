import { ChatError, object } from "./protocol";
export const BODY_DEADLINE_MS = 5000;
export const BODY_LIMIT = 8192;
// Cancellation itself is untrusted: a stream's cancel hook need not settle.
export function cancelBody(body: ReadableStream<Uint8Array> | null) {
    if (body && !body.locked)
        void body.cancel().catch(() => { });
}
/** An absolute deadline, not a timeout reset by each attacker-controlled chunk. */
export async function readChatBody(request: Request) {
    const invalid = () => new ChatError("invalid_request");
    const length = request.headers.get("content-length");
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" ||
        (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > BODY_LIMIT)) ||
        !request.body) {
        cancelBody(request.body);
        throw invalid();
    }
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = true;
    const aborted = () => rejectAbort(invalid());
    let rejectAbort!: (reason: Error) => void;
    const stopped = new Promise<never>((_, reject) => {
        rejectAbort = reject;
        timer = setTimeout(() => reject(invalid()), BODY_DEADLINE_MS);
    });
    request.signal.addEventListener("abort", aborted, { once: true });
    try {
        if (request.signal.aborted)
            throw invalid();
        const bytes = new Uint8Array(BODY_LIMIT);
        let size = 0;
        while (true) {
            const { done, value } = await Promise.race([reader.read(), stopped]);
            if (done)
                break;
            size += value.byteLength;
            if (size > BODY_LIMIT)
                throw invalid();
            bytes.set(value, size - value.byteLength);
        }
        const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
        failed = false;
        return value;
    }
    catch {
        throw invalid();
    }
    finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", aborted);
        if (failed)
            void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
