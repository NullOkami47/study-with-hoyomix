export interface BufferMedia {
  readyState: number
  currentTime: number
  duration: number
  buffered: Pick<TimeRanges, 'length' | 'start' | 'end'>
}
/** Wait briefly for a manual switch without issuing another fetch or calling load(). */
export async function waitForBuffer(media: BufferMedia, seconds: number, isCurrent: () => boolean, timeoutMs = 600): Promise<boolean> {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 600
  const deadline = performance.now() + timeout
  while (isCurrent()) {
    if (inspectBuffer(media, seconds).ready) return true
    if (performance.now() >= deadline) break
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return false
}

export function inspectBuffer(media: BufferMedia | null, requiredSeconds = 2) {
  let bufferedSeconds = 0, totalBufferedSeconds = 0
  if (!media || !Number.isFinite(media.currentTime)) return { ready: false, bufferedSeconds, totalBufferedSeconds }
  const position = Math.max(0, media.currentTime)
  try {
    for (let i = 0; i < media.buffered.length; i++) {
      const start = media.buffered.start(i), end = media.buffered.end(i)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
      totalBufferedSeconds += end - start
      if (start <= position + .05 && end >= position) bufferedSeconds = Math.max(bufferedSeconds, end - position)
    }
  } catch { return { ready: false, bufferedSeconds: 0, totalBufferedSeconds: 0 } }
  const remaining = Number.isFinite(media.duration) && media.duration > position ? media.duration - position : Infinity
  const required = Math.min(Math.max(.1, requiredSeconds), remaining)
  return { ready: media.readyState >= 3 && bufferedSeconds + .05 >= required, bufferedSeconds, totalBufferedSeconds }
}
